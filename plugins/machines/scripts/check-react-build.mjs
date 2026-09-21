import fs from 'node:fs';
import path from 'node:path';

const ui = path.resolve('build/ui');
const required = [
  'machines.html',
  'widget-editor.html',
  'react/fleet.js',
  'react/fleet.css',
  'react/widget-editor.js',
  'react/widget-editor.css',
  'widget/card.js',
  'widget/card.css',
  'widget/detail.js',
  'widget/detail.css',
];
for (const relative of required) {
  if (!fs.existsSync(path.join(ui, relative))) throw new Error(`React 构建缺少 ${relative}`);
}

const html = fs.readFileSync(path.join(ui, 'widget-editor.html'), 'utf8');
for (const reference of ['react/widget-editor.js', 'react/widget-editor.css']) {
  if (!html.includes(reference)) throw new Error(`widget editor 未引用 ${reference}`);
}
const bundle = fs.readFileSync(path.join(ui, 'react/widget-editor.js'), 'utf8');
const machinesHtml = fs.readFileSync(path.join(ui, 'machines.html'), 'utf8');
for (const reference of ['react/fleet.js', 'react/fleet.css']) {
  if (!machinesHtml.includes(reference)) throw new Error(`machines 页面未引用 ${reference}`);
}
const fleetBundle = fs.readFileSync(path.join(ui, 'react/fleet.js'), 'utf8');
if (machinesHtml.includes('machine-tabs.js') || fs.existsSync(path.join(ui, 'machine-tabs.js'))) {
  throw new Error('发布构建不应保留旧 machine-tabs.js');
}
if (fleetBundle.includes('FlowHubHostEditor')) throw new Error('构建不应保留旧机器编辑器全局桥接');
if (/src=["']machines\.js["']/.test(machinesHtml) || fs.existsSync(path.join(ui, 'machines.js'))) {
  throw new Error('发布构建不应保留旧 machines.js');
}
if (fleetBundle.includes('flowhub:fleet-action') || /\.FlowHubFleet\b/.test(fleetBundle)) {
  throw new Error('React 构建不应保留旧列表事件桥接');
}
const bundles = [bundle, fleetBundle];
for (const source of bundles) {
  if (source.includes('@flowhub/plugin-common')) throw new Error('React 构建仍包含未解析的 common 包导入');
  if (/(?:^|[;\n])\s*import\s*(?:[\w*{]|["']|\()/m.test(source)) throw new Error('React 构建仍包含运行时模块导入');
}
if (/https?:\/\//.test(html)) throw new Error('React 页面不能依赖远程运行时资源');
if (!html.includes('data-flowhub-ready="editor"')) throw new Error('React 编辑器必须在注册保存函数后再通知宿主就绪');
for (const stale of ['widget/widget-editor.js', 'widget/widget-editor.css']) {
  if (fs.existsSync(path.join(ui, stale))) throw new Error(`发布构建不应保留已迁移的旧编辑器资源：${stale}`);
}

const maps = fs.readdirSync(path.join(ui, 'react')).filter((name) => name.endsWith('.map'));
if (maps.length) throw new Error(`发布构建不应包含 source map：${maps.join(', ')}`);

console.log('React widget editor 与 machines islands 构建产物自包含');
