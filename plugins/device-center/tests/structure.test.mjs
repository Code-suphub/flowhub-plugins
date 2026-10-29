import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const json=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
test('manifest and versions match',()=>{
 const m=json('flowhub-plugin.json'),p=json('package.json');
 assert.equal(m.schema,2);assert.equal(m.id,'device-center');assert.equal(m.version,p.version);
 assert.match(fs.readFileSync(path.join(root,'backend/Cargo.toml'),'utf8'),/version = "0.1.0"/);
 assert.equal(m.statusSurface,true);
});
test('page files and external assets are present',()=>{
 const m=json('flowhub-plugin.json');
 for(const name of [m.ui,...Object.values(m.widget).filter(v=>typeof v==='string').map(v=>'ui/'+v)]){
  const html=fs.readFileSync(path.join(root,name),'utf8');
  assert.match(html,/app\.js/);assert.match(html,/style\.css/);
  assert.doesNotMatch(html,/<script(?![^>]*src=)/i);
 }
});
test('no remote scripts or image scraper in UI',()=>{
 const text=fs.readFileSync(path.join(root,'ui/app.js'),'utf8');
 assert.doesNotMatch(text,/https?:\/\//);assert.match(text,/演示数据/);
});

test('plugin HTML defers CSP to the sandboxed FlowHub host origin',()=>{
 const manifest=json('flowhub-plugin.json');
 for(const page of [manifest.ui,...Object.values(manifest.widget)
    .filter(value=>typeof value==='string').map(value=>'ui/'+value)]){
  const html=fs.readFileSync(path.join(root,page),'utf8');
  assert.doesNotMatch(html,/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["']/i,
    page+' must not override the host flowhub-plugin:// CSP with self');
  assert.match(html,/<script\s+src="app\.js"><\/script>/);
  assert.match(html,/<link\s+rel="stylesheet"\s+href="style\.css">/);
  assert.match(html,/正在加载外设中心/);
 }
});
