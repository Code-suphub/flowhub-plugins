import {readFileSync, existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const html = readFileSync('build/ui/index.html', 'utf8');
for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  assert(!/^(?:https?:|\/|\.\.)/.test(asset), '资源必须位于插件包内');
  assert(existsSync('build/ui/' + asset), '缺少资源：' + asset);
}
assert(html.includes('react/twofa.js'));
assert(!/<script(?![^>]*src=)[^>]*>\s*\S/.test(html), '禁止内联脚本');
for (const old of ['app.js', 'bridge.js', 'style.css']) assert(!existsSync('build/ui/' + old), '旧资源未清理：' + old);
console.log('2FA 构建资源检查通过');
