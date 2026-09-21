// 自绘下拉（select-control.js + 各页 CSS）的「计算样式指纹」。
//
// 静态组件页面的下拉样式容易在重构中漂移，机器 React 页面另由 layout-audit 覆盖。
// 这里把 `.select-shell/.select-trigger/.select-menu/[role=option]` 的计算样式（只取
// 声明性属性，不含依赖字体度量的 width/height）落成基线文件，重构后必须逐项一致。
//
//   node scripts/preview-fingerprint.mjs --write    # 重新生成基线
//   node scripts/preview-fingerprint.mjs            # 与基线比对，不一致 exit 1
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineCommonHtml } from '../../../scripts/inline-common.mjs';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ui = resolve(here, '..', 'ui');
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
const SELECTORS = ['.select-shell', '.select-trigger', '.select-trigger::after', '.select-menu', '.select-menu [role="option"]', '.select-menu [aria-selected="true"]', '.select-search'];
// React 机器页由 layout-audit 验证；这里仅覆盖仍使用静态下拉的组件页面。
const PAGES = ['widget-card.html', 'widget-detail.html'];
const WIDTHS = [1400, 700];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

function server() {
  const instance = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/^\/+/, '') || 'machines.html';
    const path = resolve(ui, name);
    if (!path.startsWith(ui) || !existsSync(path)) { response.writeHead(404).end(); return; }
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
  let nextId = 1;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
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
      await send('Page.navigate', { url });
      for (let attempt = 0; attempt < 100 && !events.includes('Page.loadEventFired'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
      await new Promise(resolve => setTimeout(resolve, 700));
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

const EXPRESSION = `(() => {
  const properties = ${JSON.stringify(PROPERTIES)};
  const capture = (element, pseudo) => {
    if (!element) return null;
    const style = getComputedStyle(element, pseudo || undefined);
    return Object.fromEntries(properties.map(property => [property, style[property]]));
  };
  // 没有宿主时页面会把 main 藏起来（显示“插件尚未启用”）；这里只为量样式而展开，
  // 不代表运行时状态。
  const page = document.querySelector('main');
  if (page) page.hidden = false;
  const unavailable = document.querySelector('#unavailable');
  if (unavailable) unavailable.hidden = true;
  for (const panel of document.querySelectorAll('[role="tabpanel"]')) panel.hidden = panel.id !== 'fleetPanel';
  const bastion = document.querySelector('#bastionWorkbench');
  if (bastion) bastion.hidden = true;

  const out = {};
  const all = [...document.querySelectorAll('.select-shell')];
  // 只量当前可见的下拉：隐藏面板/未打开的 dialog 里 rect 为 0，量不到真实样式。
  const shells = all.filter(shell => shell.getBoundingClientRect().width > 0);
  out.__selects = all.length;
  out.__visibleSelects = shells.length;
  const scope = shells[0] || null;
  for (const selector of ${JSON.stringify(SELECTORS)}) {
    const element = scope ? scope.querySelector(selector.replace('::after', '')) : null;
    out[selector] = capture(element, selector.endsWith('::after') ? '::after' : null);
  }
  const trigger = scope?.querySelector('.select-trigger');
  if (trigger) {
    trigger.click();
    const menu = scope.querySelector('.select-menu');
    if (menu && !menu.hidden) {
      out['.select-menu'] = capture(menu, null);
      out['.select-menu [role="option"]'] = capture(menu.querySelector('[role="option"]'), null);
      out['.select-menu [aria-selected="true"]'] = capture(menu.querySelector('[aria-selected="true"]'), null);
      out['.select-search'] = capture(menu.querySelector('.select-search'), null);
      out.__menuOpen = true;
      trigger.click();
    } else {
      out.__menuOpen = false;
    }
  }
  return out;
})()`;

async function main() {
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
    for (const page of PAGES) {
      fingerprint[page] = {};
      for (const width of WIDTHS) {
        await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await client.load(`http://127.0.0.1:${port}/${page}`);
        const { result } = await client.send('Runtime.evaluate', { expression: EXPRESSION, returnByValue: true });
        fingerprint[page][width] = result.value;
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
