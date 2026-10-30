import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file));

test('manifest schema and three versions remain aligned',()=>{
 const m=json('flowhub-plugin.json'),p=json('package.json'),lock=json('package-lock.json');
 assert.equal(m.schema,2);assert.equal(m.id,'device-center');assert.equal(m.version,p.version);
 assert.equal(lock.version,m.version);assert.equal(lock.packages[''].version,m.version);
 assert.match(read('backend/Cargo.toml'),new RegExp(`version = "${m.version.replace(/\./g,'\\.')}"`));
 assert.equal(m.statusSurface,true);
});
test('every UI entry is host-CSP compatible and self-contained',()=>{
 const m=json('flowhub-plugin.json');
 const pages=[m.ui,...Object.values(m.widget).filter(v=>typeof v==='string').map(v=>'ui/'+v)];
 for(const page of pages){
  const html=read(page);
  assert.match(html,/href="style\.css"/);assert.match(html,/src="app\.js"/);
  assert.doesNotMatch(html,/http-equiv="Content-Security-Policy"|<script(?![^>]*src=)/i);
  assert.match(html,/正在打开外设中心/);
 }
});
test('JavaScript and preview server pass syntax checks',()=>{
 for(const file of ['ui/app.js','scripts/preview.mjs']){
  const r=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8'});
  assert.equal(r.status,0,`${file}: ${r.stderr}`);
 }
});
test('nine locally packaged device images and SVG fallbacks exist',()=>{
 for(const image of ['airpods','mouse','keyboard','pixel','iphone','ssd','reader','dell','lg']){
  const file=path.join(root,'ui/assets',image+'.png');
  assert.ok(fs.statSync(file).isFile(),image);
  const contents=fs.readFileSync(file);
  assert.deepEqual([...contents.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 }
 for(const kind of ['device','headphones','mouse','keyboard','phone','drive','hub','monitor','laptop']){
  const svg=read('ui/assets/'+kind+'.svg');
  assert.match(svg,/<svg\b/);assert.doesNotMatch(svg,/<script\b|<foreignObject\b|\bonload\s*=/i);
 }
});
test('visual implementation retains source layout landmarks',()=>{
 const css=read('ui/style.css'),js=read('ui/app.js');
 assert.match(css,/\.app-layout\{display:grid;grid-template-columns:207px/);
 assert.match(css,/\.stats\{display:grid;grid-template-columns:repeat\(5,/);
 assert.match(css,/\.card-grid\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
 assert.match(css,/@media\(max-width:800px\)/);
 assert.match(css,/@media\(max-width:530px\)/);
 for(const key of ['bluetooth','usb','display','power','events'])assert.ok(js.includes(key));
 assert.doesNotMatch(js,/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/);
});
test('mock data is clearly labeled and real data is read through plugin RPC',()=>{
 const js=read('ui/app.js');
 assert.match(js,/演示数据/);assert.match(js,/flowhub:request/);
 assert.match(js,/flowhub:widget-rpc/);assert.match(js,/flowhub:widget-ready/);
 assert.match(js,/flowhub:widget-size/);
 assert.doesNotMatch(js,/serial_num|device_address/);
});
