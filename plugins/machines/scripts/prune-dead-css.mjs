// 删除「永不生效的声明」——被同文件里更晚的同选择器同属性无条件声明覆盖的那些。
// 判定见 scripts/css-cascade.cjs；tests/css-dead-declarations.test.cjs 是同一条规则的守卫。
//
//   node scripts/prune-dead-css.mjs            # 预演，只打印
//   node scripts/prune-dead-css.mjs --apply    # 写入
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { deadDeclarations, removeDeclarations } = require('./css-cascade.cjs');

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = process.argv.find(argument => !argument.startsWith('-') && argument !== process.argv[0] && argument !== process.argv[1]) || resolve(here, '..', 'ui');
const apply = process.argv.includes('--apply');

function cssFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) cssFiles(path, found);
    else if (entry.name.endsWith('.css')) found.push(path);
  }
  return found;
}

let total = 0;
for (const file of cssFiles(root)) {
  const css = readFileSync(file, 'utf8');
  const dead = deadDeclarations(css);
  if (!dead.length) continue;
  total += dead.length;
  console.log(`${file.replace(root + '/', '')}: ${dead.length} 条永不生效`);
  for (const declaration of dead.slice(0, 8)) {
    console.log(`  ${declaration.selectors.join(', ')} { ${declaration.property}: ${declaration.value} } → ${declaration.overriddenBy}`);
  }
  if (dead.length > 8) console.log(`  …还有 ${dead.length - 8} 条`);
  if (apply) writeFileSync(file, removeDeclarations(css, dead));
}
console.log(total ? `\n合计 ${total} 条${apply ? '（已删除）' : '（预演；加 --apply 写入）'}` : '没有永不生效的声明');
