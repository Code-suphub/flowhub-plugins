import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('release identity stays aligned across frontend, manifest and backend',()=>{
 const manifest=JSON.parse(read('flowhub-plugin.json')),pkg=JSON.parse(read('package.json'));
 assert.equal(manifest.schema,2);assert.equal(manifest.id,'device-center');assert.equal(manifest.version,pkg.version);
 assert.match(read('backend/Cargo.toml'),new RegExp('version = "'+manifest.version.replaceAll('.','\\.')+'"'));
 assert.ok(fs.existsSync(path.join(root,'pnpm-lock.yaml')));assert.equal(manifest.statusSurface,true);
});
test('management and widget routes remain separate and CSP compatible',()=>{
 const manifest=JSON.parse(read('flowhub-plugin.json'));
 for(const file of [manifest.ui,...Object.values(manifest.widget).filter(v=>typeof v==='string').map(v=>'ui/'+v)]){
  const html=read(file);assert.match(html,/data-flowhub-common/);
  assert.doesNotMatch(html,/<script(?![^>]*src=|[^>]*data-flowhub-common)/i);
  assert.doesNotMatch(html,/https?:\/\/|http-equiv="Content-Security-Policy"/);
 }
 assert.match(read(manifest.ui),/react\/device-center\.js/);
 assert.match(read('ui/widget-detail.html'),/react\/device-center\.js/);
 assert.match(read('ui/widget-card.html'),/src="app\.js"/);
});
test('old prototype photos and management renderer are absent',()=>{
 assert.doesNotMatch(read('ui/app.js'),/function mainView|function details|\.png|ADB 已授权|已信任/);
 for(const file of fs.readdirSync(path.join(root,'ui/assets')))assert.ok(!file.endsWith('.png'));
 for(const kind of ['device','headphones','mouse','keyboard','phone','drive','hub','monitor','laptop']){
  const svg=read('ui/assets/'+kind+'.svg');assert.match(svg,/<svg\b/);
  assert.doesNotMatch(svg,/<script\b|<foreignObject\b|\bonload\s*=/i);
 }
});
