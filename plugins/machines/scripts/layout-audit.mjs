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

const VIEWS = [
  {
    label: 'React 机器列表',
    show: "document.querySelector('.machine-tabs [data-tabs-value=\"fleet\"]').click();",
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
  ...['netdata', 'traffic'].map(view => ({
    label: view === 'netdata' ? 'React Netdata' : 'React 云流量',
    show: `(async () => {
      const wait = async (selector) => {
        for (let i=0; i<100; i++) {
          const el=document.querySelector(selector);
          if (el && el.getBoundingClientRect().width) return el;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        throw new Error('React 元素未显示：'+selector);
      };
      const previous = document.querySelector('dialog.host-editor[open]');
      if (previous) {
        previous.querySelector('button[aria-label="关闭"]').click();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      }
      const edit = [...document.querySelectorAll('#fleetReactRoot button')].find(el => el.textContent.trim() === '编辑' && el.getBoundingClientRect().width);
      if (!edit) throw Error('机器编辑入口缺失');
      edit.click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await wait('dialog.host-editor[open]');
      [...document.querySelectorAll('dialog.host-editor [role="tab"]')].find(el=>el.textContent==='监控与流量').click();
      await wait('.host-editor__monitor-card');
      const cards=[...document.querySelectorAll('.host-editor__monitor-card')];
      cards.find(el=>el.querySelector('strong')?.textContent==='${view === 'netdata' ? 'Netdata' : '云流量'}').querySelector('button').click();
      await wait('${view === 'netdata' ? '.nd-panel' : '.ct-panel'}');
    })()`,
    measure: `(() => {
      const dialog=document.querySelector('dialog.host-editor[open]');
      const panel=dialog.querySelector('${view === 'netdata' ? '.nd-panel' : '.ct-panel'}');
      return {width:innerWidth, dialogs:document.querySelectorAll('dialog[open]').length,
        old:document.querySelectorAll('.netdata-dialog,.traffic-dialog').length,
        overflow:dialog.scrollWidth-dialog.clientWidth,
        panelOverflow:panel.scrollWidth-panel.clientWidth};
    })()`,
    columns: [['宽度',r=>r.width],['弹窗数',r=>r.dialogs],['旧节点',r=>r.old],['溢出',r=>r.overflow],['面板溢出',r=>r.panelOverflow]],
    check: r => r.dialogs !== 1 || r.old || r.overflow > 1 || r.panelOverflow > 1 ? [r.width+'px React 监控面板溢出或旧弹窗残留'] : [],
  })),

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

    // Exercise the real common Tabs at desktop and narrow widths without executing commands.
    for (const width of [1400, 600, 380]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const navigation = await client.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const roots = ['fleet', 'command', 'history'].map(name => document.getElementById(name + 'ReactRoot'));
        const tabs = [...document.querySelectorAll('.machine-tabs [role="tab"]')];
        const verify = index => {
          const tab = tabs[index], panel = document.getElementById(tab.getAttribute('aria-controls'));
          if (tab.getAttribute('aria-selected') !== 'true' || panel.hidden || panel.getAttribute('aria-labelledby') !== tab.id) throw Error('Tab ARIA/visibility mismatch');
          if (tabs.filter(item => item.tabIndex === 0).length !== 1) throw Error('Tab focus order mismatch');
          if (roots.some((root, i) => document.getElementById(['fleet', 'command', 'history'][i] + 'ReactRoot') !== root)) throw Error('Navigation remounted an island');
        };
        const showTab = (name, focus = false) => { const tab = document.querySelector('.machine-tabs [data-tabs-value="' + name + '"]'); tab.click(); if (focus) tab.focus(); };
        showTab('fleet', true); await frame(); verify(0);
        const fleetChoice = document.querySelector('#fleetReactRoot input[data-select="demo-app"]');
        if (!fleetChoice) throw Error('Fleet selection missing');
        fleetChoice.click(); await frame();
        showTab('command'); await frame();
        for (let attempt = 0; attempt < 50 && !document.querySelector('.command-react__target input'); attempt++) await frame();
        const commandChoice = document.querySelector('.command-react__target input');
        if (!commandChoice?.checked) throw Error('Fleet selection did not reach command page');
        commandChoice.click(); await frame();
        showTab('fleet', true); await frame();
        if (fleetChoice.checked) throw Error('Command deselection did not reach fleet');
        for (const [key, index] of [['ArrowRight', 1], ['End', 2], ['ArrowRight', 0], ['ArrowLeft', 2], ['Home', 0]]) {
          document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
          await frame(); verify(index);
          if (document.activeElement !== tabs[index]) throw Error('Keyboard focus lost');
        }
        tabs[1].click(); await frame(); verify(1);
        const draft = document.querySelector('#commandReactRoot textarea');
        if (!draft) throw Error('Command draft input missing');
        const setDraft = value => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(draft, value);
          draft.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setDraft('audit draft — never execute'); await frame();
        showTab('history'); await frame(); verify(2);
        showTab('command'); await frame(); verify(1);
        if (document.querySelector('#commandReactRoot textarea') !== draft || draft.value !== 'audit draft — never execute') throw Error('Navigation discarded command draft');
        setDraft(''); await frame();
        showTab('fleet'); await frame(); verify(0);
        for (const selector of ['#monitorSettingsReactRoot button', '#openBackup']) {
          const trigger = document.querySelector(selector);
          trigger.focus(); trigger.click(); await frame();
          const dialogs = [...document.querySelectorAll('dialog[open]')];
          if (dialogs.length !== 1) throw Error('Expected one settings dialog');
          const close = [...dialogs[0].querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '关闭' || button.textContent.trim() === '关闭');
          if (!close) throw Error('Dialog close missing');
          close.click(); await frame();
          if (document.querySelector('dialog[open]')) throw Error('Dialog failed to close');
          if (document.activeElement !== trigger) throw Error('Dialog focus was not restored');
        }
        const more = [...document.querySelectorAll('#fleetReactRoot button')].find(button => button.getAttribute('aria-label')?.startsWith('打开 ') && button.getBoundingClientRect().width > 0);
        more.click(); await frame();
        const records = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === '采集记录');
        if (!records) throw Error('Collection menu item missing');
        records.click(); await frame();
        const collection = document.querySelector('dialog.collections[open]');
        if (!collection || !collection.textContent.includes('采集记录')) throw Error('Collection dialog did not open');
        collection.querySelector('button[aria-label="关闭"]').click(); await frame();
        if (document.querySelector('dialog[open]')) throw Error('Collection dialog failed to close');
        document.querySelector('#addHost').click(); await frame();
        for (let attempt = 0; attempt < 50 && !document.querySelector('#host-editor-name'); attempt++) await frame();
        if (document.querySelector('#host-editor-name')?.value !== '') throw Error('New machine retained old values');
        document.querySelector('dialog.host-editor button[aria-label="关闭"]').click(); await frame();
        more.click(); await frame();
        [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === '复制').click(); await frame();
        for (let attempt = 0; attempt < 50 && !document.querySelector('#host-editor-name')?.value.endsWith('副本'); attempt++) await frame();
        if (!document.querySelector('#host-editor-name')?.value.endsWith('副本') || document.querySelector('#host-editor-alias')?.value !== '') throw Error('Copy machine did not reset identity');
        document.querySelector('dialog.host-editor button[aria-label="关闭"]').click(); await frame();
        return true;
      })()` });
      if (navigation.exceptionDetails) throw new Error(navigation.exceptionDetails.exception?.description || 'React Tab 验证失败');
    }


    const report = [];
    const failures = [];
    for (const view of VIEWS) {
      const rows = [];
      for (const size of (view.sizes || WIDTHS.map(width => [width, 900]))) {
        await client.send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
        const shown = await client.send('Runtime.evaluate', { expression: view.show, returnByValue: true, awaitPromise: true });
        if (shown.exceptionDetails) throw new Error(shown.exceptionDetails.exception?.description || shown.exceptionDetails.text);
        if (view.prepare) await client.send('Runtime.evaluate', { expression: view.prepare, returnByValue: true });
        await new Promise(resolve => setTimeout(resolve, 60));
        const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression: view.measure, returnByValue: true });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
        rows.push(result.value);
        failures.push(...view.check(result.value).map(problem => `[${view.label}] ${problem}`));
      }
      report.push({ label: view.label, columns: view.columns, rows });
    }

    const widgetShell = await client.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      document.body.classList.add('widget-settings');
      try {
        const hidden = selector => getComputedStyle(document.querySelector(selector)).display === 'none';
        return hidden('.masthead') && hidden('.machine-tabs') && hidden('#fleetReactRoot') && getComputedStyle(document.querySelector('main')).display === 'block';
      } finally { document.body.classList.remove('widget-settings'); }
    })()` });
    if (widgetShell.exceptionDetails || !widgetShell.result.value) failures.push('Widget 设置模式未正确隐藏页面壳');

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
