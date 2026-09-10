(() => {
  'use strict';
  if (window.__TAURI__ || window.parent !== window) throw new Error('模拟预览只能独立运行，不能覆盖原生宿主。');
  const banner = document.createElement('section');
  banner.className = 'panel';
  banner.setAttribute('aria-label', '插件开发预览');
  banner.innerHTML = '<strong>插件开发预览 · 全部为模拟数据</strong><p>不读取本机 SSH 配置，不连接机器、不执行命令。修改页面自动刷新；刷新后恢复初始数据。后台监控仅生成一次模拟快照。</p><div class="actions"><label>模拟结果 <select id="previewOutcome"><option value="success">成功</option><option value="failed">失败</option><option value="timeout">超时</option></select></label><button id="previewReset" type="button">重置预览数据</button></div>';
  document.body.prepend(banner);
  document.querySelector('#previewReset').onclick = () => window.location.reload();
  const clone = value => structuredClone(value);
  const profiles = new Map();
  const state = {
    config: { enabled: true, monitoring: false, interval: 60, connectionIdleSeconds: 28800, installed: {
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
            stdout: status === 'success' ? `【模拟输出，未执行命令】\n${args.command || '指标采集'}\n目标：${host.alias}` : '',
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
      case 'netdataInstallPlan': throw Error('浏览器预览不安装软件，请在 FlowHub 中选择真实目标并预览安装命令。');
      case 'netdataInstall': throw Error('浏览器预览不安装软件。');
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
      case 'job': return clone(archive.find(j => j.id === payload.id) || state.history.find(j => j.id === payload.id));
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
