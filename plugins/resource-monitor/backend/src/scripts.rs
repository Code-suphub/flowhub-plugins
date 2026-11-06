//! Bounded, session-local observations of system scripting tools. These records
//! are display evidence, never authorization events or action target scopes.
use crate::model::{self, Group, Identity, Process, SourceOrigin};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const LIMIT: usize = 64;
const RETAIN_MS: u64 = 30 * 60 * 1000;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    #[serde(flatten)]
    pub identity: Identity,
    pub name: String,
    pub app_path: Option<String>,
}
impl Node {
    fn from(process: &Process) -> Self {
        Self {identity:process.identity.clone(),name:process.name.clone(),
            app_path:model::process_bundle(process).and_then(|(key,_)|key.strip_prefix("app:").map(String::from))}
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub process: Node,
    pub chain: Vec<Node>,
    pub responsible: Option<Node>,
    pub source: Option<SourceOrigin>,
    pub chain_note: String,
    pub first_seen: u64,
    pub last_seen: u64,
    pub running: bool,
}
#[derive(Default)]
pub struct History {records:Vec<Record>}
impl History {
    pub fn observe(&mut self, groups:&[Group], at:u64,
        parent_matches:impl Fn(&Identity,&Identity)->bool,
        responsibility:impl Fn(&Identity)->Option<Identity>,
        valid:impl Fn(&Identity)->bool) -> Vec<Record> {
        let by:HashMap<_,_>=groups.iter().flat_map(|g|&g.processes).map(|p|(p.identity.pid,p)).collect();
        let mut candidates:Vec<_>=by.values().copied().filter(|p|matches!(p.identity.executable.as_str(),"/usr/bin/osascript"|"/usr/bin/automator")).collect();
        candidates.sort_by_key(|p|(p.identity.started,p.identity.pid));
        for record in &mut self.records {record.running=false;}
        for process in candidates.into_iter().rev().take(LIMIT) {
            if !valid(&process.identity) {continue;}
            let mut current=process;
            let mut chain=vec![Node::from(current)];
            let mut visited=HashSet::from([current.identity.pid]);
            let mut note=String::new();
            while chain.len()<16 && chain.last().is_some_and(|node|node.app_path.is_none()) {
                if current.ppid<=1 {note="父链到达 launchd；更早的启动来源不可追溯。".into();break;}
                let Some(parent)=by.get(&current.ppid).copied() else {note="部分父进程未采集到，启动链不完整。".into();break;};
                if parent.identity.uid!=process.identity.uid || parent.identity.started==0 || parent.identity.started>current.identity.started
                    || !visited.insert(parent.identity.pid) || !parent_matches(&current.identity,&parent.identity) {
                    note="父进程身份或用户边界无法核验，已停止追溯。".into();break;
                }
                chain.push(Node::from(parent));current=parent;
            }
            if chain.len()==16 && chain.last().is_some_and(|n|n.app_path.is_none()) {note="启动链已达到 16 层展示上限。".into();}
            let responsible=responsibility(&process.identity).and_then(|id|by.get(&id.pid).copied().filter(|p|p.identity==id&&valid(&id))).map(Node::from);
            let parent_source=chain.iter().find(|node|node.app_path.is_some());
            let responsible_source=responsible.as_ref().filter(|node|node.app_path.is_some());
            let conflict=parent_source.zip(responsible_source).is_some_and(|(a,b)|a.app_path!=b.app_path);
            let source=if conflict {note="父链与系统责任归属指向不同应用，来源未确认。".into();None}
                else {parent_source.or(responsible_source).map(|node|SourceOrigin {
                    name:node.app_path.as_deref().and_then(|p|p.rsplit('/').next()).unwrap_or(&node.name).trim_end_matches(".app").into(),
                    app_path:node.app_path.clone(),evidence:if parent_source.is_some(){"已核验当前父进程链"}else{"系统责任归属，独立于父进程链"}.into()})};
            chain.reverse();
            let id=format!("script-{:x}",Sha256::digest(serde_json::to_vec(&process.identity).unwrap()));
            let first_seen=self.records.iter().find(|record|record.id==id).map(|r|r.first_seen).unwrap_or(at);
            let record=Record {id:id.clone(),process:Node::from(process),chain,responsible,source,chain_note:note,first_seen,last_seen:at,running:true};
            if let Some(previous)=self.records.iter_mut().find(|r|r.id==id) {
                // Preserve known launch evidence when a running tool is reparented.
                if record.source.is_none() && !conflict && previous.source.is_some() {
                    previous.running=true;previous.last_seen=at;
                    previous.chain_note="保留此前采样时的启动链；当前父链已不完整。".into();
                } else {*previous=record;}
            } else {self.records.push(record);}
        }
        self.records.retain(|r|r.running||at.saturating_sub(r.last_seen)<=RETAIN_MS);
        self.records.sort_by(|a,b|b.running.cmp(&a.running).then(b.last_seen.cmp(&a.last_seen)).then(b.process.identity.started.cmp(&a.process.identity.started)).then(a.id.cmp(&b.id)));
        self.records.truncate(LIMIT);
        self.records.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn process(pid:i32,parent:i32,path:&str)->Process {
        serde_json::from_value(json!({"pid":pid,"ppid":parent,"started":1000+pid,"uid":501,"executable":path,"name":path.rsplit('/').next().unwrap(),
            "memory":1,"footprint":1,"cpu":0,"cwd":"","role":"","avd":"","protected":false,"protection":"","parentName":"","groupId":"","attribution":""})).unwrap()
    }
    fn groups(processes:Vec<Process>)->Vec<Group> {model::group_processes(processes,501)}
    #[test]
    fn verified_chains_and_session_history_do_not_change_group_or_action_membership() {
        let mut history=History::default();
        let groups=groups(vec![process(10,1,"/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),process(20,10,"/bin/zsh"),process(30,20,"/usr/bin/osascript")]);
        let before=serde_json::to_value(&groups).unwrap();
        let records=history.observe(&groups,1000,|_,_|true,|_|None,|_|true);
        assert_eq!(records[0].source.as_ref().unwrap().name,"ChatGPT");
        assert_eq!(records[0].chain.iter().map(|n|n.identity.pid).collect::<Vec<_>>(),vec![10,20,30]);
        assert_eq!(serde_json::to_value(&groups).unwrap(),before);
        let records=history.observe(&[],2000,|_,_|true,|_|None,|_|true);
        assert!(!records[0].running);assert_eq!(records[0].last_seen,1000);
        assert!(history.observe(&[],RETAIN_MS+2000,|_,_|true,|_|None,|_|true).is_empty());
    }
    #[test]
    fn reused_pids_invalid_parent_links_and_unrelated_app_hints_do_not_become_sources() {
        let mut history=History::default();
        let mut script=process(30,10,"/usr/bin/osascript");
        let mut app=process(10,1,"/Applications/App.app/Contents/MacOS/App");
        app.identity.started=9999;
        let records=history.observe(&groups(vec![app,script.clone()]),1,|_,_|true,|_|None,|_|true);
        assert!(records[0].source.is_none());assert_eq!(records[0].chain.len(),1);
        script.identity.started+=10000;
        let records=history.observe(&groups(vec![script]),2,|_,_|false,|_|None,|_|true);
        assert_eq!(records.len(),2);assert_ne!(records[0].id,records[1].id);
    }
    #[test]
    fn conflicting_responsibility_is_explicitly_unknown_and_history_is_bounded() {
        let mut history=History::default();
        let other=process(11,1,"/Applications/Other.app/Contents/MacOS/Other");
        let groups=groups(vec![process(10,1,"/Applications/App.app/Contents/MacOS/App"),other.clone(),process(30,10,"/usr/bin/osascript")]);
        let records=history.observe(&groups,1,|_,_|true,|_|Some(other.identity.clone()),|_|true);
        assert!(records[0].source.is_none());assert!(records[0].chain_note.contains("不同应用"));
        let records=history.observe(&super::tests::groups((100..300).map(|pid|process(pid,1,"/usr/bin/osascript")).collect()),2,|_,_|true,|_|None,|_|true);
        assert_eq!(records.len(),LIMIT);
    }
}
