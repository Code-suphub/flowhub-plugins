// 同一个页面加载的样式表之间不允许重复定义同一个选择器：谁生效取决于 <link> 顺序，
// 后加载的文件会把前一个文件的值悄悄改掉（backup.css 曾经就这样改写了页面头部）。
// 这里只做静态检查，不需要浏览器。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ui = path.resolve(__dirname, '..', 'ui');

function stylesheetsOf(page) {
  const html = fs.readFileSync(path.join(ui, page), 'utf8');
  return [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => match[1]);
}

function selectorsOf(file) {
  const css = fs.readFileSync(path.join(ui, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Set();
  // 先切掉 @media/@supports 的外层大括号，保留下面的普通规则。
  const flat = css.replace(/@(?:media|supports)[^{]*\{/g, '');
  for (const block of flat.matchAll(/([^{}]+)\{/g)) {
    for (const raw of block[1].split(',')) {
      const selector = raw.trim().replace(/\s+/g, ' ');
      if (!selector || selector.startsWith('@') || selector.startsWith('from') || selector.startsWith('to')) continue;
      if (/^[0-9.]+%$/.test(selector)) continue;
      found.add(selector);
    }
  }
  return found;
}

const pages = fs.readdirSync(ui).filter(name => name.endsWith('.html'));
assert.ok(pages.length >= 4, `ui 根目录下应有页面入口，实际 ${pages.length} 个`);

// 资源顺序：样式表全部在 <head>（层叠顺序一眼可见），脚本全部集中在 </body> 之前。
const orderProblems = [];
for (const page of pages) {
  const html = fs.readFileSync(path.join(ui, page), 'utf8');
  const headStart = html.indexOf('<head');
  const headEnd = html.indexOf('</head>');
  for (const match of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/g)) {
    if (match.index < headStart || match.index > headEnd) orderProblems.push(`${page}: 样式表不在 <head> 里 —— ${match[0]}`);
  }
  const hrefs = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(m => m[1]);
  const sources = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  for (const [label, list] of [['样式表', hrefs], ['脚本', sources]]) {
    const duplicated = list.filter((value, index) => list.indexOf(value) !== index);
    if (duplicated.length) orderProblems.push(`${page}: 重复引用${label} ${[...new Set(duplicated)].join(', ')}`);
  }
  const firstScript = html.search(/<script[\s>]/);
  if (firstScript >= 0) {
    const tail = html.slice(firstScript).replace(/<script[\s\S]*?<\/script>/g, '').trim();
    if (!/^(?:<\/(?:body|html)>\s*)+$/.test(tail)) orderProblems.push(`${page}: 脚本没有集中在文档末尾，末尾还留着 ${tail.slice(0, 60)}`);
  }
}
assert.deepEqual(orderProblems, [], `资源顺序问题：\n- ${orderProblems.join('\n- ')}`);

let checked = 0;
const problems = [];
for (const page of pages) {
  const files = stylesheetsOf(page);
  if (files.some(file => file.startsWith('react/'))) {
    for (const file of files.filter(file => !file.startsWith('react/'))) {
      assert.ok(fs.existsSync(path.join(ui, file)), `${page} 引用了不存在的样式表 ${file}`);
    }
    continue;
  }
  assert.ok(files.length > 0, `${page} 没有引用样式表`);
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(ui, file)), `${page} 引用了不存在的样式表 ${file}`);
  }
  const owners = new Map();
  for (const file of files) {
    for (const selector of selectorsOf(file)) {
      if (!owners.has(selector)) owners.set(selector, []);
      owners.get(selector).push(file);
      checked += 1;
    }
  }
  for (const [selector, list] of owners) {
    if (new Set(list).size > 1) problems.push(`${page}: ${selector} ← ${[...new Set(list)].join(' + ')}`);
  }
}

assert.deepEqual(problems, [], `同一页面重复定义选择器：\n- ${problems.join('\n- ')}`);
console.log(`PASS: ${pages.length} 个页面的 ${checked} 处选择器定义在各自页面内没有重复，样式表都在 <head>、脚本都集中在末尾`);
