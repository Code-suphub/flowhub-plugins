// 机器管理页面的布局度量。
//
// 用 machines.html 的真实骨架 + 真实 CSS 加载顺序，在 headless Chrome 里量几件
// 容易悄悄回退的事：表格是否溢出、首列是否与面板其它文字对齐、概况栏在窄窗是否
// 换行、工具栏控件高度是否一致、页面头部的 gap 有没有被别的样式表改写。
//
// 加载真实 React 构建和隔离的模拟适配器，不连接真实机器。
//   node scripts/layout-audit.mjs            # 打印各断点的数字
//   node scripts/layout-audit.mjs --check    # 断言阈值，超了 exit 1
//   node scripts/layout-audit.mjs --json     # 只输出 JSON
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ui = resolve(here, '..', 'ui');
const WIDTHS = [1400, 1024, 850, 600, 380];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function fixture() {
  execFileSync('npm', ['run', 'build:fleet'], { cwd: resolve(here, '..'), stdio: 'pipe' });
  const { inlineCommonHtml } = await import('../../../scripts/inline-common.mjs');
  return inlineCommonHtml((await readFile(join(ui, 'machines.html'), 'utf8'))
    .replace('<script src="plugin-bridge.js">', '<script src="/__preview.js"></script><script src="plugin-bridge.js">')
    .replace('<link data-flowhub-fleet rel="stylesheet">', '<link rel="stylesheet" href="/react/fleet.css">')
    .replace('<script data-flowhub-fleet></script>', '<script src="/react/fleet.js"></script>'));
}

const HELPERS = 'const one = selector => document.querySelector(selector);';
const MEASURE_FLEET = `(() => {
  const root = document.querySelector('#fleetReactRoot');
  const visible = selector => [...root.querySelectorAll(selector)].filter(el => el.getBoundingClientRect().width > 0);
  const controls = visible('#filter, #group, #interval, #addHost');
  return {
    width: innerWidth,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    machines: visible('.fleet__identity').length,
    layout: visible('.fleet__card').length ? 'cards' : 'table',
    legacyNodes: document.querySelectorAll('#discoveryPanel, .overview, .panel.fleet').length,
    controlsOverflow: controls.some(el => { const r=el.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; }),
    summary: visible('.fleet__summary').length
  };
})()`;

const MEASURE_DIALOG_FAMILY = `(() => {
 ${HELPERS}
  const box = element => element ? element.getBoundingClientRect() : null;
  const sizeOf = element => { const rect = box(element); return rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null; };
  const shells = window.__auditDialogs || {};
  shells.netdata.showModal();
  shells.traffic.showModal();
  const measure = element => { const rect = sizeOf(element); return rect ? rect.w + 'x' + rect.h : null; };
  const rows = {
    width: Math.round(document.documentElement.clientWidth),
    height: Math.round(document.documentElement.clientHeight),
    netdata: measure(shells.netdata),
    traffic: measure(shells.traffic)
  };
  const expected = Math.round(Math.min(document.documentElement.clientHeight - 24, 920));
  rows.expected = expected;
  shells.netdata.close();
  shells.traffic.close();
  return rows;
})()`;

/** '820x776' → 820 */
const widthPart = value => Number(String(value).split('x')[0]);
/** '820x776' → 776 */
const heightPart = value => Number(String(value).split('x')[1]);

const VIEWS = [
  {
    label: 'React 机器列表',
    show: "window.FlowHubMachineTabs.show('fleet');",
    measure: MEASURE_FLEET,
    columns: [['宽度', row => row.width], ['页溢出', row => row.pageOverflow], ['机器', row => row.machines], ['布局', row => row.layout], ['旧节点', row => row.legacyNodes]],
    check: row => {
      const problems = [];
      if (row.pageOverflow > 0) problems.push('页面横向溢出');
      if (row.machines !== 2) problems.push('模拟机器未正确显示');
      if (row.legacyNodes) problems.push('旧列表或导入节点残留');
      if (row.controlsOverflow) problems.push('操作控件超出视口');
      if (row.summary !== 1) problems.push('紧凑统计缺失');
      return problems.map(problem => row.width + 'px ' + problem);
    }
  },
  {
    label: '弹窗尺寸一致性',
    // Netdata / 云流量仍由旧静态样式驱动；React 机器编辑器由组件测试与浏览器验证覆盖。
    //  - 宽度：.netdata-dialog 的 min(820px,94vw)。谁单独写死一个更小的值，宽窗口下就会比兄弟弹窗窄
    //    （云流量曾单独写 780px，比另两个窄 40px）。
    //  - 高度：撑满 min(calc(100vh - 24px),920px)。.netdata-dialog 只有 max-height:88vh，没有 height，
    //    于是会按内容长度“长一半就停”（云流量曾只有 480px，而编辑机器 522px，正文被压到 314px 并出现滚动条）。
    sizes: [[1400, 900], [760, 900], [660, 700], [1200, 800], [718, 546]],
    // 云流量和 Netdata 的弹窗由脚本动态创建，而审计页不加载脚本，这里只放一个同样带类名的空壳：
    // 量的是 CSS 给这个家族的宽高，与弹窗内容无关。
    show: "for (const p of document.querySelectorAll('[role=\"tabpanel\"]')) p.hidden = p.id !== 'fleetPanel';",
    prepare: `(() => {
      const add = (name, className, title) => {
        let dialog = document.querySelector('dialog.audit-' + name);
        if (!dialog) {
          dialog = document.createElement('dialog');
          dialog.className = 'netdata-dialog audit-shell audit-' + name + (className ? ' ' + className : '');
          dialog.innerHTML = '<div class="section-head"><h2>' + title + '</h2><button type="button" data-close>关闭</button></div>';
          document.body.append(dialog);
        }
        return dialog;
      };
      window.__auditDialogs = { netdata: add('netdata', '', 'Netdata 监控'), traffic: add('traffic', 'traffic-dialog', '云流量') };
    })()`,
    measure: MEASURE_DIALOG_FAMILY,
    columns: [
      ['视口', row => `${row.width}x${row.height}`],
      ['应达高度', row => `${row.expected}`],
      ['Netdata', row => `${row.netdata}`],
      ['云流量', row => `${row.traffic}`]
    ],
    check: row => {
      const problems = [];
      const values = [['Netdata', row.netdata], ['云流量', row.traffic]];
      const limit = Math.min(Math.round(row.width * 0.94), 820);
      for (const [label, value] of values) {
        if (value === null) { problems.push(`${row.width}px ${label}弹窗量不到尺寸`); continue; }
        const width = widthPart(value);
        const height = heightPart(value);
        if (width < Math.min(row.width * 0.94, 820) - 1) problems.push(`${row.width}px ${label}弹窗只有 ${width}px 宽，窄于设计上限 ${limit}px`);
        // Netdata 面板内容是自适应的，只约束宽度；云流量使用满可用高度。
        if (label !== 'Netdata' && height < row.expected - 1) problems.push(`${row.width}x${row.height} ${label}弹窗只有 ${height}px 高，未撑满可用高度 ${row.expected}px`);
      }
      const widths = values.map(([, value]) => widthPart(value));
      if (widths.every(Number.isFinite)) {
        const spread = Math.max(...widths) - Math.min(...widths);
        if (spread > 0 && row.width * 0.94 > 820) problems.push(`${row.width}px 三个弹窗宽度不一致，相差 ${spread}px：${values.map(([label, value]) => label + ' ' + value).join(' / ')}`);
      }
      return problems;
    }
  },

];

function table(lines, head) {
  const widths = head.map((_, column) => Math.max(...lines.map(line => String(line[column]).length)));
  for (const line of [head, ...lines]) console.log(line.map((cell, column) => String(cell).padEnd(widths[column])).join('  '));
}

function serve(bodies) {
  const server = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '') || '__audit.html';
    const body = bodies.get(name);
    if (body !== undefined) {
      response.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(body);
      return;
    }
    const path = resolve(ui, name);
    if (!path.startsWith(ui) || !existsSync(path)) { response.writeHead(404).end(); return; }
    const bytes = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(bytes);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function cdp(url, onEvent) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.method || ''})`));
      else done(message.result);
      return;
    }
    onEvent?.(message);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时`)); }, 15000);
      });
    },
    close() { socket.close(); }
  };
}

async function launch(chrome) {
  const profile = await mkdtemp(join(tmpdir(), 'flowhub-layout-audit-'));
  const child = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!existsSync(portFile)) {
    child.kill('SIGKILL');
    throw new Error(`Chrome 未能启动${stderr ? `：${stderr.split('\n')[0]}` : ''}`);
  }
  const [port] = (await readFile(portFile, 'utf8')).split('\n');
  return { child, profile, port: Number(port) };
}

async function main() {
  const check = process.argv.includes('--check');
  const jsonOnly = process.argv.includes('--json');
  const chrome = CHROME_CANDIDATES.find(candidate => existsSync(candidate));
  if (!chrome) {
    if (!jsonOnly) console.log('跳过布局度量：没有找到 Chrome（可用 CHROME_PATH 指定）');
    if (jsonOnly) console.log('{"skipped":"no-chrome"}');
    return;
  }
  const bodies = new Map([['__audit.html', await fixture()],
    ['__preview.js', await readFile(resolve(here, '../dev/machines-preview.js'))],
    ['react/fleet.js', await readFile(resolve(here, '../build/ui/react/fleet.js'))],
    ['react/fleet.css', await readFile(resolve(here, '../build/ui/react/fleet.css'))]
  ]);
  const server = await serve(bodies);
  const { port: pagePort } = server.address();
  const launched = await launch(chrome);
  let client;
  try {
    // 需要 page target 的 WebSocket：浏览器级端点没有 Page/Runtime 域。
    let target = null;
    for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
      const targets = await fetch(`http://127.0.0.1:${launched.port}/json/list`).then(response => response.json()).catch(() => []);
      target = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl) || null;
      if (!target) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!target) throw new Error('没有找到可用的页面调试目标');
    let loaded;
    const loadedPromise = new Promise(resolve => { loaded = resolve; });
    client = await cdp(target.webSocketDebuggerUrl, message => {
      if (message.method === 'Page.loadEventFired') loaded();
    });
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/__audit.html` });
    await loadedPromise;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const { result } = await client.send('Runtime.evaluate', { expression: "document.querySelectorAll('.fleet__identity').length >= 2", returnByValue: true });
      if (result.value) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('React 机器列表未挂载');


    const report = [];
    const failures = [];
    for (const view of VIEWS) {
      const rows = [];
      for (const size of (view.sizes || WIDTHS.map(width => [width, 900]))) {
        await client.send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
        await client.send('Runtime.evaluate', { expression: view.show, returnByValue: true });
        if (view.prepare) await client.send('Runtime.evaluate', { expression: view.prepare, returnByValue: true });
        await new Promise(resolve => setTimeout(resolve, 60));
        const { result } = await client.send('Runtime.evaluate', { expression: view.measure, returnByValue: true });
        rows.push(result.value);
        failures.push(...view.check(result.value).map(problem => `[${view.label}] ${problem}`));
      }
      report.push({ label: view.label, columns: view.columns, rows });
    }

    if (jsonOnly) {
      console.log(JSON.stringify({ report, failures }, null, 2));
    } else {
      for (const view of report) {
        console.log(`\n== ${view.label} ==`);
        table(view.rows.map(row => view.columns.map(([, get]) => get(row))), view.columns.map(([label]) => label));
      }
      console.log(failures.length ? `\n${failures.length} 处不符合预期：\n- ${failures.join('\n- ')}` : '\n所有视图的所有断点符合预期');
    }
    if (check && failures.length) process.exitCode = 1;
  } finally {
    client?.close();
    launched.child.kill('SIGKILL');
    await new Promise(resolve => {
      if (launched.child.exitCode !== null || launched.child.signalCode !== null) { resolve(); return; }
      launched.child.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
    server.close();
    // Chrome 退出时还在写 profile，删除失败不影响度量结果。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(launched.profile, { recursive: true, force: true }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
  }
}

main().catch(error => { console.error(`布局度量失败：${error.message}`); process.exitCode = 1; });
