import fs from 'node:fs';
import path from 'node:path';

const ui = path.resolve('build/ui');
const required = ['widget-editor.html', 'react/widget-editor.js', 'react/widget-editor.css'];
for (const relative of required) {
  if (!fs.existsSync(path.join(ui, relative))) throw new Error(`React 构建缺少 ${relative}`);
}

const html = fs.readFileSync(path.join(ui, 'widget-editor.html'), 'utf8');
for (const reference of ['react/widget-editor.js', 'react/widget-editor.css']) {
  if (!html.includes(reference)) throw new Error(`widget editor 未引用 ${reference}`);
}
const bundle = fs.readFileSync(path.join(ui, 'react/widget-editor.js'), 'utf8');
if (bundle.includes('@flowhub/plugin-common')) throw new Error('React 构建仍包含未解析的 common 包导入');
if (/(?:^|[;\n])\s*import\s*(?:[\w*{]|["']|\()/m.test(bundle)) throw new Error('React 构建仍包含运行时模块导入');
if (/https?:\/\//.test(html)) throw new Error('React 页面不能依赖远程运行时资源');
if (!html.includes('data-flowhub-ready="editor"')) throw new Error('React 编辑器必须在注册保存函数后再通知宿主就绪');

const maps = fs.readdirSync(path.join(ui, 'react')).filter((name) => name.endsWith('.map'));
if (maps.length) throw new Error(`发布构建不应包含 source map：${maps.join(', ')}`);

console.log('React widget editor 构建产物自包含');
