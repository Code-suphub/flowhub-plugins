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
import {spawnSync} from 'node:child_process';

test('new dashboard JavaScript parses under Node.js without DOM execution',()=>{
  const result=spawnSync(process.execPath,['--check',path.join(root,'ui/app.js')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
test('device imagery uses only packaged original SVG fallback assets',()=>{
  const entries=['earbuds','headphones','mouse','keyboard','phone','drive','hub','monitor','laptop','speaker','device'];
  for(const entry of entries){
    const file=path.join(root,'ui/assets',entry+'.svg');
    assert.ok(fs.statSync(file).isFile(),file+' must be available');
    const svg=fs.readFileSync(file,'utf8');
    assert.match(svg,/<svg\b/);
    assert.doesNotMatch(svg,/<script\b|https?:\/\//i);
  }
  const code=fs.readFileSync(path.join(root,'ui/app.js'),'utf8');
  for(const entry of entries)assert.ok(code.includes(entry+'.svg'),'missing mapping '+entry);
  assert.doesNotMatch(code,/\bfetch\s*\(/);
});
test('new layout uses responsive two-column device dashboard and no redundant side menu',()=>{
  const css=fs.readFileSync(path.join(root,'ui/style.css'),'utf8');
  const js=fs.readFileSync(path.join(root,'ui/app.js'),'utf8');
  assert.match(css,/\.main-grid\s*\{display:grid;grid-template-columns:repeat\(2,/);
  assert.match(css,/@media\(max-width:650px\)/);
  assert.match(js,/class="tabs"/);
  assert.doesNotMatch(js,/class="layout"/);
});
test('compact widget uses category counts and no private serial numbers',()=>{
  const source=fs.readFileSync(path.join(root,'backend/src/main.rs'),'utf8');
  assert.match(source,/"counts":\{"bluetooth"/);
  assert.match(source,/"category":d.category/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'ui/app.js'),'utf8'),/serial_num/);
});

