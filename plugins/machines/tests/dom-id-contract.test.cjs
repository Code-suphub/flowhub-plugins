// 页面脚本用 $('#id') / getElementById('id') 取元素；改结构（比如把状态挪进终端工具栏）
// 时最容易漏掉某个 id。这里静态比对：每个页面加载的脚本引用到的 id 都必须在该页面里
// 存在，或者是脚本自己渲染出来的（JS 里出现 id="..."）。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ui = path.resolve(__dirname, '..', 'ui');
const pages = fs.readdirSync(ui).filter(name => name.endsWith('.html'));
assert.ok(pages.length >= 4, `ui 根目录下应有页面入口，实际 ${pages.length} 个`);

const problems = [];
let checked = 0;
for (const page of pages) {
  const html = fs.readFileSync(path.join(ui, page), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => match[1]);
  for (const script of scripts) {
    const file = path.join(ui, script);
    const sourceFile = !fs.existsSync(file) && script === 'widget/card.js'
      ? path.resolve(__dirname, '..', 'src/widget/card.tsx')
      : !fs.existsSync(file) && script === 'widget/detail.js'
        ? path.resolve(__dirname, '..', 'src/widget/detail.tsx')
        : file;
    if (!fs.existsSync(sourceFile)) { problems.push(`${page}: 脚本不存在 ${script}`); continue; }
    const source = fs.readFileSync(sourceFile, 'utf8');
    // 脚本自己生成的元素（模板字符串里的 id="..."）也算存在
    const generated = new Set([...source.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(match => match[1]));
    const referenced = new Set([
      ...[...source.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]),
      ...[...source.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]),
      ...[...source.matchAll(/\$\('#' \+ id\)/g)].map(() => null)
    ].filter(Boolean));
    for (const id of referenced) {
      checked += 1;
      if (id.startsWith('${') || id.includes('+')) continue;
      if (!ids.has(id) && !generated.has(id)) problems.push(`${page} ← ${script}: #${id} 在页面与脚本里都不存在`);
    }
  }
}

assert.deepEqual(problems, [], `DOM id 契约被破坏：\n- ${problems.join('\n- ')}`);
console.log(`PASS: ${pages.length} 个页面里脚本引用的 ${checked} 处 id 都能在页面或脚本里找到`);
