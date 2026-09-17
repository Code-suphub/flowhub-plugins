// Netdata 面板的「关闭」按钮曾经只声明了 data-dismiss，却从没有人给它绑事件，
// 结果点了没有任何反应（Esc 仍然有效，所以不容易被发现）。这里静态检查：
// 凡是在 ui/ 下声明了 data-close / data-dismiss 的文件，必须在同一文件里绑定关闭行为。
// 只做静态检查，不需要浏览器。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ui = path.resolve(__dirname, '..', 'ui');

function jsFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

const files = jsFiles(ui);
assert.ok(files.length >= 5, `ui 下应有脚本文件，实际 ${files.length} 个`);

const problems = [];
let checked = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const hook of ['data-close', 'data-dismiss']) {
    if (!new RegExp(`(^|[^\\w-])${hook}([^\\w-]|$)`).test(source)) continue;
    checked++;
    // 绑定形式：$('[data-close]').onclick=… / addEventListener('click',…) 委托 / querySelector 后赋值。
    const bound = new RegExp(`\\[${hook}\\][\\s\\S]{0,120}?(onclick|addEventListener)`).test(source)
      || new RegExp(`addEventListener\\(\\s*['"]click['"][\\s\\S]{0,400}?${hook}`).test(source);
    if (!bound) problems.push(path.relative(ui, file) + ' → ' + hook);
  }
}

assert.deepEqual(problems, [], '以下关闭按钮只有声明、没有绑定事件：\n' + problems.join('\n'));
console.log(`dialog-dismiss: 检查 ${files.length} 个脚本，${checked} 处关闭按钮均有绑定`);
