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
  const search = root.querySelector('#filter').getBoundingClientRect();
  const group = root.querySelector('.fleet__filter .fh-combobox__control').getBoundingClientRect();
  return {
    width: innerWidth,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    machines: visible('.fleet__identity').length,
    layout: visible('.fleet__card').length ? 'cards' : 'table',
    cardNodes: root.querySelectorAll('.fleet__card, .fleet__cards').length,
    tableRows: visible('.fh-table tbody tr').length,
    legacyNodes: document.querySelectorAll('#discoveryPanel, .overview, .panel.fleet').length,
    controlsOverflow: controls.some(el => { const r=el.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; }),
    searchHeight: search.height,
    groupHeight: group.height,
    groupWidth: group.width,
    filterHeight: root.querySelector('.fleet__filter').getBoundingClientRect().height,
    inlineFilters: Math.abs(search.top - group.top) < 2,
    extraSearchIcon: Boolean(root.querySelector('.fleet__search-icon')),
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
      if (row.cardNodes || row.tableRows !== 2) problems.push('必须只有一套表格，不保留卡片布局');
      if (row.legacyNodes) problems.push('旧列表或导入节点残留');
      if (row.controlsOverflow) problems.push('操作控件超出视口');
      if (row.extraSearchIcon) problems.push('搜索框仍有图标');
      if (row.groupWidth < 160 || Math.abs(row.searchHeight - row.groupHeight) > 1 || row.filterHeight > row.groupHeight + 1) problems.push('分组筛选尺寸或单行布局异常');
      if (row.width > 520 && !row.inlineFilters) problems.push('搜索和分组筛选没有在同一行');
      if (row.summary !== 1) problems.push('紧凑统计缺失');
      return problems.map(problem => row.width + 'px ' + problem);
    }
  },
  {
    label: 'React 连接配置',
    show: `(async () => {
      const previous = document.querySelector('dialog.host-editor[open]');
      if (previous) {
        previous.querySelector('button[aria-label="关闭"]').click();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      }
      document.querySelector('#fleetReactRoot .fleet__row-actions button[aria-haspopup="menu"]').click();
      for (let i=0; i<100 && !document.querySelector('[role="menu"]'); i++) await new Promise(resolve=>setTimeout(resolve,20));
      const edit = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim() === '编辑' && el.getBoundingClientRect().width);
      if (!edit) throw Error('机器编辑入口缺失');
      edit.click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const connection = [...document.querySelectorAll('dialog.host-editor [role="tab"]')].find(el => el.textContent === '连接配置');
      if (!connection) throw Error('连接配置页签缺失');
      connection.click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if (!document.querySelector('#host-editor-connection-type')) throw Error('连接方式下拉框缺失');
      if (document.querySelector('.host-editor__section--connection').textContent.includes('连接类型')) throw Error('连接方式标签重复');
      const footerActions = [...document.querySelectorAll('dialog.host-editor[open] .host-editor__shell > footer button')].map(button => button.textContent.trim());
      if (footerActions.join('|') !== '测试连接|取消|保存') throw Error('连接配置页脚操作异常: ' + footerActions.join('|'));
      if (document.querySelector('.host-editor__test-bar button')) throw Error('连接测试仍留在滚动内容区');
      const authHeading = document.querySelector('.host-editor__section-head--action h3');
      const authSwitch = document.querySelector('.host-editor__section-head--action .host-editor__auth-switch');
      if (!authHeading || !authSwitch || document.querySelector('.host-editor__section-head--action p')) throw Error('认证方式切换未移到标题同行或旧说明仍在');
      if (innerWidth > 440 && Math.abs(authHeading.getBoundingClientRect().top + authHeading.getBoundingClientRect().height / 2 - authSwitch.getBoundingClientRect().top - authSwitch.getBoundingClientRect().height / 2) > 3) throw Error('认证方式与私钥／密码切换没有对齐');
      authSwitch.querySelector('[role="radio"][aria-checked="false"]').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if (!document.querySelector('#host-editor-password')) throw Error('密码认证切换失效');
      document.querySelector('.host-editor__auth-switch [role="radio"][aria-checked="false"]').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if (!['host-editor-hostname','host-editor-user','host-editor-port'].every(id => document.querySelector('label[for="' + id + '"] .fh-field__required') && document.querySelector('#' + id).required)) throw Error('SSH 必填字段缺少标记');
      const hostLabel = document.querySelector('label[for="host-editor-hostname"]').getBoundingClientRect();
      const hostInput = document.querySelector('#host-editor-hostname').getBoundingClientRect();
      if (innerWidth > 440 ? Math.abs(hostLabel.top + hostLabel.height / 2 - hostInput.top - hostInput.height / 2) > 3 || hostLabel.right >= hostInput.left : hostInput.top < hostLabel.bottom) throw Error('主机地址标签与输入框的响应式排列异常');
      const pathLabel = document.querySelector('label[for="host-editor-path"]');
      const pathRect = pathLabel.getBoundingClientRect();
      const pathTarget = document.elementFromPoint(pathRect.left + pathRect.width / 2, pathRect.top + pathRect.height / 2);
      if (pathLabel.contains(pathTarget) || getComputedStyle(pathLabel).pointerEvents !== 'none') throw Error('连接路径标签仍会接收鼠标点击');
      pathTarget.click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if (document.querySelector('#host-editor-path').getAttribute('aria-expanded') !== 'false') throw Error('点击连接路径标签打开了下拉框');
      document.querySelector('#host-editor-path').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if (document.querySelector('#host-editor-path').getAttribute('aria-expanded') !== 'true') throw Error('点击连接路径控件没有打开下拉框');
      document.querySelector('#host-editor-path-listbox')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const connectionInput = document.querySelector('#host-editor-connection-type').getBoundingClientRect();
      const authInput = authSwitch.getBoundingClientRect();
      if (innerWidth > 440 && (Math.abs(connectionInput.left - hostInput.left) > 2 || Math.abs(authInput.left - hostInput.left) > 2)) throw Error('连接方式或认证方式没有与主机地址输入框左对齐');
      document.querySelector('#host-editor-connection-type').click();
      for (let i=0; i<100 && !document.querySelector('#host-editor-connection-type-listbox'); i++) await new Promise(resolve=>setTimeout(resolve,20));
      [...document.querySelectorAll('#host-editor-connection-type-listbox [role="option"]')].find(option => option.textContent.includes('堡垒机交互会话')).click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const script = document.querySelector('#host-editor-relay-script')?.getBoundingClientRect();
      const command = document.querySelector('#host-editor-command')?.getBoundingClientRect();
      if (!script || !command || command.top - script.bottom < 8 || Math.abs(command.left - script.left) > 2) throw Error('堡垒机输入控件没有对齐或缺少间距');
      if (innerWidth > 440 && (script.width > 570 || command.width > 340)) throw Error('堡垒机输入控件过宽');
      document.querySelector('#host-editor-connection-type').click();
      for (let i=0; i<100 && !document.querySelector('#host-editor-connection-type-listbox'); i++) await new Promise(resolve=>setTimeout(resolve,20));
      [...document.querySelectorAll('#host-editor-connection-type-listbox [role="option"]')].find(option => option.textContent.includes('普通 SSH')).click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      [...document.querySelectorAll('dialog.host-editor [role="tab"]')].find(tab => tab.textContent === '基础信息').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const nameLabel = document.querySelector('label[for="host-editor-name"]');
      const nameRect = nameLabel.getBoundingClientRect();
      const nameTarget = document.elementFromPoint(nameRect.left + nameRect.width / 2, nameRect.top + nameRect.height / 2);
      nameTarget.click();
      if (nameLabel.contains(nameTarget) || document.activeElement === document.querySelector('#host-editor-name')) throw Error('点击显示名称标签仍会聚焦输入框');
      document.querySelector('#host-editor-name').click();
      if (document.activeElement !== document.querySelector('#host-editor-name')) document.querySelector('#host-editor-name').focus();
      if (document.activeElement !== document.querySelector('#host-editor-name')) throw Error('显示名称输入框无法获得焦点');
      connection.click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    })()`,
    measure: `(() => {
      const dialog=document.querySelector('dialog.host-editor[open]');
      const panel=dialog.querySelector('.host-editor__panel-grid');
      const heading=dialog.querySelector('.host-editor__section--connection h3').getBoundingClientRect();
      const trigger=dialog.querySelector('#host-editor-connection-type').getBoundingClientRect();
      return { width: innerWidth, dialogs: document.querySelectorAll('dialog[open]').length,
        overflow: dialog.scrollWidth-dialog.clientWidth, panelOverflow: panel.scrollWidth-panel.clientWidth,
        panelWidth: Math.round(panel.getBoundingClientRect().width), selectWidth: Math.round(trigger.width),
        inline: Math.abs(heading.top + heading.height/2 - trigger.top - trigger.height/2) < 2 };
    })()`,
    columns: [['宽度',r=>r.width],['弹窗数',r=>r.dialogs],['溢出',r=>r.overflow],['内容宽',r=>r.panelWidth],['下拉宽',r=>r.selectWidth],['同行',r=>r.inline]],
    check: r => r.dialogs !== 1 || r.overflow > 1 || r.panelOverflow > 1
      || (r.width > 440 ? r.selectWidth > 280 || !r.inline : r.inline || Math.abs(r.selectWidth - r.panelWidth) > 1)
      ? [r.width+'px 连接方式布局异常'] : [],
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
      document.querySelector('#fleetReactRoot .fleet__row-actions button[aria-haspopup="menu"]').click();
      await wait('[role="menu"]');
      const edit = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim() === '编辑' && el.getBoundingClientRect().width);
      if (!edit) throw Error('机器编辑入口缺失');
      edit.click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await wait('dialog.host-editor[open]');
      const monitoringTab = [...document.querySelectorAll('dialog.host-editor [role="tab"]')].find(el=>el.textContent==='监控与流量');
      const monitoringHelp = document.querySelector('dialog.host-editor .host-editor__tab-help .fh-help__trigger');
      if (!monitoringTab || !monitoringHelp || monitoringHelp.getBoundingClientRect().left - monitoringTab.getBoundingClientRect().right > 8) throw Error('监控与流量说明未贴近页签');
      [...document.querySelectorAll('dialog.host-editor [role="tab"]')].find(el=>el.textContent==='监控与流量').click();
      await wait('.monitor-workspace__sources');
      if (document.querySelector('.monitor-workspace__sources .fh-help')) throw Error('监控说明仍放在数据来源切换栏');
      const sources = [...document.querySelectorAll('.monitor-workspace__sources > button')];
      if (sources.map(button => button.id).join('|') !== 'monitor-source-collector|monitor-source-traffic|monitor-source-netdata' || sources[0].getAttribute('aria-pressed') !== 'true' || !document.querySelector('#collector-mode')) throw Error('监控来源的默认页或顺序不正确');
      document.querySelector('#monitor-source-${view}').click();
      await wait('${view === 'netdata' ? '.nd-panel' : '.ct-panel'}');
      if (document.querySelector('${view === 'netdata' ? '.nd-head' : '.ct-head'}')) throw Error('Monitoring source repeats its title');
      const footer = document.querySelector('dialog.host-editor[open] .host-editor__shell > footer');
      if (!footer || ![...footer.querySelectorAll('button')].some(button => button.textContent.trim() === '完成')) throw Error('Monitoring completion action is missing');
      ${view === 'netdata' ? `
      await wait('.host-editor__monitoring-actions button');
      const footerActions = [...footer.querySelectorAll('button')].map(button => button.textContent.trim());
      if (footerActions.join('|') !== '测试连接|保存配置|解除接入|完成') throw Error('Netdata footer actions are missing or out of order: ' + footerActions.join('|'));
      if (document.querySelector('.nd-panel .nd-config-actions')) throw Error('Netdata actions remain inside the scrollable panel');
      const completion = [...footer.querySelectorAll('button')].find(button => button.textContent.trim() === '完成').getBoundingClientRect();
      if (innerWidth > 540 && [...footer.querySelectorAll('.host-editor__monitoring-actions button')].some(button => button.getBoundingClientRect().right > completion.left)) throw Error('Netdata actions are not to the left of completion');
      const body = document.querySelector('dialog.host-editor .fh-dialog-shell__content > div');
      const checkSelect = async id => {
        const trigger = await wait('#' + id);
        trigger.scrollIntoView({ block: 'center' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        trigger.click();
        const menu = await wait('#' + id + '-listbox');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bounds = body.getBoundingClientRect();
        const popup = menu.getBoundingClientRect();
        if (popup.top < bounds.top - 2 || popup.bottom > bounds.bottom + 2) throw Error(id + ' menu escaped the editor body');
        const scrollTop = body.scrollTop;
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (Math.abs(body.scrollTop - scrollTop) > 1) throw Error(id + ' keyboard navigation scrolled the editor');
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      };
      if (!document.querySelector('#nd-range')) throw Error('Netdata single-Agent history is missing');
      await checkSelect('nd-range');
      for (let i=0; i<100 && (document.querySelector('#nd-chart')?.disabled || !document.querySelector('#nd-chart')?.value); i++) await new Promise(resolve=>setTimeout(resolve,20));
      if (!document.querySelector('#nd-chart')?.value) throw Error('Netdata metrics did not load on opening the editor');
      const chartInput = document.querySelector('#nd-chart');
      chartInput.scrollIntoView({ block: 'center' });
      chartInput.focus();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!document.querySelector('#nd-chart-listbox')) chartInput.closest('.fh-combobox').querySelector('.fh-combobox__toggle').click();
      await wait('#nd-chart-listbox');
      if (document.querySelectorAll('#nd-chart-listbox [role="option"]').length < 4) throw Error('Netdata history still shows only the CPU placeholder');
      document.querySelector('#nd-chart').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const trend = [...document.querySelectorAll('.nd-section button')].find(button => button.textContent.trim() === '查看曲线');
      if (!trend?.closest('.nd-history-title') || document.querySelector('.nd-history-title small')) throw Error('Netdata history action is not in the heading');
      trend.click();
      await wait('#nd-history-chart:not([hidden]) .nd-chart');
      const historySvg = document.querySelector('.nd-chart .fh-time-series svg');
      const historyRect = historySvg.getBoundingClientRect();
      historySvg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: historyRect.left + historyRect.width * .45, clientY: historyRect.top + historyRect.height * .5 }));
      await wait('.nd-chart .fh-time-series__tooltip');
      if (!document.querySelector('.nd-chart .fh-time-series__cursor line') || !document.querySelector('.nd-chart .fh-time-series__tooltip time')) throw Error('Netdata curve has no hover crosshair or timestamp');
      historySvg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: historyRect.right - 2, clientY: historyRect.top + historyRect.height * .5 }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const tipRect = document.querySelector('.nd-chart .fh-time-series__tooltip').getBoundingClientRect();
      if (tipRect.left < 0 || tipRect.right > innerWidth) throw Error('Netdata hover tooltip overflows the viewport');
      if (trend.textContent.trim() !== '收起曲线') throw Error('Netdata history cannot collapse');
      trend.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!document.querySelector('#nd-history-chart')?.hidden || trend.textContent.trim() !== '展开曲线') throw Error('Netdata history did not collapse');
      trend.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (document.querySelector('#nd-history-chart')?.hidden) throw Error('Netdata history did not reopen');
      if (footerActions.includes('还原')) throw Error('Netdata still shows a redundant reset action');
      if (document.querySelector('#nd-network').getBoundingClientRect().width > 422) throw Error('Netdata network field is too wide');
      const agentLabel = document.querySelector('label[for="nd-name"]').getBoundingClientRect();
      const agentInput = document.querySelector('#nd-name').getBoundingClientRect();
      if (innerWidth > 440 ? Math.abs(agentLabel.top + agentLabel.height / 2 - agentInput.top - agentInput.height / 2) > 3 || agentLabel.right >= agentInput.left : agentInput.top < agentLabel.bottom) throw Error('Agent 名称标签与输入框的响应式排列异常');
      if (!['nd-name','nd-url'].every(id => document.querySelector('label[for="' + id + '"] .fh-field__required') && document.querySelector('#' + id).required)) throw Error('Agent 必填字段缺少标记');
      const networkLabel = document.querySelector('label[for="nd-network"]').getBoundingClientRect();
      const networkInput = document.querySelector('#nd-network').getBoundingClientRect();
      if (innerWidth > 440 ? Math.abs(networkLabel.top + networkLabel.height / 2 - networkInput.top - networkInput.height / 2) > 3 || networkLabel.right >= networkInput.left : networkInput.top < networkLabel.bottom) throw Error('网速指标标签与下拉框的响应式排列异常');
      if (Math.abs(networkInput.left - agentInput.left) > 2) throw Error('网速指标下拉框未与 Agent 名称输入框对齐');
      if ([...document.querySelectorAll('dialog.host-editor .fh-combobox__control > svg:first-child')].some(icon => getComputedStyle(icon).display !== 'none')) throw Error('机器编辑器的下拉框仍显示放大镜');
      const install = document.querySelector('details.nd-install');
      const installHelp = document.querySelector('.nd-install__help button[aria-label="安装说明"]');
      if (!installHelp || !installHelp.getBoundingClientRect().width || document.querySelector('.nd-install__body .nd-note')) throw Error('安装区说明未移到可见的帮助入口');
      installHelp.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!document.querySelector('[role="region"][aria-label="安装说明"]') || install.open) throw Error('安装说明不可独立打开');
      installHelp.click();
      install.open = true;
      const port = await wait('#nd-port');
      if (port.type !== 'text' || document.querySelector('.nd-install .fh-number-input')) throw Error('Netdata port still has steppers');
      if (!document.querySelector('label[for="nd-port"] .fh-field__required') || !port.required) throw Error('安装端口缺少必填标记');
      if (port.getBoundingClientRect().width > 340) throw Error('Netdata port field is too wide');
      await checkSelect('nd-disk');
      document.querySelector('#monitor-source-traffic').click();
      await wait('.ct-panel');
      if ([...footer.querySelectorAll('button')].map(button => button.textContent.trim()).join('|') !== '查询流量|保存配置|完成') throw Error('Cloud traffic footer actions did not replace Netdata actions');
      document.querySelector('#monitor-source-netdata').click();
      await wait('.host-editor__monitoring-actions button');
      document.querySelector('#monitor-source-collector').click();
      await wait('#collector-mode');
      if ([...footer.querySelectorAll('button')].map(button => button.textContent.trim()).join('|') !== '保存采集来源|完成') throw Error('Per-machine collector actions are missing');
      document.querySelector('#collector-mode').click();
      await wait('#collector-mode-listbox');
      [...document.querySelectorAll('#collector-mode-listbox [role="option"]')].find(option => option.textContent.includes('Node Exporter')).click();
      await wait('#collector-url');
      if (![...footer.querySelectorAll('button')].some(button => button.textContent.trim() === '测试 Exporter')) throw Error('Exporter test is missing from per-machine editor');
      document.querySelector('#monitor-source-netdata').click();
      await wait('.nd-panel');
      ` : ''}
      ${view === 'traffic' ? `
      if ([...footer.querySelectorAll('button')].map(button => button.textContent.trim()).join('|') !== '查询流量|保存配置|完成' || document.querySelector('.ct-panel .ct-actions')) throw Error('Cloud traffic actions are not exclusively in the footer');
      const providerLabel = document.querySelector('label[for="ct-provider"]').getBoundingClientRect();
      const providerInput = document.querySelector('#ct-provider').getBoundingClientRect();
      if (innerWidth > 440 ? Math.abs(providerLabel.top + providerLabel.height / 2 - providerInput.top - providerInput.height / 2) > 3 || providerLabel.right >= providerInput.left : providerInput.top < providerLabel.bottom) throw Error('服务商标签与下拉框的响应式排列异常');
      const providerHelp = document.querySelector('.ct-provider .fh-help__trigger');
      const providerHelpRect = providerHelp?.getBoundingClientRect();
      if (!providerHelpRect || providerHelpRect.left < providerLabel.left + 35 || providerHelpRect.left > providerLabel.left + 90 || Math.abs(providerHelpRect.top + providerHelpRect.height / 2 - providerLabel.top - providerLabel.height / 2) > 6) throw Error('服务商说明未贴近服务商标签');
      providerHelp.click();
      await wait('[role="region"][aria-label="服务商说明"]');
      providerHelp.click();
      const secretLabel = document.querySelector('label[for="ct-secretId"]').getBoundingClientRect();
      const secretInput = document.querySelector('#ct-secretId').getBoundingClientRect();
      if (secretInput.top < secretLabel.bottom) throw Error('长凭证标签不应挤在输入框同一行');
      if (!['ct-region','ct-instanceId'].every(id => document.querySelector('label[for="' + id + '"] .fh-field__required') && document.querySelector('#' + id).required) || document.querySelector('label[for="ct-secretId"] .fh-field__required')) throw Error('云流量必填标记与服务商规则不一致');
      ` : ''}
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
    for (const theme of ['dark', 'light']) for (const width of [1400, 600, 380]) {
      const themeResult = await client.send('Runtime.evaluate', { expression: `(() => { if (document.documentElement.dataset.theme !== '${theme}') document.querySelector('#themeSwitch').click(); return document.documentElement.dataset.theme === '${theme}' && localStorage.getItem('flowhub.theme') !== '${theme === 'light' ? 'dark' : 'light'}'; })()`, returnByValue: true });
      if (!themeResult.result.value) throw Error('Theme switching or persistence failed');
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const navigation = await client.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const roots = ['fleet', 'command', 'history'].map(name => document.getElementById(name + 'ReactRoot'));
        const tabs = [...document.querySelectorAll('.machine-tabs [role="tab"]')];
        if (tabs.some(tab => !tab.title)) throw Error('Page tabs must expose help on hover');
        if (document.querySelector('.command-react__head, .history-react__head')) throw Error('Redundant page headings remain');
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
        for (let attempt = 0; attempt < 50 && !document.querySelector('#command-targets')?.value; attempt++) await frame();
        document.querySelector('.command-react__targets .fh-combobox__toggle').click(); await frame();
        const commandChoice = document.querySelector('#command-targets-listbox [aria-selected="true"]');
        if (!commandChoice) throw Error('Fleet selection did not reach command page');
        commandChoice.click(); await frame();
        if (document.querySelector('#command-targets').getAttribute('aria-expanded') !== 'true') throw Error('Multi selection should keep menu open');
        document.querySelector('#command-targets').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); await frame();
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
        const templateTab = document.querySelector('.command-react__subtabs [data-tabs-value="templates"]');
        templateTab.click(); await frame();
        const manager = document.querySelector('.command-react__template-manager');
        if (manager.querySelector('h3')) throw Error('Command template tab repeats its title');
        const templateButton = text => [...manager.querySelectorAll('button')].find(button => button.textContent === text);
        if (manager.querySelector('input, textarea')) throw Error('Templates should start as compact summaries');
        templateButton('编辑').click(); await frame();
        if (manager.querySelectorAll('dialog[open] form').length !== 1) throw Error('Expected one template dialog');
        templateButton('取消').click(); await frame();
        if (manager.querySelector('form')) throw Error('Template cancel did not close editor');
        templateButton('新建模板').click(); await frame();
        templateButton('保存模板').click(); await frame();
        if (!manager.querySelector('[role="alert"]') || !manager.querySelector('form')) throw Error('Invalid template must retain editor');
        templateButton('取消').click(); await frame();
        templateButton('编辑').click(); await frame();
        templateButton('保存模板').click(); await frame();
        for (let attempt = 0; attempt < 50 && manager.querySelector('form'); attempt++) await frame();
        if (manager.querySelector('form')) throw Error('Template save did not close editor');
        document.querySelector('.command-react__subtabs [data-tabs-value="execute"]').click(); await frame();
        showTab('fleet'); await frame(); verify(0);
        for (const selector of ['#monitorSettingsReactRoot button', '#openBackup']) {
          const trigger = document.querySelector(selector);
          trigger.focus(); trigger.click(); await frame();
          const dialogs = [...document.querySelectorAll('dialog[open]')];
          if (dialogs.length !== 1) throw Error('Expected one settings dialog');
          if ([...dialogs[0].querySelectorAll('[role="tab"]')].some(tab => parseFloat(getComputedStyle(tab).fontSize) < 14 || tab.getBoundingClientRect().height < 44)) throw Error('Dialog tabs are too small');
          if (selector.includes('monitorSettingsReactRoot')) {
            if (!dialogs[0].querySelector('#monitor-interval') || !dialogs[0].querySelector('#monitor-retention') || dialogs[0].querySelector('.monitor-settings__source')) throw Error('Global monitoring settings still contain per-machine collector fields');
            if (document.querySelector('#fleetReactRoot #interval, #fleetReactRoot #monitor')) throw Error('Global monitoring controls remain in the machine toolbar');
            const helpButton = dialogs[0].querySelector('button[aria-label="历史保留说明"]');
            const help = helpButton?.getBoundingClientRect();
            const label = dialogs[0].querySelector('label[for="monitor-retention"]')?.getBoundingClientRect();
            if (!help || !label || help.left - label.left > 150 || Math.abs(help.top + help.height / 2 - label.top - label.height / 2) > 8) throw Error('Retention help is not beside its label');
            helpButton.click(); await frame();
            const helpPanel = dialogs[0].querySelector('[role="region"][aria-label="历史保留说明"]');
            const helpBounds = helpPanel?.getBoundingClientRect();
            if (!helpBounds || helpBounds.left < 0 || helpBounds.right > innerWidth || helpBounds.top < 0 || helpBounds.bottom > innerHeight) throw Error('Retention help panel is outside the viewport: ' + JSON.stringify(helpBounds?.toJSON()) + ' in ' + innerWidth + '×' + innerHeight);
            const shown = document.elementFromPoint(helpBounds.left + helpBounds.width / 2, helpBounds.top + helpBounds.height / 2);
            if (shown !== helpPanel && !helpPanel.contains(shown)) throw Error('Retention help panel is clipped or covered');
            [...dialogs[0].querySelectorAll('[role="tab"]')].find(tab => tab.textContent.trim() === '历史曲线').click();
            await frame();
            [...dialogs[0].querySelectorAll('button')].find(button => button.textContent.trim() === '查看曲线').click();
            for (let attempt=0; attempt<50 && !dialogs[0].querySelector('.fh-time-series svg'); attempt++) await frame();
            const svg = dialogs[0].querySelector('.fh-time-series svg');
            if (!svg) throw Error('Local monitoring chart missing');
            const bounds = svg.getBoundingClientRect();
            svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bounds.left + bounds.width * .5, clientY: bounds.top + bounds.height * .5 }));
            await frame();
            if (!dialogs[0].querySelector('.fh-time-series__tooltip time, .fh-time-series__cursor line')) throw Error('Local monitoring chart hover is missing');
          }
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
        const editorHeader = document.querySelector('.host-editor__shell > header');
        if (!editorHeader || editorHeader.getBoundingClientRect().height > 90) throw Error('Host editor header is too tall');
        if (editorHeader.textContent.includes('MACHINE / HOST EDITOR') || editorHeader.textContent.includes('上层受控')) throw Error('Host editor retains developer copy');
        if (!editorHeader.querySelector('button[aria-label="机器字段说明"]')) throw Error('Host editor help missing');
        const editor = document.querySelector('dialog.host-editor[open]');
        const editorSize = () => {
          const {width, height} = editor.getBoundingClientRect();
          return {width, height};
        };
        const initialSize = editorSize();
        for (const name of ['连接配置', '监控与流量', '基础信息']) {
          [...editor.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === name).click();
          await frame();
          const nextSize = editorSize();
          if (Math.abs(nextSize.width - initialSize.width) > 1 || Math.abs(nextSize.height - initialSize.height) > 1) {
            throw Error('Host editor size changed on ' + name + ': ' + JSON.stringify({initialSize, nextSize}));
          }
          const footer = editor.querySelector('footer').getBoundingClientRect();
          if (footer.bottom > innerHeight + 1) throw Error('Host editor footer escaped the viewport');
        }
        if (!document.querySelector('label[for="host-editor-name"]')?.textContent.startsWith('显示名称') || document.querySelector('#host-editor-alias')) throw Error('Basic information must not contain connection alias');
        if (!document.querySelector('label[for="host-editor-name"] .fh-field__required') || !document.querySelector('#host-editor-name').required) throw Error('显示名称缺少必填标记');
        const nameLabel = document.querySelector('label[for="host-editor-name"]').getBoundingClientRect();
        const nameInput = document.querySelector('#host-editor-name').getBoundingClientRect();
        if (innerWidth > 440 ? Math.abs(nameLabel.top + nameLabel.height / 2 - nameInput.top - nameInput.height / 2) > 3 || nameLabel.right >= nameInput.left : nameInput.top < nameLabel.bottom) throw Error('显示名称标签与输入框的响应式排列异常');
        const expiryLabel = document.querySelector('label[for="host-editor-expires-local"]').getBoundingClientRect();
        const expiryInput = document.querySelector('#host-editor-expires-local').getBoundingClientRect();
        if (document.querySelector('label[for="host-editor-expires-local"]').textContent.trim() !== '到期时间' || document.querySelector('label[for="host-editor-expires-local"] .fh-field__required') || document.querySelector('#host-editor-expires-local').required) throw Error('到期时间应为无可选后缀的非必填字段');
        if (innerWidth > 440 ? Math.abs(expiryLabel.top + expiryLabel.height / 2 - expiryInput.top - expiryInput.height / 2) > 3 || expiryLabel.right >= expiryInput.left : expiryInput.top < expiryLabel.bottom) throw Error('到期时间标签与选择器的响应式排列异常');
        if (!document.querySelector('.host-editor__basic') || document.querySelector('.host-editor__tab-panel h3')) throw Error('Basic tab repeats its title');
        if ([...editor.querySelectorAll('[role="tab"]')].some(tab => parseFloat(getComputedStyle(tab).fontSize) < 13 || tab.getBoundingClientRect().height < 44)) throw Error('Host editor tabs are too small');
        const country = document.querySelector('#host-editor-country');
        if (country?.getAttribute('role') !== 'combobox') throw Error('Country must be searchable');
        if (getComputedStyle(country.closest('.fh-combobox').querySelector('.fh-combobox__control > svg')).display !== 'none') throw Error('机器编辑器的下拉框仍显示放大镜');
        const filterCountry = async (text) => {
          country.focus();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(country, text);
          country.dispatchEvent(new Event('input', {bubbles:true}));
          await frame();
        };
        for (const query of ['新加坡', 'SG', 'Singapore']) {
          await filterCountry(query);
          const options = document.querySelectorAll('#host-editor-country-listbox [role="option"]');
          if (options.length !== 1 || options[0].textContent !== '新加坡') throw Error('Country search failed: ' + query);
        }
        country.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',isComposing:true,bubbles:true,cancelable:true})); await frame();
        if (country.getAttribute('aria-expanded') !== 'true') throw Error('IME Enter must not select');
        country.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true})); await frame();
        if (country.value !== '新加坡' || country.getAttribute('aria-expanded') !== 'false') throw Error('Keyboard country selection failed');
        await filterCountry('no-such-country');
        if (!document.querySelector('#host-editor-country-listbox')?.textContent.includes('没有匹配')) throw Error('Missing empty search feedback');
        country.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true})); await frame();
        if (!document.querySelector('dialog.host-editor[open]') || country.value !== '新加坡') throw Error('Escape should cancel search, not close editor or change country');
        await filterCountry('不设置');
        document.querySelector('#host-editor-country-listbox [role="option"]').click(); await frame();
        if (country.value !== '不设置') throw Error('Country clear option missing');
        const connectionTab = () => [...document.querySelectorAll('dialog.host-editor [role="tab"]')].find(button => button.textContent === '连接配置');
        connectionTab().click(); await frame();
        if (document.querySelector('#host-editor-alias')) throw Error('Ordinary SSH should not ask for an alias');
        document.querySelector('dialog.host-editor button[aria-label="关闭"]').click(); await frame();
        more.click(); await frame();
        [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === '复制').click(); await frame();
        for (let attempt = 0; attempt < 50 && !document.querySelector('#host-editor-name')?.value.endsWith('副本'); attempt++) await frame();
        if (!document.querySelector('#host-editor-name')?.value.endsWith('副本')) throw Error('Copy machine did not reset name');
        connectionTab().click(); await frame();
        if (document.querySelector('#host-editor-alias')) throw Error('Copied SSH machine should not ask for an alias');
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
