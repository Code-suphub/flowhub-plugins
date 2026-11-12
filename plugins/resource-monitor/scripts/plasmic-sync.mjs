import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
export const projectId='rKroot8WmpiogJg8366SaB';
const digest=value=>createHash('sha256').update(value).digest('hex');
const manifestName='generated.json';

export class SyncError extends Error {
  constructor(code,message){super(message);this.code=code;}
}

export async function readAuth(authFile=process.env.PLASMIC_AUTH_FILE){
  if(!authFile)throw new SyncError('credentials','Set PLASMIC_AUTH_FILE to your existing private Plasmic auth file.');
  let auth;
  try{auth=JSON.parse(await fs.readFile(authFile,'utf8'));}
  catch{throw new SyncError('credentials','Cannot read the private Plasmic auth file.');}
  if(auth.host!=='https://studio.plasmic.app'||!auth.user||!auth.token)throw new SyncError('credentials','Expected official Plasmic credentials.');
  return auth;
}

const headers=auth=>({'Content-Type':'application/json','x-plasmic-api-user':auth.user,'x-plasmic-api-token':auth.token});
function checkResponse(response){
  if(!response.ok)throw new SyncError([401,403].includes(response.status)?'credentials':'network',`Plasmic HTTP ${response.status}; no local files changed.`);
}

/** Only fetch revision metadata. Never send the project model or credentials to
 * the browser; codegen is requested only after a saved revision changes. */
export async function remoteRevision({authFile,fetchImpl=fetch,signal}={}){
  const auth=await readAuth(authFile);
  const response=await fetchImpl(`${auth.host}/api/v1/projects/${projectId}/revision-without-data`,{
    headers:headers(auth),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)
  });
  checkResponse(response);
  const value=await response.json();
  if(value.rev?.projectId!==projectId||value.rev?.branchId||!Number.isSafeInteger(value.rev?.revision)||value.rev.revision<1)throw new SyncError('validation','Unexpected project revision.');
  return value.rev.revision;
}

export function codegenFiles(bundle,config){
  if(bundle.projectConfig?.projectId!==projectId||config.projectId!==projectId)throw Error('Unexpected Plasmic project.');
  if(!bundle.components?.some(component=>component.componentName===config.componentName))throw Error('The card layout was not generated.');
  const expected=new Set([config.componentName,'ResourceCardHeaderRegion','ResourceCardAlertsRegion','ResourceCardListRegion','ResourceCardFooterRegion']);
  if(bundle.components.some(component=>!expected.has(component.componentName)))throw Error('Codegen included an unrelated component.');
  const registry=new Set([
    'PlasmicHead:@plasmicapp/react-web',
    'Fetcher:@plasmicapp/react-web/lib/data-sources',
    'ResourceCardStudio:../design/ResourceCardStudio',
    'Button:@flowhub/plugin-common/react'
  ]);
  // Codegen includes project-wide registration metadata even when these code
  // components are not used by the requested layout. Known registrations are
  // harmless; importing the Studio preview into its own layout would recurse.
  for(const meta of bundle.codeComponentMetas??[]){
    if(!registry.has(`${meta.name}:${meta.importPath}`)||bundle.components.some(component=>new RegExp(`plasmic-import:\\s*${meta.id}/`).test(component.renderModule)))throw Error('Review a new or nested code component before syncing the card layout.');
  }
  if(bundle.externalCssImports?.length||bundle.imageAssets?.length||bundle.globalVariants?.length)throw Error('Review new external assets, contexts or component dependencies before syncing.');
  const files=new Map();
  const regions=['ResourceCardHeaderRegion','ResourceCardAlertsRegion','ResourceCardListRegion','ResourceCardFooterRegion'];
  const add=(name,body)=>{
    if(typeof name!=='string'||path.basename(name)!==name||!/^[-\w.]+\.(?:tsx|css)$/.test(name)||typeof body!=='string')throw Error('Unsafe generated file.');
    if(name.endsWith('.css')&&(/@import\s/i.test(body)||/url\(\s*['\"]?(?:https?:)?\/\//i.test(body)))throw Error('Generated CSS must use packaged assets.');
    files.set(name,body.replace(/[ \t]+$/gm,'').trimEnd()+'\n');
  };
  for(const component of bundle.components){
    if(component.componentName!==config.componentName)continue;
    // The four regions are runtime bindings, not captured example content.
    // Resolve their imports to a lightweight local boundary, as codegen's
    // component mapping does, and keep all actual data/actions in the wrapper.
    let render=component.renderModule;
    for(const name of regions){
      const from=`\"./${name}\"`;
      if(!render.includes(from))throw Error(`Missing region import: ${name}`);
      render=render.replace(from,'\"../ResourceCardRegion\"');
    }
    add(component.renderModuleFileName,render);
    add(component.cssFileName,component.cssRules);
  }
  for(const name of config.bindings)if(!new RegExp(`data-plasmic-name=\\{\\s*[\"']${name}[\"']\\s*\\}`).test(bundle.components.find(component=>component.componentName===config.componentName).renderModule))throw Error(`Missing runtime binding: ${name}`);
  add(bundle.projectConfig.cssFileName,bundle.projectConfig.cssRules);
  for(const key of ['projectModuleBundle','styleTokensProviderBundle']){
    const value=bundle.projectConfig[key];if(value)add(value.fileName,value.module);
  }
  for(const icon of bundle.iconAssets??[])add(icon.fileName,icon.module);
  return files;
}

export async function assertManaged(directory){
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(directory,manifestName),'utf8'));}
  catch(error){if(error.code==='ENOENT'){if((await fs.readdir(directory).catch(()=>[])).length)throw Error('Generated folder has untracked files.');return;}throw error;}
  const actual=await fs.readdir(directory);
  if(actual.some(name=>name!==manifestName&&!Object.hasOwn(manifest.files,name)))throw Error('Generated folder has untracked files.');
  for(const [name,hash]of Object.entries(manifest.files)){
    if(path.basename(name)!==name||digest(await fs.readFile(path.join(directory,name)))!==hash)throw Error(`Generated file was edited locally: ${name}. Move behavior into the wrapper before syncing.`);
  }
}

export async function localState(sourceRoot=root){
  const directory=path.join(sourceRoot,'src/plasmic');
  try{await assertManaged(directory);}
  catch{throw new SyncError('local-edits','Generated files have local changes. Resolve them before syncing.');}
  const state=JSON.parse(await fs.readFile(path.join(directory,manifestName),'utf8'));
  if(state.projectId!==projectId||!Number.isSafeInteger(state.revision))throw new SyncError('validation','Unexpected local layout metadata.');
  return state;
}

async function lock(sourceRoot){
  const name=path.join(sourceRoot,'src/.plasmic-sync-lock');
  const acquire=()=>fs.open(name,'wx',0o600);
  let handle;
  try{handle=await acquire();}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    let owner;
    try{owner=JSON.parse(await fs.readFile(name,'utf8'));}catch{}
    if(!Number.isSafeInteger(owner?.pid)||owner.pid<=0)throw new SyncError('busy','Another layout sync is running.');
    try{process.kill(owner.pid,0);throw new SyncError('busy','Another layout sync is running.');}
    catch(error){if(error.code!=='ESRCH')throw error;}
    await fs.unlink(name);handle=await acquire();
  }
  await handle.writeFile(JSON.stringify({pid:process.pid}));
  return async()=>{await handle.close();await fs.unlink(name);};
}

export async function syncLayout({sourceRoot=root,authFile,fetchImpl=fetch,signal,minimumRevision=0}={}){
  const release=await lock(sourceRoot);
  try{return await syncLocked({sourceRoot,authFile,fetchImpl,signal,minimumRevision});}
  finally{await release();}
}

async function syncLocked({sourceRoot,authFile,fetchImpl,signal,minimumRevision}){
  const config=JSON.parse(await fs.readFile(path.join(sourceRoot,'design/plasmic/card-layout.json'),'utf8'));
  const directory=path.join(sourceRoot,'src/plasmic'),before=await localState(sourceRoot);
  const auth=await readAuth(authFile);
  const response=await fetchImpl(`https://codegen-origin.plasmic.app/api/v1/projects/${projectId}/code/components?branchName=main`,{
    method:'POST',headers:headers(auth),
    body:JSON.stringify({platform:'react',version:'latest',componentIdOrNames:[config.componentName,...['Header','Alerts','List','Footer'].map(name=>`ResourceCard${name}Region`)],imageOpts:{scheme:'inlined'},fontOpts:{scheme:'none'},stylesOpts:{scheme:'css-modules'},codeOpts:{lang:'ts',reactRuntime:'classic'}}),
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)
  });
  checkResponse(response);
  const bundle=await response.json();
  let files;
  try{files=codegenFiles(bundle,config);}
  catch(error){throw new SyncError('validation',error.message);}
  if(!Number.isSafeInteger(bundle.projectConfig.revision)||bundle.projectConfig.revision<Math.max(before.revision,minimumRevision))throw new SyncError('validation','Codegen returned an outdated revision; no local files changed.');
  const state={schema:1,projectId,component:config.componentName,revision:bundle.projectConfig.revision,files:Object.fromEntries([...files].map(([name,body])=>[name,digest(body)]))};
  // A long network request must not overwrite edits made while it was pending.
  if(JSON.stringify(await localState(sourceRoot))!==JSON.stringify(before))throw new SyncError('local-edits','Layout metadata changed during sync; no local files changed.');
  signal?.throwIfAborted();
  const changed=JSON.stringify(state.files)!==JSON.stringify(before.files);
  const result={mode:'synced',projectId,component:state.component,revision:state.revision,files:files.size,changed};
  if(!changed&&state.revision===before.revision)return result;
  // Finish all validation before replacing this managed folder. No wrapper or
  // business source is a codegen output; ordinary builds only read these files.
  const stage=await fs.mkdtemp(path.join(sourceRoot,'src/.plasmic-'));
  const backup=path.join(sourceRoot,`src/.plasmic-backup-${process.pid}`);
  try{
    for(const [name,body]of files)await fs.writeFile(path.join(stage,name),body);
    await fs.writeFile(path.join(stage,manifestName),JSON.stringify(state,null,2)+'\n');
    signal?.throwIfAborted();
    if(JSON.stringify(await localState(sourceRoot))!==JSON.stringify(before))throw new SyncError('local-edits','Layout metadata changed during sync; no local files changed.');
    await fs.rename(directory,backup).catch(error=>{if(error.code!=='ENOENT')throw error;});
    try{await fs.rename(stage,directory);}catch(error){await fs.rename(backup,directory).catch(()=>{});throw error;}
    await fs.rm(backup,{recursive:true,force:true});
  }finally{await fs.rm(stage,{recursive:true,force:true});}
  return result;
}

async function main(){
  const args=process.argv.slice(2),config=JSON.parse(await fs.readFile(path.join(root,'design/plasmic/card-layout.json'),'utf8'));
  if(args.length>1||args.some(arg=>!['--apply','--check'].includes(arg)))throw Error('Usage: pnpm plasmic:sync [--check | --apply] (PLASMIC_AUTH_FILE points to private credentials)');
  if(args.includes('--apply')){console.log(JSON.stringify(await syncLayout()));return;}
  const state=await localState();
  console.log(JSON.stringify({mode:args.includes('--check')?'verified':'plan',projectId,component:config.componentName,revision:state.revision}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
