import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createServer as createHttpServer} from 'node:http';
import {createServer} from 'vite';
import {buildUi} from '../scripts/build-ui.mjs';
import {checkCardBrowser,chromeExecutable} from '../scripts/check-card-browser.mjs';
import {inlineCommonHtml} from '../../../scripts/inline-common.mjs';
import {checkBuiltUi} from '../../../scripts/check-built-ui.mjs';

let directory,outputs;
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'flowhub-card-entry-test-'));
  await mkdir(join(directory,'ui/_common'),{recursive:true});
  outputs=await buildUi({outDir:join(directory,'ui/react'),logLevel:'error'});
  await copyFile(new URL('../flowhub-plugin.json',import.meta.url),join(directory,'flowhub-plugin.json'));
  for(const name of ['index.html','widget-card.html','widget-editor.html','widget-detail.html']) {
    const source=await readFile(new URL('../ui/'+name,import.meta.url),'utf8');
    await writeFile(join(directory,'ui',name),inlineCommonHtml(source,{scriptPrefix:'_common'}));
  }
  await copyFile(new URL('../../common/ui/flowhub-theme.js',import.meta.url),join(directory,'ui/_common/flowhub-theme.js'));
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});

test('card production IIFE excludes management dependencies and stays below half the management bundle',async t=>{
  const chunks=outputs.flatMap(output=>output.output).filter(item=>item.type==='chunk');
  assert.deepEqual(chunks.map(chunk=>chunk.fileName),['monitor.js','card.js']);
  const [management,card]=chunks;
  const modules=Object.keys(card.modules).map(id=>id.replaceAll('\\','/'));
  assert.ok(modules.some(id=>id.endsWith('/src/Card.tsx')));
  assert.ok(modules.some(id=>id.endsWith('/src/applications.tsx')));
  const forbidden=modules.filter(id=>/\/src\/(?:App|Widget)\.tsx$|\/(?:antd|@ant-design|@rc-component|rc-[^/]+|common-components)\//.test(id));
  assert.deepEqual(forbidden,[],'card must not bundle App, editor, antd, cssinjs or shared antd adapters');
  assert.ok(modules.some(id=>id.endsWith('/src/plasmic/PlasmicResourceMonitorCardLayout.tsx')),'production card must consume the synced Plasmic layout');
  assert.ok(modules.every(id=>!id.includes('/src/design/')),'Studio fixtures and registration must stay outside production');
  assert.ok(Object.keys(management.modules).some(id=>id.endsWith('/src/App.tsx')));
  for(const chunk of chunks) {
    assert.deepEqual(chunk.imports,[]);
    assert.deepEqual(chunk.dynamicImports,[]);
    assert.doesNotMatch(chunk.code,/\beval\s*\(|\bnew\s+Function\s*\(/);
  }
  const raw=Buffer.byteLength(card.code),gzip=gzipSync(card.code).length;
  assert.ok(raw<Buffer.byteLength(management.code)/2);
  assert.ok(gzip<gzipSync(management.code).length/2);
  // An absolute budget also catches both entries accidentally growing together.
  assert.ok(raw<350000&&gzip<110000,`card budget exceeded: ${raw} raw / ${gzip} gzip bytes`);
  t.diagnostic(`card.js: ${raw} bytes / ${gzip} gzip; ${modules.length} modules, no management dependencies`);
});

test('packaged pages select standalone local scripts and pass desktop CSP resource validation',async()=>{
  assert.deepEqual(checkBuiltUi(directory),[]);
  for(const name of ['index.html','widget-card.html','widget-editor.html','widget-detail.html']) {
    const html=await readFile(join(directory,'ui',name),'utf8');
    const card=name==='widget-card.html';
    const scripts=[...html.matchAll(/<script\b([^>]*)>/g)].map(match=>match[1]);
    assert.equal(scripts.length,2,'only the shared theme and one entry script should load');
    assert.ok(scripts.every(attributes=>!attributes.includes('type="module"')));
    assert.ok(html.includes(`src="react/${card?'card':'monitor'}.js"`));
    assert.ok(html.includes(`href="react/${card?'card':'monitor'}.css"`));
    if(card)assert.ok(!html.includes('react/monitor.'));
  }
});

test('Vite preview selects the card source entry and retains external shared theme',async()=>{
  const server=await createServer({configFile:new URL('../vite.config.mjs',import.meta.url).pathname,cacheDir:join(directory,'vite-cache'),optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},logLevel:'error'});
  const http=createHttpServer(server.middlewares);
  try {
    await new Promise(done=>http.listen(0,'127.0.0.1',done));
    const base=`http://127.0.0.1:${http.address().port}`;
    for(const name of ['index.html','widget-card.html','widget-editor.html','widget-detail.html']) {
      const html=await fetch(`${base}/ui/${name}`).then(response=>response.text());
      const card=name==='widget-card.html';
      assert.ok(html.includes(`src="/src/${card?'card-main':'main'}.tsx"`));
      assert.ok(!html.includes(`src="/src/${card?'main':'card-main'}.tsx"`));
      assert.ok(html.includes('src="/__common/flowhub-theme.js"'));
      assert.doesNotMatch(html,/react\/(?:card|monitor)\.(?:js|css)/);
    }
    const theme=await fetch(`${base}/__common/flowhub-theme.js`);
    assert.equal(theme.status,200);
    assert.match(await theme.text(),/flowhub:theme-ready/);
  } finally {await new Promise(done=>http.close(done));await server.close();}
});

test('Studio host ignores documentation writes while retaining normal HTML reloads',async()=>{
  const sourceRoot=new URL('..',import.meta.url).pathname,root=join(directory,'studio-watch');
  await mkdir(join(root,'docs'),{recursive:true});
  await mkdir(join(root,'src/design'),{recursive:true});
  const documentation=join(root,'docs/watch.md'),html=join(root,'src/design/watch.html');
  const server=await createServer({root,configFile:join(sourceRoot,'vite.config.mjs'),mode:'plasmic',cacheDir:join(directory,'studio-vite-cache'),server:{port:0,strictPort:false},logLevel:'error'});
  const events=[],send=server.ws.send.bind(server.ws);
  server.ws.send=(...args)=>{events.push(args[0]);return send(...args);};
  try{
    await server.listen();
    await new Promise(done=>setTimeout(done,150));
    await writeFile(documentation,'temporary development watch fixture');
    await new Promise(done=>setTimeout(done,350));
    assert.ok(events.every(event=>event.type!=='full-reload'),'a documentation write reset the Studio editor');
    await writeFile(html,'<!doctype html><title>watch control</title>');
    for(let i=0;i<100&&!events.some(event=>event.type==='full-reload');i++)await new Promise(done=>setTimeout(done,20));
    assert.ok(events.some(event=>event.type==='full-reload'),'HTML changes must still reach the development browser');
  }finally{
    await server.close();
    await rm(documentation,{force:true});await rm(html,{force:true});
  }
});

test('built card and management surfaces preserve host interactions under desktop script CSP',{skip:!chromeExecutable()},async t=>{
  const result=await checkCardBrowser(directory);
  assert.equal(result.ok,true,JSON.stringify(result));
  t.diagnostic(result.checks.join('; '));
});
