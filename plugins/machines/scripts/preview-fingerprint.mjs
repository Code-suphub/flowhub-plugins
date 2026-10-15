// Widget React 构建产物的交互回归与公共下拉计算样式指纹。
//
// 机器 React 页面另由 layout-audit 覆盖。这里把公共 Select 的计算样式（只取
// 声明性属性，不含依赖字体度量的 width/height）落成基线文件，重构后必须逐项一致。
//
//   node scripts/preview-fingerprint.mjs --write    # 重新生成基线
//   node scripts/preview-fingerprint.mjs            # 与基线比对，不一致 exit 1
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineCommonHtml } from '../../../scripts/inline-common.mjs';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ui = resolve(here, '..', 'ui');
const buildUi = resolve(here, '..', 'build/ui');
const baselinePath = resolve(here, '..', 'tests', 'fixtures', 'select-control-fingerprint.json');
const write = process.argv.includes('--write');

// 只取声明性属性：宽度/高度会随字体与文本变化，不纳入指纹。
const PROPERTIES = [
  'display', 'position', 'inset', 'top', 'right', 'left', 'bottom', 'zIndex',
  'padding', 'margin', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'borderWidth', 'borderStyle', 'borderColor', 'borderRadius', 'boxShadow',
  'backgroundColor', 'color', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight',
  'textAlign', 'whiteSpace', 'overflow', 'overflowY', 'gap', 'justifyContent', 'alignItems', 'cursor'
];
const SELECTORS = ['.fh-select', '.fh-select__trigger', '.fh-select__menu', '.fh-select__option', '.fh-select__option[aria-selected="true"]'];
const COMBOBOX_SELECTORS = ['.fh-combobox', '.fh-combobox__control', '.fh-combobox__input', '.fh-combobox__menu', '.fh-combobox__option', '.fh-combobox__option[aria-selected="true"]'];
// 这里必须加载真实构建产物，不允许空页面/旧脚本 404 被当成有效基线。
const PAGES = ['widget-card.html', 'widget-detail.html', 'widget-editor.html'];
const WIDTHS = [1400, 600, 380];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

function server() {
  const instance = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/^\/+/, '') || 'machines.html';
    const generated = /^(?:react\/widget-editor|widget\/(?:card|detail))\.(?:js|css)$/.test(name);
    const common = name.startsWith('_common/');
    const base = common ? resolve(here, '../../common/ui') : generated ? buildUi : ui;
    const path = resolve(base, common ? name.slice('_common/'.length) : name);
    if (!path.startsWith(base + '/') || !existsSync(path)) { response.writeHead(404).end(); return; }
    const source = `http://127.0.0.1:${instance.address().port}`;
    response.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream', 'cache-control': 'no-store',
      // Standalone fixtures need same-origin JSON; script restrictions match the desktop.
      'content-security-policy': `default-src 'none'; script-src ${source}; style-src ${source} 'unsafe-inline'; img-src ${source} data:; font-src ${source}; connect-src ${source}; base-uri 'none'; form-action 'none'` });
    const raw = await readFile(path, 'utf8');
    response.end(extname(name) === '.html' ? inlineCommonHtml(raw, {scriptPrefix:'_common'}) : raw);
  });
  return new Promise(resolve => instance.listen(0, '127.0.0.1', () => resolve(instance)));
}

async function chrome() {
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  const executable = candidates.find(candidate => existsSync(candidate));
  if (!executable) return null;
  const profile = await mkdtemp(join(tmpdir(), 'flowhub-fingerprint-'));
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 100 && !existsSync(join(profile, 'DevToolsActivePort')); attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
  if (!existsSync(join(profile, 'DevToolsActivePort'))) { child.kill('SIGKILL'); throw new Error('Chrome 未能启动'); }
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  let target = null;
  for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => []);
    target = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl) || null;
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!target) { child.kill('SIGKILL'); throw new Error('没有找到页面调试目标'); }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  const pending = new Map();
  const events = [];
  const errors = [];
  let nextId = 1;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); return; }
    events.push(message.method);
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
  };
  return {
    send,
    async load(url) {
      events.length = 0;
      errors.length = 0;
      await send('Page.navigate', { url });
      for (let attempt = 0; attempt < 100 && !events.includes('Page.loadEventFired'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
      // React and the preview JSON initialize asynchronously; do not measure a blank frame.
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await send('Runtime.evaluate', {expression: '!!document.querySelector("#widget-root > *, #root .fh-select, #root .fh-combobox")', returnByValue:true});
        if (ready.result?.value) {
          await send('Runtime.evaluate', {expression:'document.fonts.ready',awaitPromise:true});
          return;
        }
        if (errors.length) throw Error(`${url}: ${errors.join('; ')}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error(`${url}: React 初始化超时 ${errors.join('; ')}`);
    },
    async close() {
      socket.close();
      child.kill('SIGKILL');
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 2000); } });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await rm(profile, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
      }
    }
  };
}

const EXPRESSION = `(async () => {
  // Measure declared end states rather than a scheduler-dependent animation frame.
  const stable = document.createElement('style');
  stable.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.append(stable);
  const properties = ${JSON.stringify(PROPERTIES)};
  const capture = (element, pseudo) => {
    if (!element) return null;
    const style = getComputedStyle(element, pseudo || undefined);
    return Object.fromEntries(properties.map(property => [property, style[property]]));
  };
  const out = {};
  const all = [...document.querySelectorAll('.fh-select, .fh-combobox')];
  // 只量当前可见的下拉：隐藏面板/未打开的 dialog 里 rect 为 0，量不到真实样式。
  const shells = all.filter(shell => shell.getBoundingClientRect().width > 0);
  out.__selects = all.length;
  out.__visibleSelects = shells.length;
  const scope = shells[0] || null;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const trigger = scope?.querySelector('.fh-select__trigger, .fh-combobox__toggle');
  if (trigger) { trigger.click(); await frame(); }
  const selectors = scope?.classList.contains('fh-combobox') ? ${JSON.stringify(COMBOBOX_SELECTORS)} : ${JSON.stringify(SELECTORS)};
  for (const selector of selectors) {
    const element = scope?.matches(selector) ? scope : scope?.querySelector(selector);
    out[selector] = capture(element, null);
  }
  if (trigger) {
    out.__menuOpen = !!scope.querySelector('[role="listbox"]');
    if (!out.__menuOpen) throw Error('React 下拉未能打开');
    trigger.click(); await frame();
  }
  if (!document.querySelector('#widget-root > *, #root > *')) throw Error('Widget 未渲染，不能用空页面通过检查');
  if (location.pathname.includes('detail') && document.querySelectorAll('#charts svg').length !== 6) throw Error('详情曲线未加载');
  if (!location.pathname.includes('card') && !trigger) throw Error('Widget 缺少 React 下拉');
  if (document.documentElement.scrollWidth > innerWidth + 1) throw Error('Widget 页面横向溢出');
  stable.remove();
  return out;
})()`;

const INTERACTIONS = `(async () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 30));
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const init = context => window.postMessage({type:'flowhub:widget-init',token:null,context}, '*');
  if (location.pathname.includes('editor')) {
    init({config:{row:'ssh-one',metrics:['cpu']},snapshot:{rows:[
      {id:'ssh-one',name:'同名机器',source:'SSH',status:'unknown'},
      {id:'netdata-one',name:'同名机器',source:'Netdata',status:'error'},
      {id:'ssh-two',name:'mac-mini',source:'SSH',status:'healthy'}
    ]}}); await tick();
    const input = document.querySelector('#machine-row');
    const query = async value => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
      input.dispatchEvent(new Event('input',{bubbles:true})); await tick();
    };
    const key = async value => { input.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true})); await tick(); };
    await query('采集失败');
    check(document.querySelectorAll('[role="option"]').length === 1, '应按采集状态过滤机器');
    check(document.querySelector('[role="option"]').textContent.includes('Netdata'), '同名机器应按来源区分');
    check(window.FlowHubWidget.validate().row === 'ssh-one', '输入检索不应修改已选机器');
    await key('Enter');
    check(window.FlowHubWidget.validate().row === 'netdata-one', '回车应保存正确的机器 ID');
    await query('MAC-MINI');
    check(document.querySelectorAll('[role="option"]').length === 1, '机器名称搜索应忽略大小写');
    await key('Escape');
    check(window.FlowHubWidget.validate().row === 'netdata-one', '取消检索应保留原选择');
    await query('不存在的机器');
    check(document.querySelector('.fh-combobox__menu').textContent.includes('没有匹配的机器'), '无匹配机器应显示提示');
    await key('Enter');
    check(window.FlowHubWidget.validate().row === 'netdata-one', '不能将检索文字保存成机器 ID');
    await key('Escape');
    await query('SSH');
    window.dispatchEvent(new Event('blur')); await tick();
    check(!document.querySelector('.fh-combobox__menu'), '窗口失焦后搜索选项不能残留');
    check(window.FlowHubWidget.validate().row === 'netdata-one', '失焦关闭不能改变已选机器');
    await query('SSH');
    const owner = input.closest('.fh-combobox');
    owner.style.display = 'none'; await tick();
    check(!document.querySelector('.fh-combobox__menu'), '所属控件隐藏时搜索选项应关闭');
    owner.style.display = ''; await tick();
    check(!document.querySelector('.fh-combobox__menu'), '所属控件重新显示时不能自动复活旧选项');
  }
  if (location.pathname.includes('card')) {
    const card = document.querySelector('.card');
    const snapshot = {rows:[{id:'a',name:'A',status:'healthy',values:{cpu:25}}]};
    init({config:{view:'widget',row:'a'},title:'自定义标题',snapshot}); await tick();
    check(document.querySelector('.card') === card, '重复初始化不能重复创建 React root');
    check(document.querySelector('h2')?.textContent.includes('自定义标题'), '宿主标题必须保留');
    check(document.querySelector('.gauges svg'), '兼容旧 widget 视图');
    init({config:{row:'removed'},snapshot}); await tick();
    check(document.body.textContent.includes('目标已移除'), '已删除目标不能回退显示另一机器');
  }
  if (location.pathname.includes('detail')) {
    const calls = [];
    window.FlowHubWidget.invoke = params => new Promise((resolve,reject) => calls.push({params,resolve,reject}));
    init({config:{row:'first'},preview:false}); await tick();
    check(calls.length === 6, '应查询六项历史指标');
    init({config:{row:'second'},preview:false}); await tick();
    check(calls.length === 12, '目标更新应重新读取历史');
    calls.slice(6).forEach((call,index) => index === 0 ? call.reject(Error('mock failed')) : call.resolve({data:[[1,22],[2,23]],unit:'%'}));
    await tick();
    check(document.querySelector('[role="alert"]')?.textContent.includes('mock failed'), '错误必须可见，不能丢弃其它成功曲线');
    check(document.querySelectorAll('#charts svg').length === 5, '成功指标仍应显示');
    calls.slice(0,6).forEach(call=>call.resolve({data:[[1,99]],unit:'%'})); await tick();
    check(!document.querySelector('#charts')?.textContent.includes('99.00'), '过期请求不得覆盖当前结果');
    const chart = document.querySelectorAll('.chart-card .fh-time-series svg')[0];
    const bounds = chart.getBoundingClientRect();
    chart.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bounds.left + bounds.width * .5, clientY: bounds.top + bounds.height * .5 })); await tick();
    check(!!document.querySelector('.chart-card .fh-time-series__tooltip time') && !!document.querySelector('.chart-card .fh-time-series__cursor line'), '桌面组件曲线应显示十字线与时间数值');
    document.querySelectorAll('.chart-card')[1].querySelector('button')?.click(); await tick();
    const dialog = document.querySelector('dialog[open]');
    check(dialog && dialog.getBoundingClientRect().width > 0, '放大弹窗应显示');
    check(getComputedStyle(dialog).position === 'fixed', '公共弹窗必须有构建后的定位样式');
    check(dialog.getBoundingClientRect().right <= innerWidth + 1, '放大弹窗不能越界');
    dialog.querySelector('button[aria-label="关闭"]')?.click(); await tick();
    check(!document.querySelector('dialog[open]'), '关闭弹窗');
  }
  return true;
})()`;

async function main() {
  execFileSync('npm', ['run', 'build:react'], { cwd: resolve(here, '..'), stdio: 'inherit' });
  const instance = await server();
  const port = instance.address().port;
  const client = await chrome();
  if (!client) {
    console.log('跳过下拉指纹：没有找到 Chrome（可用 CHROME_PATH 指定）');
    instance.close();
    return;
  }
  const fingerprint = {};
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    for (const theme of ['dark', 'light']) for (const page of PAGES) {
      const key = `${theme}/${page}`;
      fingerprint[key] = {};
      for (const width of WIDTHS) {
        await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await client.load(`http://127.0.0.1:${port}/${page}`);
        await client.send('Runtime.evaluate', { expression: `window.FlowHubTheme.set('${theme}')` });
        const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression: EXPRESSION, returnByValue: true, awaitPromise: true });
        if (exceptionDetails) throw new Error(`${page} @${width}: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        fingerprint[key][width] = result.value;
        if (width === 380 && process.argv.includes('--screenshots')) {
          const folder = await mkdtemp(join(tmpdir(), 'flowhub-widget-review-'));
          const shot = await client.send('Page.captureScreenshot', { format: 'png' });
          const target = join(folder, page.replace('.html', '.png'));
          await writeFile(target, Buffer.from(shot.data, 'base64'));
          console.log(`Screenshot: ${target}`);
        }
        const interaction = await client.send('Runtime.evaluate', {expression:INTERACTIONS,returnByValue:true,awaitPromise:true});
        if (interaction.exceptionDetails) throw Error(`${page} @${width}: ${interaction.exceptionDetails.exception?.description || interaction.exceptionDetails.text}`);
      }
    }
    for (const theme of ['light','dark']) for (const [width,height] of [[160,140],[220,130],[184,184],[320,184]]) {
      await client.send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
      await client.load(`http://127.0.0.1:${port}/widget-card.html`);
      const compact = await client.send('Runtime.evaluate', {awaitPromise:true,returnByValue:true,expression:`(async () => {
        window.FlowHubTheme.set('${theme}');
        window.postMessage({type:'flowhub:widget-init',token:null,context:{
          title:'tencent-sh',config:{row:'a',metrics:['cpu','memory','disk','traffic','tx','rx','load','uptime']},
          snapshot:{rows:[{id:'a',status:'healthy',expiresAt:Date.now()+354*86400000+8*3600000,
            traffic:{remaining:247.66e9,total:300e9,divisor:1e9,at:new Date().toISOString()},
            values:{cpu:3,memory:33,disk:34,tx:106,rx:107.3,load:0.1,uptime:86400*25}}]}
        }}, '*');
        await new Promise(resolve=>setTimeout(resolve,80));
        const body=document.querySelector('.card-body');
        const footer=document.querySelector('.widget-foot');
        const gauge=document.querySelector('.fh-gauge svg');
        if(!document.querySelector('.network-row .bottom-metrics')?.textContent.includes('运行') || !footer.querySelector('.expiry'))throw Error('底部内容缺失');
        const rates=document.querySelector('.network-rates'),countdown=footer.querySelector('.expiry');
        if(getComputedStyle(rates).fontFamily!==getComputedStyle(countdown).fontFamily || getComputedStyle(rates).fontSize!==getComputedStyle(countdown).fontSize)throw Error('网速和其他元数据字体不统一');
        if(innerWidth>=220 && Math.abs(rates.getBoundingClientRect().top-countdown.getBoundingClientRect().top)>1)throw Error('正常宽度下网速和倒计时仍换行');
        const traffic=document.querySelector('.traffic-metric b');
        if(traffic.textContent!=='247.66/300 GB'||traffic.getBoundingClientRect().height>15)throw Error('流量数值和单位被拆行');
        if(document.querySelector('.network-rates').getBoundingClientRect().top<document.querySelector('.network-row').getBoundingClientRect().bottom)throw Error('网速未放到用量下一行');
        for(const node of document.querySelectorAll('.network-row,.traffic-metric,.bottom-metrics,.network-rates,.network-rates span')){
          const rect=node.getBoundingClientRect();if(rect.left<0||rect.right>innerWidth)throw Error('指标横向溢出');
        }
        if(body.scrollHeight>body.clientHeight+1 || footer.getBoundingClientRect().bottom>innerHeight-3)throw Error('小卡片内容被裁切');
        if(gauge.getBoundingClientRect().height<32)throw Error('仪表图被过度压缩: '+JSON.stringify([...document.querySelectorAll('.card-head,.card-body,.gauges,.network-row,.widget-foot')].map(e=>[e.className,e.getBoundingClientRect().height])));
        return true;
      })()`});
      if(compact.exceptionDetails)throw Error(`${theme} ${width}×${height}: ${compact.exceptionDetails.exception?.description}`);
      for (const [tx,rx,uptime] of [[85.4,17.4,20.3],[12.7,17.5,395.1]]) {
        const merged=await client.send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
          window.postMessage({type:'flowhub:widget-init',token:null,context:{title:'compact',config:{row:'a',showExpiry:false,metrics:['cpu','memory','disk','tx','rx','load','uptime']},snapshot:{rows:[{id:'a',status:'healthy',values:{cpu:10,memory:76,disk:92,tx:${tx},rx:${rx},load:1.5,uptime:${uptime}*86400}}]}}},'*');
          await new Promise(resolve=>setTimeout(resolve,80));
          const meta=document.querySelector('.network-row--compact'),rates=meta?.querySelector('.network-rates'),summary=meta?.querySelector('.bottom-metrics');
          if(!rates||!summary||document.querySelector('.widget-foot'))throw Error('精简指标没有合并');
          if(innerWidth>=220&&Math.abs(rates.getBoundingClientRect().top-summary.getBoundingClientRect().top)>1)throw Error('可容纳的精简指标仍占两行');
          for(const node of meta.querySelectorAll('span')){const rect=node.getBoundingClientRect();if(rect.left<0||rect.right>innerWidth)throw Error('精简指标横向溢出');}
          const body=document.querySelector('.card-body');if(body.scrollHeight>body.clientHeight+1)throw Error('精简卡片内容被裁切');
          return true;
        })()`});
        if(merged.exceptionDetails)throw Error(`${theme} ${width}×${height} merged: ${merged.exceptionDetails.exception?.description}`);
      }
    }
    await client.send('Emulation.setDeviceMetricsOverride',{width:320,height:184,deviceScaleFactor:1,mobile:false});
    const counts=await client.send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
      for(const enabled of [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3],[0,1,2],[0,1,3],[0,2,3],[1,2,3]]){
        const metrics=['cpu','memory','disk',...(enabled.includes(0)?['traffic']:[]),...(enabled.includes(1)?['tx','rx']:[]),...(enabled.includes(2)?['load','uptime']:[])];
        window.postMessage({type:'flowhub:widget-init',token:null,context:{title:'counts',config:{row:'a',metrics,showExpiry:enabled.includes(3)},snapshot:{rows:[{id:'a',status:'healthy',expiresAt:Date.now()+336*86400000,traffic:{remaining:247.66e9,total:300e9,divisor:1e9,at:new Date().toISOString()},values:{cpu:10,memory:76,disk:92,tx:85.4,rx:17.4,load:1.5,uptime:20.3*86400}}]}}},'*');
        await new Promise(resolve=>setTimeout(resolve,80));
        const compact=document.querySelector('.network-row--compact');
        if(enabled.length===2){
          if(!compact||compact.children.length!==2)throw Error('两个展示块未合并: '+enabled);
          const children=[...compact.children];if(Math.abs(children[0].getBoundingClientRect().top-children[1].getBoundingClientRect().top)>1)throw Error('两个展示块不在同一行: '+enabled);
        }else{
          if(compact)throw Error('超过两个展示块仍被合并: '+enabled);
          if(enabled.includes(0)&&!document.querySelector('.network-row .traffic-metric'))throw Error('用量位置变化');
          if(enabled.includes(2)&&!document.querySelector('.network-row .bottom-metrics'))throw Error('负载运行位置变化');
          if(enabled.includes(1)&&!document.querySelector('.widget-foot .network-rates'))throw Error('网速位置变化');
          if(enabled.includes(3)&&!document.querySelector('.widget-foot .expiry'))throw Error('倒计时位置变化');
        }
      }
      return true;
    })()`});
    if(counts.exceptionDetails)throw Error(counts.exceptionDetails.exception?.description);
    console.log('PASS: 四档宽度深浅主题完整展示；六种双指标组合合并一行，三指标保留既定位置');
  } finally {
    await client.close();
    instance.close();
  }

  if (write) {
    await mkdir(resolve(here, '..', 'tests', 'fixtures'), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(fingerprint, null, 2)}\n`);
    console.log(`基线已写入 ${baselinePath.replace(resolve(here, '..') + '/', '')}`);
    return;
  }

  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const problems = [];
  for (const page of Object.keys(baseline)) {
    for (const width of Object.keys(baseline[page])) {
      const before = baseline[page][width];
      const after = fingerprint[page]?.[width];
      if (!after) { problems.push(`${page} @${width}px 没有取到指纹`); continue; }
      for (const selector of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (selector.startsWith('__')) {
          if (String(before[selector]) !== String(after[selector])) problems.push(`${page} @${width}px ${selector}: ${before[selector]} → ${after[selector]}`);
          continue;
        }
        const left = before[selector];
        const right = after[selector];
        if (!left || !right) { if (!!left !== !!right) problems.push(`${page} @${width}px ${selector}: 存在性变化`); continue; }
        for (const property of Object.keys(left)) {
          if (String(left[property]) !== String(right[property])) {
            problems.push(`${page} @${width}px ${selector} ${property}: ${left[property]} → ${right[property]}`);
          }
        }
      }
    }
  }
  if (problems.length) {
    console.log(`${problems.length} 处下拉样式与基线不一致：\n- ${problems.slice(0, 25).join('\n- ')}${problems.length > 25 ? `\n…还有 ${problems.length - 25} 处` : ''}`);
    process.exitCode = 1;
    return;
  }
  const selects = Object.values(fingerprint).reduce((sum, page) => sum + Math.max(...Object.values(page).map(entry => entry.__selects || 0)), 0);
  console.log(`PASS: ${PAGES.length} 个页面 × ${WIDTHS.length} 档宽度的自绘下拉计算样式与基线逐项一致（每页最多 ${selects} 个下拉）`);
}

main().catch(error => { console.error(`下拉指纹失败：${error.message}`); process.exitCode = 1; });
