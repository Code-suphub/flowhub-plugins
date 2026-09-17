// 机器管理页面的布局度量。
//
// 用 machines.html 的真实骨架 + 真实 CSS 加载顺序，在 headless Chrome 里量几件
// 容易悄悄回退的事：表格是否溢出、首列是否与面板其它文字对齐、概况栏在窄窗是否
// 换行、工具栏控件高度是否一致、页面头部的 gap 有没有被别的样式表改写。
//
// 不依赖 FlowHub 宿主：脚本标签会被去掉，表格塞入合成行，因此只验证 CSS/结构，
// 不代表运行时数据。没有 Chrome 时跳过（exit 0）。
//
//   node scripts/layout-audit.mjs            # 打印各断点的数字
//   node scripts/layout-audit.mjs --check    # 断言阈值，超了 exit 1
//   node scripts/layout-audit.mjs --json     # 只输出 JSON
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ui = resolve(here, '..', 'ui');
const WIDTHS = [1400, 1024, 850, 600, 420, 360];
const ROWS = 12;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function rowMarkup(index) {
  const status = ['success', 'failed', 'stale', 'unknown'][index % 4];
  const label = { success: '正常', failed: '连接失败', stale: '数据过期', unknown: '未采集' }[status];
  const pct = value => `<span class="usage-bar"><i style="width:${value}%"></i></span><small>${value}%</small>`;
  return `<tr>
    <td><input type="checkbox" aria-label="选择 machine-${index}"></td>
    <td><strong>machine-${index}</strong><small>alias-${index} / 生产环境</small></td>
    <td><span class="status ${status}">${label}</span><small>12:0${index % 10}:00</small></td>
    <td>${pct(20 + index)}</td>
    <td>${pct(30 + index)}</td>
    <td>${pct(40 + index)}</td>
    <td>${(index / 4).toFixed(2)}<small>${index} 天 3 时</small></td>
    <td><div class="host-actions"><button data-host-action="collect">采集</button><button data-host-action="edit">编辑</button><button data-host-action="more" aria-haspopup="menu">更多</button></div></td>
  </tr>`;
}

async function fixture() {
  const html = await readFile(join(ui, 'machines.html'), 'utf8');
  let body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  body = body.replace(/<script[\s\S]*?<\/script>/g, '');
  body = body.replace('<main hidden>', '<main>');
  body = body.replace(
    /<tbody id="hostRows">[\s\S]*?<\/tbody>/,
    `<tbody id="hostRows">${Array.from({ length: ROWS }, (_, index) => rowMarkup(index)).join('')}</tbody>`
  );
  const links = [...html.matchAll(/<link[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]);
  const styles = links
    .filter(href => href.endsWith('.css'))
    .map(href => `<link rel="stylesheet" href="/${href}">`)
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${styles}</head>${body}</html>`;
}

const MEASURE = `(() => {
  const one = (selector) => document.querySelector(selector);
  const contentLeft = (element) => {
    const box = element && element.getBoundingClientRect();
    if (!box) return null;
    return box.left + parseFloat(getComputedStyle(element).paddingLeft || '0');
  };
  const height = (selector) => {
    const box = one(selector) && one(selector).getBoundingClientRect();
    return box ? Math.round(box.height * 10) / 10 : null;
  };
  const wrap = one('.table-wrap');
  const table = wrap && wrap.querySelector('table');
  const firstCell = one('#hostRows tr:first-child td:first-child');
  const machineCell = one('#hostRows tr:first-child td:nth-child(2)');
  const panelTitle = one('#fleetTitle');
  const overview = one('.overview');
  const columns = overview ? [...overview.children] : [];
  const masthead = one('.masthead');
  const actions = one('#hostRows tr:first-child .host-actions');
  return {
    width: Math.round(document.documentElement.clientWidth),
    pageOverflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
    tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
    tableOverflow: wrap ? Math.round(wrap.scrollWidth - wrap.clientWidth) : null,
    firstColumnDelta: firstCell && panelTitle ? Math.round((contentLeft(firstCell) - contentLeft(panelTitle)) * 10) / 10 : null,
    // 横向滚到最右时：机器名是否还在视口里，以及固定列有没有把操作列压住。
    ...(() => {
      if (!wrap || !machineCell) return { machineColumnVisibleAtRight: null, actionsVisibleAtRight: null, actionsWidthAtRight: null };
      const before = wrap.scrollLeft;
      wrap.scrollLeft = wrap.scrollWidth;
      const wrapBox = wrap.getBoundingClientRect();
      const machineBox = machineCell.getBoundingClientRect();
      const actionsBox = actions && actions.getBoundingClientRect();
      const stickyRight = machineBox.right;
      const visible = actionsBox ? Math.max(0, Math.round(Math.min(actionsBox.right, wrapBox.right) - Math.max(actionsBox.left, stickyRight))) : null;
      wrap.scrollLeft = before;
      return {
        machineColumnVisibleAtRight: machineBox.right > wrapBox.left + 1,
        actionsVisibleAtRight: visible,
        actionsWidthAtRight: actionsBox ? Math.round(actionsBox.width) : null
      };
    })(),
    overviewRows: new Set(columns.map((element) => Math.round(element.getBoundingClientRect().top))).size,
    overviewColumns: getComputedStyle(overview).gridTemplateColumns.split(' ').filter(Boolean).length,
    overviewMinColumn: columns.length ? Math.round(Math.min(...columns.map((element) => element.getBoundingClientRect().width))) : null,
    controlHeights: { filter: height('#filter'), group: height('#group'), collect: height('#collectSelected'), interval: height('#interval'), addHost: height('#addHost') },
    mastheadGap: masthead ? getComputedStyle(masthead).gap : null,
    mastheadWrap: masthead ? getComputedStyle(masthead).flexWrap : null,
    actionsWidth: actions ? Math.round(actions.getBoundingClientRect().width) : null
  };
})()`;

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
  const bodies = new Map([['__audit.html', await fixture()]]);
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

    const results = [];
    for (const width of WIDTHS) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await new Promise(resolve => setTimeout(resolve, 60));
      const { result } = await client.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      results.push(result.value);
    }

    const failures = [];
    for (const row of results) {
      if (row.pageOverflow > 0) failures.push(`${row.width}px 页面横向溢出 ${row.pageOverflow}px`);
      if (row.firstColumnDelta !== null && Math.abs(row.firstColumnDelta) > 1) failures.push(`${row.width}px 表格首列与面板文字错位 ${row.firstColumnDelta}px`);
      if (row.tableOverflow > 0 && row.machineColumnVisibleAtRight === false) failures.push(`${row.width}px 横向滚动后机器名不可见`);
      if (row.actionsVisibleAtRight !== null && row.actionsWidthAtRight !== null && row.actionsVisibleAtRight < row.actionsWidthAtRight - 1) {
        failures.push(`${row.width}px 横向滚动后操作列被固定列遮住 ${row.actionsWidthAtRight - row.actionsVisibleAtRight}px`);
      }
      if (row.width <= 600 && row.overviewRows < 2) failures.push(`${row.width}px 概况栏仍未换行（${row.overviewColumns} 列一行）`);
      const heights = [...new Set(Object.values(row.controlHeights).filter(Boolean))];
      if (heights.length > 1 && row.width > 600) failures.push(`${row.width}px 工具栏控件高度不一致：${heights.join(' / ')}`);
    }

    if (jsonOnly) {
      console.log(JSON.stringify({ results, failures }, null, 2));
    } else {
      const head = ['宽度', '页溢出', '表宽', '表溢出', '首列偏差', '滚到底见机器名', '概况行×列', '概况最小列', '控件高度', 'masthead gap'];
      const rows = results.map(row => [
        `${row.width}`, `${row.pageOverflow}`, `${row.tableWidth}`, `${row.tableOverflow}`, `${row.firstColumnDelta}`,
        `${row.machineColumnVisibleAtRight === null ? '—' : row.machineColumnVisibleAtRight ? '是' : '否'}${row.actionsVisibleAtRight !== null ? `(${row.actionsVisibleAtRight}/${row.actionsWidthAtRight})` : ''}`,
        `${row.overviewRows}×${row.overviewColumns}`, `${row.overviewMinColumn}`,
        Object.entries(row.controlHeights).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(' '),
        `${row.mastheadGap}${row.mastheadWrap === 'wrap' ? ' wrap' : ''}`
      ]);
      const widths = head.map((_, column) => Math.max(...[head, ...rows].map(line => [...line][column].length)));
      for (const line of [head, ...rows]) console.log(line.map((cell, column) => String(cell).padEnd(widths[column])).join('  '));
      console.log(failures.length ? `\n${failures.length} 处不符合预期：\n- ${failures.join('\n- ')}` : '\n所有断点符合预期');
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
