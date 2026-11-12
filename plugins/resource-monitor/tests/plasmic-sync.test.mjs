import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,stat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {assertManaged,codegenFiles,localState,remoteRevision,syncLayout} from '../scripts/plasmic-sync.mjs';
const config={projectId:'rKroot8WmpiogJg8366SaB',componentName:'ResourceMonitorCardLayout',bindings:['header','alerts','list','footer']};
const fixture=()=>({projectConfig:{projectId:config.projectId,revision:1,cssFileName:'plasmic.css',cssRules:'.root{}'},components:[{
  componentName:config.componentName,renderModuleFileName:'PlasmicResourceMonitorCardLayout.tsx',cssFileName:'Card.module.css',cssRules:'.root{}',
  renderModule:['Header','Alerts','List','Footer'].map(name=>`import ${name} from "./ResourceCard${name}Region";\n<div data-plasmic-name={"${name.toLowerCase()}"}/>`).join('\n')
}]});
test('sync only emits the pilot layout and maps example regions to live binding boundaries',()=>{
 const files=codegenFiles(fixture(),config);
 assert.equal(files.size,3);
 assert.equal([...files.values()].join('\n').match(/\.\.\/ResourceCardRegion/g).length,4);
 const spaced=fixture();spaced.projectConfig.cssRules='.root{}  \n\n';
 assert.equal(codegenFiles(spaced,config).get('plasmic.css'),'.root{}\n');
 const wrong=fixture();wrong.components.push({componentName:'OtherPage'});
 assert.throws(()=>codegenFiles(wrong,config),/unrelated/);
 const missing=fixture();missing.components[0].renderModule=missing.components[0].renderModule.replace('data-plasmic-name={"list"}','data-plasmic-name={"removed"}');
 assert.throws(()=>codegenFiles(missing,config),/Missing runtime binding: list/);
});

async function sandbox(t){
 const root=await mkdtemp(join(tmpdir(),'flowhub-plasmic-sync-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'design/plasmic'),{recursive:true});
 await mkdir(join(root,'src/plasmic'),{recursive:true});
 await writeFile(join(root,'design/plasmic/card-layout.json'),JSON.stringify(config));
 const files=codegenFiles(fixture(),config);
 for(const [name,body]of files)await writeFile(join(root,'src/plasmic',name),body);
 await writeFile(join(root,'src/plasmic/generated.json'),JSON.stringify({schema:1,projectId:config.projectId,component:config.componentName,revision:1,files:Object.fromEntries([...files].map(([name,body])=>[name,createHash('sha256').update(body).digest('hex')]))}));
 const authFile=join(root,'auth.json');
 await writeFile(authFile,JSON.stringify({host:'https://studio.plasmic.app',user:'test-user',token:'private-test-token'}));
 return {root,authFile,options:{sourceRoot:root,authFile},bundle:fixture()};
}

test('revision polling uses authenticated metadata only and rejects a different project or branch',async t=>{
 const {authFile}=await sandbox(t);
 let url,options;
 const fetchImpl=async(u,o)=>{url=u;options=o;return Response.json({rev:{projectId:config.projectId,revision:7,branchId:null}});};
 assert.equal(await remoteRevision({authFile,fetchImpl}),7);
 assert.equal(url,`https://studio.plasmic.app/api/v1/projects/${config.projectId}/revision-without-data`);
 assert.equal(options.headers['x-plasmic-api-token'],'private-test-token');
 assert.equal(options.body,undefined);
 for(const rev of [{projectId:'other',revision:7},{projectId:config.projectId,revision:7,branchId:'other-branch'}]){
  await assert.rejects(remoteRevision({authFile,fetchImpl:async()=>Response.json({rev})}),{code:'validation'});
 }
});

test('sync skips unchanged files, updates only the managed layout and rejects stale codegen',async t=>{
 const {root,options,bundle}=await sandbox(t);
 const name=join(root,'src/plasmic/Card.module.css'),before=await stat(name);
 assert.equal((await syncLayout({...options,fetchImpl:async()=>Response.json(bundle)})).changed,false);
 assert.equal((await stat(name)).mtimeMs,before.mtimeMs);
 await writeFile(join(root,'src/Card.tsx'),'keep business');
 bundle.projectConfig.revision=2;bundle.components[0].cssRules='.root{padding:16px}';
 const result=await syncLayout({...options,fetchImpl:async()=>Response.json(bundle),minimumRevision:2});
 assert.equal(result.changed,true);assert.equal((await localState(root)).revision,2);
 assert.equal(await readFile(name,'utf8'),'.root{padding:16px}\n');
 assert.equal(await readFile(join(root,'src/Card.tsx'),'utf8'),'keep business');
 await assert.rejects(syncLayout({...options,fetchImpl:async()=>Response.json(fixture()),minimumRevision:3}),{code:'validation'});
 assert.equal((await localState(root)).revision,2);
 assert.deepEqual((await readdir(join(root,'src'))).sort(),['Card.tsx','plasmic']);
});

test('a local edit during codegen is preserved and overlapping manual sync is rejected',async t=>{
 const {root,options,bundle}=await sandbox(t);
 let resolve,started;
 const entered=new Promise(done=>{started=done;});
 const pending=syncLayout({...options,fetchImpl:()=>{started();return new Promise(done=>{resolve=done;});}});
 await entered;
 await assert.rejects(syncLayout({...options,fetchImpl:()=>assert.fail('must not request codegen twice')}),{code:'busy'});
 const name=join(root,'src/plasmic/Card.module.css');
 await writeFile(name,'local unsaved design');bundle.projectConfig.revision=2;
 resolve(Response.json(bundle));
 await assert.rejects(pending,{code:'local-edits'});
 assert.equal(await readFile(name,'utf8'),'local unsaved design');
 assert.ok(!(await readdir(join(root,'src'))).some(name=>name.startsWith('.plasmic-')));
});

test('invalid codegen and shutdown cancellation keep the previous generated layout',async t=>{
 const {root,options,bundle}=await sandbox(t);
 const original=JSON.stringify(await localState(root));
 bundle.projectConfig.revision=2;bundle.externalCssImports=['https://example.com/not-packaged.css'];
 await assert.rejects(syncLayout({...options,fetchImpl:async()=>Response.json(bundle)}),{code:'validation'});
 const controller=new AbortController();
 const fetchImpl=async()=>{controller.abort();return Response.json(fixture());};
 await assert.rejects(syncLayout({...options,signal:controller.signal,fetchImpl}),{name:'AbortError'});
 assert.equal(JSON.stringify(await localState(root)),original);
});
test('unexpected project, external CSS and escaped filenames fail before any write',()=>{
 const wrong=fixture();wrong.projectConfig.projectId='another-project';assert.throws(()=>codegenFiles(wrong,config),/Unexpected/);
 const external=fixture();external.projectConfig.cssRules="@import url('https://fonts.googleapis.com/private');";assert.throws(()=>codegenFiles(external,config),/packaged assets/);
 const escaped=fixture();escaped.components[0].cssFileName='../Card.tsx';assert.throws(()=>codegenFiles(escaped,config),/Unsafe/);
 const asset=fixture();asset.externalCssImports=['https://example.com/style.css'];assert.throws(()=>codegenFiles(asset,config),/external assets/);
});
test('project-wide registration metadata is accepted without bundling Studio code or allowing recursive layouts',()=>{
 const known=fixture();known.codeComponentMetas=[{id:'preview-id',name:'ResourceCardStudio',importPath:'../design/ResourceCardStudio'},{id:'button-id',name:'Button',importPath:'@flowhub/plugin-common/react'}];
 assert.equal(codegenFiles(known,config).size,3);
 const recursive=structuredClone(known);recursive.components[0].renderModule+='\n// plasmic-import: preview-id/codeComponent';
 assert.throws(()=>codegenFiles(recursive,config),/nested code component/);
 const unknown=fixture();unknown.codeComponentMetas=[{id:'external',name:'Unexpected',importPath:'external-library'}];
 assert.throws(()=>codegenFiles(unknown,config),/new or nested/);
});
test('generated-file checks retain local edits and reject untracked source files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'flowhub-plasmic-managed-'));
 try{
  const text='generated layout';
  await writeFile(join(directory,'Card.tsx'),text);
  await writeFile(join(directory,'generated.json'),JSON.stringify({files:{'Card.tsx':createHash('sha256').update(text).digest('hex')}}));
  await assertManaged(directory);
  await writeFile(join(directory,'Card.tsx'),'developer edit');await assert.rejects(assertManaged(directory),/edited locally/);
  await writeFile(join(directory,'Card.tsx'),text);await writeFile(join(directory,'Business.tsx'),'keep this');
  await assert.rejects(assertManaged(directory),/untracked/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
