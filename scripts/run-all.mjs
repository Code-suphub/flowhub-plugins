import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const task = process.argv[2];
if (task !== 'build' && task !== 'test') throw new Error('用法：node scripts/run-all.mjs <build|test>');
const root = path.resolve(import.meta.dirname, '..');
const ids = fs.readdirSync(path.join(root, 'plugins'))
  .filter(id => fs.existsSync(path.join(root, 'plugins', id, 'flowhub-plugin.json')))
  .sort();
if (ids.length === 0) throw new Error('plugins/ 下没有找到插件');
for (const id of ids) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'package.json'), 'utf8'));
  if (!pkg.scripts?.[task]) { console.log(`跳过 ${id}：没有 ${task} 脚本`); continue; }
  console.log(`==> ${id}: npm run ${task}`);
  execFileSync('npm', ['--prefix', path.join('plugins', id), 'run', task], {cwd: root, stdio: 'inherit'});
}
