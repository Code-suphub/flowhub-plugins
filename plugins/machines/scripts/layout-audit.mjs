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

const HELPERS = `
  const one = (selector) => document.querySelector(selector);
  const contentLeft = (element) => {
    const box = element && element.getBoundingClientRect();
    if (!box) return null;
    const style = getComputedStyle(element);
    return Math.round((box.left + (parseFloat(style.borderLeftWidth) || 0) + parseFloat(style.paddingLeft || '0')) * 10) / 10;
  };
  const height = (selector) => {
    const element = one(selector);
    const box = element && element.getBoundingClientRect();
    return box ? Math.round(box.height * 10) / 10 : null;
  };
  // 元素往上数有几层带可见边框的容器：卡片套卡片会在这里露出来。
  const borderDepth = (element) => {
    if (!element) return null;
    let count = (parseFloat(getComputedStyle(element).borderTopWidth) || 0) > 0 ? 1 : 0;
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none') continue;
      const widths = ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(style['border' + side + 'Width']) || 0);
      if (widths.some(width => width > 0)) count += 1;
    }
    return count;
  };
  const tooltips = (selectors) => selectors.map(selector => {
    const element = one(selector);
    if (!element) return null;
    const wasHidden = element.hidden;
    element.hidden = false;
    const box = element.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const overflow = Math.round(Math.max(0, -box.left) + Math.max(0, box.right - viewport));
    const side = box.left < 0 ? 'left' : box.right > viewport ? 'right' : 'inside';
    element.hidden = wasHidden;
    return { selector, overflow, side };
  }).filter(Boolean);
`;

const MEASURE_FLEET = `(() => {
${HELPERS}
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
      const visible = actionsBox ? Math.max(0, Math.round(Math.min(actionsBox.right, wrapBox.right) - Math.max(actionsBox.left, machineBox.right))) : null;
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
    mastheadGap: masthead ? getComputedStyle(masthead).gap : null
  };
})()`;

const MEASURE_DISCOVERY = `(() => {
${HELPERS}
  return {
    width: Math.round(document.documentElement.clientWidth),
    pageOverflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
    tooltips: tooltips(['#discoveryHelpText']).filter(tip => tip.overflow > 0).map(tip => tip.selector + ':' + tip.side + tip.overflow).join(' ') || 'ok',
    rowsScrolls: (() => { const rows = one('#discoveryRows'); return rows ? rows.scrollHeight > rows.clientHeight : null; })()
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
    label: '机器列表',
    show: "document.querySelector('#fleetPanel').hidden=false;document.querySelector('#commandPanel').hidden=true;document.querySelector('#discoveryPanel').hidden=true;",
    measure: MEASURE_FLEET,
    columns: [
      ['宽度', row => `${row.width}`], ['页溢出', row => `${row.pageOverflow}`], ['表宽', row => `${row.tableWidth}`],
      ['表溢出', row => `${row.tableOverflow}`], ['首列偏差', row => `${row.firstColumnDelta}`],
      ['滚到底见机器名', row => `${row.machineColumnVisibleAtRight === null ? '—' : row.machineColumnVisibleAtRight ? '是' : '否'}(${row.actionsVisibleAtRight}/${row.actionsWidthAtRight})`],
      ['概况行×列', row => `${row.overviewRows}×${row.overviewColumns}`], ['概况最小列', row => `${row.overviewMinColumn}`],
      ['控件高度', row => Object.entries(row.controlHeights).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(' ')],
      ['masthead gap', row => `${row.mastheadGap}`]
    ],
    check: row => {
      const problems = [];
      if (row.pageOverflow > 0) problems.push(`${row.width}px 页面横向溢出 ${row.pageOverflow}px`);
      if (row.firstColumnDelta !== null && Math.abs(row.firstColumnDelta) > 1) problems.push(`${row.width}px 表格首列与面板文字错位 ${row.firstColumnDelta}px`);
      if (row.tableOverflow > 0 && row.machineColumnVisibleAtRight === false) problems.push(`${row.width}px 横向滚动后机器名不可见`);
      if (row.actionsVisibleAtRight !== null && row.actionsWidthAtRight !== null && row.actionsVisibleAtRight < row.actionsWidthAtRight - 1) {
        problems.push(`${row.width}px 横向滚动后操作列被固定列遮住 ${row.actionsWidthAtRight - row.actionsVisibleAtRight}px`);
      }
      if (row.width <= 600 && row.overviewRows < 2) problems.push(`${row.width}px 概况栏仍未换行（${row.overviewColumns} 列一行）`);
      if (row.mastheadGap !== 'normal') problems.push(`${row.width}px 页面头部 gap 被外部样式表改写为 ${row.mastheadGap}`);
      const heights = [...new Set(Object.values(row.controlHeights).filter(Boolean))];
      if (heights.length > 1 && row.width > 600) problems.push(`${row.width}px 工具栏控件高度不一致：${heights.join(' / ')}`);
      return problems;
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
  {
    label: 'SSH 导入',
    show: "document.querySelector('#fleetPanel').hidden=true;document.querySelector('#commandPanel').hidden=true;document.querySelector('#discoveryPanel').hidden=false;",
    measure: MEASURE_DISCOVERY,
    columns: [
      ['宽度', row => `${row.width}`], ['页溢出', row => `${row.pageOverflow}`],
      ['气泡出界', row => `${row.tooltips}`], ['候选列表可滚动', row => `${row.rowsScrolls}`]
    ],
    check: row => {
      const problems = [];
      if (row.pageOverflow > 0) problems.push(`${row.width}px SSH 导入横向溢出 ${row.pageOverflow}px`);
      if (row.tooltips !== 'ok') problems.push(`${row.width}px 帮助气泡超出视口：${row.tooltips}`);
      return problems;
    }
  }
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
