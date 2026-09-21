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
// 这里必须加载真实构建产物，不允许空页面/旧脚本 404 被当成有效基线。
const PAGES = ['widget-card.html', 'widget-detail.html', 'widget-editor.html'];
const WIDTHS = [1400, 600, 380];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

function server() {
  const instance = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/^\/+/, '') || 'machines.html';
    const generated = /^(?:react\/widget-editor|widget\/(?:card|detail))\.(?:js|css)$/.test(name);
    const base = generated ? buildUi : ui;
    const path = resolve(base, name);
    if (!path.startsWith(base + '/') || !existsSync(path)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream', 'cache-control': 'no-store' });
    const raw = await readFile(path, 'utf8');
    response.end(extname(name) === '.html' ? inlineCommonHtml(raw) : raw);
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
        const ready = await send('Runtime.evaluate', {expression: '!!document.querySelector("#widget-root > *, #root .fh-select")', returnByValue:true});
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
  const properties = ${JSON.stringify(PROPERTIES)};
  const capture = (element, pseudo) => {
    if (!element) return null;
    const style = getComputedStyle(element, pseudo || undefined);
    return Object.fromEntries(properties.map(property => [property, style[property]]));
  };
  const out = {};
  const all = [...document.querySelectorAll('.fh-select')];
  // 只量当前可见的下拉：隐藏面板/未打开的 dialog 里 rect 为 0，量不到真实样式。
  const shells = all.filter(shell => shell.getBoundingClientRect().width > 0);
  out.__selects = all.length;
  out.__visibleSelects = shells.length;
  const scope = shells[0] || null;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const trigger = scope?.querySelector('.fh-select__trigger');
  if (trigger) { trigger.click(); await frame(); }
  for (const selector of ${JSON.stringify(SELECTORS)}) {
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
  return out;
})()`;

const INTERACTIONS = `(async () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 30));
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const init = context => window.postMessage({type:'flowhub:widget-init',token:null,context}, '*');
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
    document.querySelectorAll('.chart-card')[1].click(); await tick();
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
    for (const page of PAGES) {
      fingerprint[page] = {};
      for (const width of WIDTHS) {
        await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await client.load(`http://127.0.0.1:${port}/${page}`);
        const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression: EXPRESSION, returnByValue: true, awaitPromise: true });
        if (exceptionDetails) throw new Error(`${page} @${width}: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        fingerprint[page][width] = result.value;
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
