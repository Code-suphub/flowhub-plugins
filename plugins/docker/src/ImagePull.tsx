import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Button,DialogShell,Field,Input,Select} from '@flowhub/plugin-common/react';
import type {ManagementApi} from './api';
export interface PullJob {id:string;context:string;reference:string;platform:string;state:'running'|'succeeded'|'failed'|'cancelled';layers:{id:string;status:string}[];error:string|null;imageId:string|null}
const message=(reason:unknown)=>reason instanceof Error?reason.message:'任务读取失败，请重试';
export function ImagePull({api,context,visible,disabled,onComplete}:{api:ManagementApi;context:string;visible:boolean;disabled:boolean;onComplete():Promise<void>}){
  const [open,setOpen]=useState(false),[reference,setReference]=useState(''),[platform,setPlatform]=useState(''),[job,setJob]=useState<PullJob|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),pending=useRef(false),alive=useRef(true),epoch=useRef(0),composing=useRef(false),imeEnded=useRef(-Infinity),completed=useRef(''),complete=useRef(onComplete);
  complete.current=onComplete;
  useEffect(()=>()=>{alive.current=false;epoch.current++;},[]);
  function accept(next:PullJob|null){setJob(next);if(next?.state==='succeeded' && completed.current!==next.id){completed.current=next.id;void complete.current();}}
  useEffect(()=>{
    const revision=++epoch.current;setOpen(false);setJob(null);setReference('');setPlatform('');setError('');setBusy(false);pending.current=false;
    if(!context || api.preview)return;
    void api.invoke<{job:PullJob|null}>('image_pull_status',{context}).then(result=>{if(alive.current && epoch.current===revision)accept(result.job);}).catch(()=>{});
  },[api,context]);
  useEffect(()=>{
    if(job?.state!=='running')return;
    let stopped=false,timer:ReturnType<typeof setTimeout>;const revision=epoch.current;
    async function poll(){
      try{const result=await api.invoke<{job:PullJob|null}>('image_pull_status',{context:job!.context,id:job!.id});if(!stopped && revision===epoch.current){accept(result.job);setError('');}}
      catch(reason){if(!stopped && revision===epoch.current)setError(message(reason));}
      finally{if(!stopped)timer=setTimeout(()=>void poll(),1000);}
    }
    timer=setTimeout(()=>void poll(),500);return()=>{stopped=true;clearTimeout(timer);};
  },[api,job?.id,job?.state]);
  async function submit(event:FormEvent){
    event.preventDefault();if(pending.current || disabled || api.preview || job?.state==='running' || composing.current || performance.now()-imeEnded.current<80)return;
    if(!reference.trim()){setError('请填写镜像名称与明确的标签或摘要');return;}
    pending.current=true;setBusy(true);setError('');const revision=++epoch.current;
    try{const result=await api.invoke<{job:PullJob}>('image_pull_start',{context,reference:reference.trim(),platform,confirmed:true});if(alive.current && epoch.current===revision)accept(result.job);}
    catch(reason){if(alive.current && epoch.current===revision)setError(message(reason));}
    finally{if(alive.current && epoch.current===revision){pending.current=false;setBusy(false);}}
  }
  async function cancel(){
    if(pending.current || !job || job.state!=='running' || api.preview)return;
    pending.current=true;setBusy(true);setError('');const revision=epoch.current;
    try{const result=await api.invoke<{job:PullJob}>('image_pull_cancel',{context:job.context,id:job.id,confirmed:true});if(alive.current && epoch.current===revision)accept(result.job);}
    catch(reason){if(alive.current && epoch.current===revision)setError(message(reason));}
    finally{if(alive.current && epoch.current===revision){pending.current=false;setBusy(false);}}
  }
  function close(){if(!pending.current)setOpen(false);}
  function show(){
    setError('');setOpen(true);if(pending.current || api.preview)return;
    const revision=epoch.current;
    void api.invoke<{job:PullJob|null}>('image_pull_status',{context}).then(result=>{if(alive.current && epoch.current===revision && !pending.current){accept(result.job);if(result.job){setReference(result.job.reference);setPlatform(result.job.platform);}}}).catch(reason=>{if(alive.current && epoch.current===revision)setError(message(reason));});
  }
  const running=job?.state==='running';
  return <>{visible?<Button variant="primary" disabled={api.preview || !context || disabled && !job} onClick={show}>{running?'查看拉取任务':'＋ 拉取镜像'}</Button>:null}
    {open?<DialogShell open title="拉取镜像" description={context} initialFocusRef={input} className="docker-pull-dialog" contentClassName="docker-confirm-content" onOpenChange={value=>{if(!value)close();}} onCancel={event=>{if(pending.current || composing.current || performance.now()-imeEnded.current<80)event.preventDefault();}}
      footer={<><Button disabled={busy} onClick={close}>{running?'后台继续':'关闭'}</Button>{running?<Button variant="danger" disabled={busy} onClick={()=>void cancel()}>停止请求</Button>:<Button variant="primary" type="submit" form="docker-pull-form" disabled={busy || disabled || api.preview}>{busy?'提交中…':job?'再次拉取':'确认拉取'}</Button>}</>}>
      <form id="docker-pull-form" className="grid gap-4" onSubmit={submit} onCompositionStartCapture={()=>{composing.current=true;}} onCompositionEndCapture={()=>{composing.current=false;imeEnded.current=performance.now();}} onKeyDownCapture={event=>{if(event.key==='Enter' && event.repeat)event.preventDefault();if(event.nativeEvent.isComposing || event.nativeEvent.keyCode===229){imeEnded.current=performance.now();event.stopPropagation();}}}>
        <Field label="镜像名称与标签 / 摘要" htmlFor="docker-pull-reference"><Input ref={input} id="docker-pull-reference" placeholder="例如 nginx:stable 或 ghcr.io/team/app:v1" maxLength={255} autoComplete="off" spellCheck={false} disabled={busy || running} value={reference} onChange={event=>setReference(event.target.value)}/></Field>
        <Field label="镜像平台" htmlFor="docker-pull-platform"><Select id="docker-pull-platform" value={platform} disabled={busy || running} onChange={setPlatform} options={[{value:'',label:'跟随当前引擎'},{value:'linux/arm64',label:'Linux ARM64'},{value:'linux/amd64',label:'Linux AMD64'},{value:'linux/arm/v7',label:'Linux ARM v7'}]}/></Field>
        <p className="docker-muted">拉取会下载镜像，并可能更新已有的同名标签；不会启动或重建容器。私有仓库沿用本机 Docker 登录，不在此填写凭据。</p>
        {job?<section className="docker-pull-progress" aria-label="镜像拉取任务"><strong role="status">{({running:'正在拉取',succeeded:'拉取完成',failed:'拉取失败',cancelled:'请求已停止'})[job.state]}</strong><p>{job.reference} · {job.platform || '引擎默认平台'}</p>{job.layers.length?<ul aria-label="镜像层进度">{job.layers.map(layer=><li key={layer.id}><code>{layer.id}</code><span>{layer.status}</span></li>)}</ul>:running?<p className="docker-muted">正在连接仓库，等待镜像层信息…</p>:null}{job.imageId?<code className="docker-pull-image-id">{job.imageId}</code>:null}{job.error?<p className="docker-error">{job.error}</p>:null}{running?<p className="docker-muted">关闭窗口后任务继续；停止请求可能保留已下载的层。</p>:null}</section>:null}
        {error?<p className="docker-error" role="alert">{error}</p>:null}
      </form>
    </DialogShell>:null}</>;
}
