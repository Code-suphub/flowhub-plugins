import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'plugins', 'common', 'ui');
const assets = ['flowhub-common.css', 'flowhub-common.js'];
const plugins = fs.readdirSync(path.join(root, 'plugins'), {withFileTypes: true})
  .filter(entry => entry.isDirectory() && entry.name !== 'common' && fs.existsSync(path.join(root, 'plugins', entry.name, 'flowhub-plugin.json')))
  .map(entry => entry.name);

for (const id of plugins) {
  const target = path.join(root, 'plugins', id, 'ui', 'common');
  fs.mkdirSync(target, {recursive: true});
  for (const asset of assets) fs.copyFileSync(path.join(source, asset), path.join(target, asset));
}

console.log(`同步公共 UI：${plugins.length} 个插件 × ${assets.length} 个资源`);
