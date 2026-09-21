// 历史叠加的样式层会留下「永不生效的声明」：同文件里后面还有一条同选择器、同属性、
// 无条件的声明，前者在任何视口和状态下都不会赢。这类死代码让后来者改不动样式。
// 判定见 scripts/css-cascade.cjs，修复：node scripts/prune-dead-css.mjs --apply
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { deadDeclarations } = require('../scripts/css-cascade.cjs');

const ui = path.resolve(__dirname, '..', 'ui');

function cssFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) cssFiles(target, found);
    else if (entry.name.endsWith('.css')) found.push(target);
  }
  return found;
}

const files = cssFiles(ui);
assert.ok(files.length >= 6, `ui/ 下的样式表应有 6 个以上，实际 ${files.length}`);

const problems = [];
let declarations = 0;
for (const file of files) {
  const css = fs.readFileSync(file, 'utf8');
  declarations += css.split(';').length;
  for (const dead of deadDeclarations(css)) {
    problems.push(`${path.relative(ui, file)}: ${dead.selector} { ${dead.property}: ${dead.value} } 被后面的 ${dead.overriddenBy} 覆盖`);
  }
}

assert.deepEqual(problems, [], `存在永不生效的样式声明（跑 node scripts/prune-dead-css.mjs --apply 清理）：\n- ${problems.slice(0, 20).join('\n- ')}${problems.length > 20 ? `\n…还有 ${problems.length - 20} 条` : ''}`);
console.log(`PASS: ${files.length} 个样式表（约 ${declarations} 条声明）没有永不生效的声明`);
