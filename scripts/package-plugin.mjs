import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inlineCommonHtml} from './inline-common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('用法：node scripts/package-plugin.mjs <plugin-id>');

const pluginRoot = path.join(root, 'plugins', id);
const sourceUi = path.join(pluginRoot, 'ui');
const sourceManifest = path.join(pluginRoot, 'flowhub-plugin.json');
const output = path.join(pluginRoot, 'build');
const manifest = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'));

function copyTree(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`构建包禁止包含软链接：${path.relative(pluginRoot, source)}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, {recursive: true});
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name));
    return;
  }
  if (!stat.isFile()) throw new Error(`不支持的构建文件：${path.relative(pluginRoot, source)}`);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  if (source.endsWith('.html')) fs.writeFileSync(target, inlineCommonHtml(fs.readFileSync(source, 'utf8')));
  else fs.copyFileSync(source, target);
  fs.chmodSync(target, stat.mode & 0o777);
}

fs.rmSync(output, {recursive: true, force: true});
fs.mkdirSync(output, {recursive: true});
fs.writeFileSync(path.join(output, 'flowhub-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
copyTree(sourceUi, path.join(output, 'ui'));
const binary = path.join(pluginRoot, manifest.executable);
if (!fs.existsSync(binary)) throw new Error(`后端构建产物不存在：${manifest.executable}`);
copyTree(binary, path.join(output, manifest.executable));

console.log(`生成独立插件构建目录：plugins/${id}/build`);
