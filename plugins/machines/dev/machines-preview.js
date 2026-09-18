(() => {
  'use strict';
  if (window.__TAURI__ || window.parent !== window) throw new Error('模拟预览只能独立运行，不能覆盖原生宿主。');
  const banner = document.createElement('section');
  banner.className = 'panel';
  banner.setAttribute('aria-label', '插件开发预览');
  banner.innerHTML = '<strong>插件开发预览 · 全部为模拟数据</strong><p>不读取本机 SSH 配置，不连接机器、不执行命令。修改页面自动刷新；刷新后恢复初始数据。后台监控仅生成一次模拟快照。</p><div class="actions"><label>模拟结果 <select id="previewOutcome"><option value="success">成功</option><option value="failed">失败</option><option value="timeout">超时</option></select></label><label><input id="previewNetdataExisting" type="checkbox"> Netdata 模拟为「已有安装」</label><button id="previewReset" type="button">重置预览数据</button></div>';
  document.body.prepend(banner);
  document.querySelector('#previewReset').onclick = () => window.location.reload();
  const clone = value => structuredClone(value);
  const profiles = new Map();
  const state = {
    config: { enabled: true, monitoring: false, interval: 60, connectionIdleSeconds: 28800, netdata: [
      { id: 'netdata-demo', name: '演示 Netdata 节点', url: 'http://127.0.0.1:19999', networkChart: 'system.net' },
    ], installed: {
      version: 'dev', capabilities: ['ssh:collect', 'ssh:execute', 'ssh:configure', 'ssh:terminal'],
      templates: [{ name: '系统概况（模拟）', command: 'uname -a; uptime; df -h /' }],
    }, hosts: [
      { id: 'demo-app', alias: 'demo-app', name: '应用服务（模拟）', group: '开发环境' },
      { id: 'demo-db', alias: 'demo-db', name: '数据库（模拟）', group: '测试环境' },
    ] }, metrics: {}, active: [], history: [],
  };
  const pending = new Map();
  const archive = [];
  const historyDemo = document.createElement('button'); historyDemo.type = 'button'; historyDemo.textContent = '生成分页示例';
  banner.querySelector('.actions').append(historyDemo);
  historyDemo.onclick = () => {
    for (let i = 0; i < 65; i++) archive.push({ id: crypto.randomUUID(), hostId: i % 2 ? 'demo-app' : 'demo-db', alias: i % 2 ? 'demo-app' : 'demo-db', kind: 'command', command: 'uptime', startedAt: Date.now() - i * 60000, finishedAt: Date.now() - i * 60000 + 100, status: i % 3 ? 'success' : 'failed', exitCode: i % 3 ? 0 : 1, stdout: '【分页示例，未执行命令】', stderr: '' });
  };
  const sessions = new Map();
  const defaultProfile = alias => ({ alias, hostname: `${alias}.example.test`, user: 'demo', port: 22, identityFile: '', proxyJump: '' });
  const metric = () => ({ cpu: 23.4, memory: 48.2, disk: 36.1, load: 0.42, uptime: 172800 });
  const GRACE = 1073741824;
  const trafficResult = config => {
    const at = new Date().toISOString();
    const days = 30 * 86400000;
    if (config.provider === 'localNet') {
      const used = 9.37 * GRACE, limit = Number(config.limitGB) || 0, average = 14.49 * GRACE;
      return { provider: 'localNet', at, instanceName: '演示 Netdata 节点', rows: [{ InstanceId: 'netdata-demo', TrafficPackageSet: [{
        RxBytes: 4.81 * GRACE, TxBytes: 4.56 * GRACE, TrafficUsed: used, TrafficPackageTotal: limit * GRACE,
        TrafficPackageRemaining: Math.max(0, limit * GRACE - used), TrafficOverflow: Math.max(0, used - limit * GRACE),
        LimitGB: limit, PercentUsed: limit > 0 ? used / (limit * GRACE) * 100 : 0, DailyAverage: average,
        PeriodDays: 30, DaysRemaining: limit > 0 ? Math.max(0, (limit * GRACE - used) / average) : 0,
        StartTime: new Date(Date.now() - days).toISOString(), EndTime: at,
      }] }] };
    }
    const shared = config.provider === 'linode' || config.provider === 'vultr';
    const usage = config.provider === 'aws';
    const total = (shared ? 2000 : 300) * GRACE, used = (shared ? 1680 : usage ? 268 : 295) * GRACE;
    return { provider: config.provider || 'tencent', at, rows: [{ InstanceId: config.instanceId || config.serverId || config.veid || 'instance', TrafficPackageSet: [{
      TrafficPackageTotal: total, TrafficUsed: used, TrafficPackageRemaining: Math.max(0, total - used),
      TrafficOverflow: Math.max(0, used - total), StartTime: new Date(Date.now() - days).toISOString(), EndTime: at,
    }] }], summary: shared ? { scope: 'account' } : usage ? { mode: 'usage', scope: 'instance' } : { scope: 'instance' } };
  };
  async function invoke(method, args = {}) {
    if (method === 'machines_run') {
      const host = state.config.hosts.find(h => h.id === args.hostId && h.alias === args.expectedAlias);
      if (!host) throw new Error('模拟目标已变化，请重新选择');
      const outcome = document.querySelector('#previewOutcome').value;
      const job = { ...args, alias: host.alias, status: 'running', startedAt: Date.now(), finishedAt: null };
      state.active.push(job);
      return new Promise(resolve => {
        const finish = status => {
          clearTimeout(pending.get(job.id)?.timer);
          pending.delete(job.id);
          state.active = state.active.filter(j => j.id !== job.id);
          Object.assign(job, { status, finishedAt: Date.now(), exitCode: status === 'success' ? 0 : 1,
            stdout: status === 'success' ? `【模拟输出，未执行命令】\n${args.command || '指标采集'}\n目标：${host.alias}` + (args.command && args.command.includes('FLOWHUB Netdata installation') ? '\nFLOWHUB_NETDATA_AGENT_HOST=203.0.113.10\nFLOWHUB_NETDATA_AGENT_PORT=19999' : '') : '',
            stderr: status === 'success' ? '' : `模拟${status === 'cancelled' ? '取消' : status === 'timeout' ? '连接超时' : '认证失败'}` });
          state.history.unshift(job);
          if (job.kind === 'command') archive.unshift(clone(job));
          const counts = {};
          state.history = state.history.filter(j => (counts[j.kind] = (counts[j.kind] || 0) + 1) <= 100);
          if (args.kind === 'collect') state.metrics[host.id] = { status, at: Date.now(), values: metric(), error: job.stderr };
          resolve(clone(job));
        };
        pending.set(job.id, { finish, timer: setTimeout(() => finish(outcome), 3000) });
      });
    }
    if (method === 'backup_api') {
      if(args.action==='inspect') return {token:'preview-backup',summary:{created:'模拟备份 · 不读取本机文件',machines:2,files:4,hasPasswords:true,hasHistory:true}};
      if(args.action==='restore') return {restartRequired:true,rollback:'/模拟备份/恢复前数据（未修改真实数据）'};
      return {path:'/模拟备份/machines.fhbackup（预览未写入文件）'};
    }
    if (method !== 'machines_api') throw new Error(`预览不支持调用：${method}`);
    const { action, payload = {} } = args;
    if (action.startsWith('bastion')) {
      const host = state.config.hosts.find(h => h.id === payload.hostId);
      if (!host?.bastion) throw Error('请选择堡垒机机器');
      if (action === 'bastionStart' && !sessions.has(host.id)) sessions.set(host.id, { connected: true, output: `【模拟会话，未运行 relay】\ndemo@relay -> ${host.bastion.command} ${host.bastion.target}\n已进入模拟目标机器。\ndemo@${host.alias}:~$ ` });
      if (action === 'bastionStop') sessions.delete(host.id);
      if (action === 'bastionTerminal') throw Error('模拟预览不打开系统终端；桌面版将附着到同一 tmux 会话。');
      if (action === 'bastionSend') {
        const session = sessions.get(host.id); if (!session) throw Error('会话未连接');
        session.output = (session.output + `\n${payload.key || '[已发送输入，模拟不执行]'}\ndemo@${host.alias}:~$ `).slice(-65536);
      }
      return clone(sessions.get(host.id) || { connected: false, output: '会话未连接。' });
    }
    switch (action) {
      case 'monitorSettings': state.config.retentionDays=payload.days;state.config.exporters=clone(payload.exporters);return clone(state);
      case 'exporterTest':return {...metric(),rx:12,tx:3};
      case 'metricHistory':return {unit:payload.metric==='rx'||payload.metric==='tx'?'KB/s':'%',data:Array.from({length:60},(_,i)=>[Math.floor(Date.now()/1000)-(60-i)*60,i>20&&i<30?null:40+Math.sin(i/5)*15])};
      case 'netdataTest': return {rows:[],charts:[{id:'system.cpu',units:'%'},{id:'system.ram',units:'MiB'},{id:'system.net',units:'kilobits/s'},{id:'net.eth0',units:'kilobits/s'}]};
      case 'netdataSave': state.config.netdata=(state.config.netdata||[]).filter(i=>i.id!==payload.id).concat(clone(payload));return clone(state);
      case 'netdataRemove': state.config.netdata=(state.config.netdata||[]).filter(i=>i.id!==payload.id);return clone(state);
      case 'netdataHistory': return {labels:['time','模拟指标'],data:Array.from({length:60},(_,i)=>[Math.floor(Date.now()/1000)-i*60,40+Math.sin(i/5)*15])};
      case 'trafficRead': return clone(state.traffic?.[payload.hostId] || { configured: false });
      case 'trafficSave': { const saved = clone(payload); delete saved.clearToken; state.traffic = state.traffic || {}; state.traffic[payload.hostId] = { ...saved, configured: true, revision: 'preview' }; return clone(state.traffic[payload.hostId]); }
      case 'trafficQuery': return trafficResult(state.traffic?.[payload.hostId] || {});
      // 预览里模拟完整安装过程：任务几秒后成功，并按真实脚本的格式回传探测到的地址，
      // 这样「安装 → 一键填入 Agent 地址」这条链路在浏览器里就能验证。
      case 'netdataInstallPlan': { const h=state.config.hosts.find(x=>x.id===payload.hostId); return {alias:h?.alias||'demo-app',name:h?.name||'模拟机器',command:'set -eu\n# FlowHub Netdata installation\n【模拟命令，不会执行】'}; }
      case 'netdataInstall': { const job={id:'preview-netdata-'+Date.now(),hostId:payload.hostId,alias:'demo-app',kind:'command',command:'# FlowHub Netdata installation',status:'running',startedAt:Date.now(),finishedAt:null,stdout:'',stderr:''}; state.active.push(job); const existing=document.querySelector('#previewNetdataExisting')?.checked; pending.set(job.id,{finish:()=>{},timer:setTimeout(()=>{state.active=state.active.filter(j=>j.id!==job.id);Object.assign(job,{status:'success',finishedAt:Date.now(),exitCode:0,stderr:'',stdout:existing?'【模拟输出，未执行命令】\n发现已有 Netdata，未更改配置。\nFLOWHUB_NETDATA_AGENT_HOST=2402:4e00:c032:3d00:421e:67f0:2c62:0\nFLOWHUB_NETDATA_AGENT_PORT=19999\nAgent 地址：http://203.0.113.10:19999\n注意：本机自检未连上 127.0.0.1:19999，这不代表地址不可用。':'【模拟输出，未执行命令】\nNetdata 已安装并已就绪。\nFLOWHUB_NETDATA_AGENT_HOST=203.0.113.10\nFLOWHUB_NETDATA_AGENT_PORT=19999\nAgent 地址：http://203.0.113.10:19999'});state.history.unshift(job);},4000)}); return {id:job.id}; }
      case 'state': return clone(state);
      case 'hosts': state.config.hosts = clone(payload.hosts); return clone(state);
      case 'templates': state.config.templates = clone(payload.templates); return clone(state);
      case 'connectionSettings': state.config.reuseConnections = payload.reuse; state.config.connectionIdleSeconds = payload.idleSeconds; return clone(state);
      case 'monitor':
        state.config.monitoring = payload.enabled; state.config.interval = payload.interval;
        if (payload.enabled) for (const h of state.config.hosts) state.metrics[h.id] = { status: 'success', at: Date.now(), values: metric() };
        return clone(state);
      case 'history': {
        const all = [...state.active.filter(j => j.kind === 'command'), ...archive];
        const items = all.filter(j => (!payload.hostId || j.hostId === payload.hostId) && (!payload.status || j.status === payload.status)).sort((a,b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
        const pageSize = Math.max(1, Math.min(100, Number(payload.pageSize) || 20));
        const pages = Math.max(1, Math.ceil(items.length / pageSize)), page = Math.max(1, Math.min(pages, Number(payload.page) || 1));
        return clone({ items: items.slice((page-1)*pageSize,page*pageSize), total: items.length, pages, page, pageSize, instances: [...new Map(all.map(j => [j.hostId, {hostId:j.hostId,alias:j.alias}])).values()] });
      }
      // 模拟修复后的后端：任务运行期间也能查到（status=running、finishedAt=null），
      // 而不是抛「记录已过期或任务未结束」。
      case 'job': { const done=archive.find(j => j.id === payload.id) || state.history.find(j => j.id === payload.id);
        if (done) return clone(done);
        const live=state.active.find(j => j.id === payload.id);
        if (live) return { ...clone(live), status:'running', finishedAt:null, stdout:'', stderr:'' };
        throw Error('记录已过期或任务未结束'); }
      case 'cancel': pending.get(payload.id)?.finish('cancelled'); return {};
      case 'discoverSsh': return { root: '/模拟目录/.ssh/config', files: 1, warnings: ['这是模拟配置，未读取本机文件。'], hosts: ['demo-app', 'demo-db', 'demo-new'].map((alias, i) => ({ alias, sources: [`/模拟目录/.ssh/config:${i * 5 + 1}`] })) };
      case 'sshRead': {
        const saved=profiles.get(payload.alias),profile = saved?.profile || defaultProfile(payload.alias);
        return { profile: clone(profile), passwordAuth:!!saved?.passwordAuth,effective: clone(profile), revision: 'preview', inheritedKeys: [] };
      }
      case 'sshSave': profiles.set(payload.profile.alias, {profile:clone(payload.profile),passwordAuth:!!payload.passwordAuth}); return { revision: 'preview' };
      case 'sshProbe': return { reason: document.querySelector('#previewOutcome').value === 'success' ? '模拟连接成功，未建立真实连接' : '模拟连接失败', durationMs: 25, stderr: '' };
      case 'chooseIdentity': throw new Error('模拟预览不读取私钥；可在表单输入虚拟路径。');
      case 'terminal': throw new Error('模拟预览不打开终端；真实 SSH 请使用开发版 FlowHub。');
      default: throw new Error(`预览不支持操作：${action}`);
    }
  }
  window.__TAURI__ = { core: { invoke } };
})();
