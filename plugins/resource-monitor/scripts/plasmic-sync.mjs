import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const projectId='rKroot8WmpiogJg8366SaB';
const digest=value=>createHash('sha256').update(value).digest('hex');
const manifestName='generated.json';

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

async function main(){
  const args=process.argv.slice(2),config=JSON.parse(await fs.readFile(path.join(root,'design/plasmic/card-layout.json'),'utf8'));
  if(args.some(arg=>!['--apply','--check'].includes(arg)))throw Error('Usage: pnpm plasmic:sync [--check | --apply] (PLASMIC_AUTH_FILE points to private credentials)');
  const directory=path.join(root,'src/plasmic');
  await assertManaged(directory);
  if(!args.includes('--apply')){
    const state=await fs.readFile(path.join(directory,manifestName),'utf8').then(JSON.parse).catch(()=>null);
    if(args.includes('--check')&&!state)throw Error('The synced card layout is missing.');
    console.log(JSON.stringify({mode:args.includes('--check')?'verified':'plan',projectId,component:config.componentName,revision:state?.revision??null}));return;
  }
  const authFile=process.env.PLASMIC_AUTH_FILE;
  if(!authFile)throw Error('Set PLASMIC_AUTH_FILE to your existing private Plasmic auth file.');
  const auth=JSON.parse(await fs.readFile(authFile,'utf8'));
  if(auth.host!=='https://studio.plasmic.app'||!auth.user||!auth.token)throw Error('Expected official Plasmic credentials.');
  const response=await fetch(`https://codegen-origin.plasmic.app/api/v1/projects/${projectId}/code/components?branchName=main`,{
    method:'POST',headers:{'Content-Type':'application/json','x-plasmic-api-user':auth.user,'x-plasmic-api-token':auth.token},
    body:JSON.stringify({platform:'react',version:'latest',componentIdOrNames:[config.componentName,...['Header','Alerts','List','Footer'].map(name=>`ResourceCard${name}Region`)],imageOpts:{scheme:'inlined'},fontOpts:{scheme:'none'},stylesOpts:{scheme:'css-modules'},codeOpts:{lang:'ts',reactRuntime:'classic'}}),
    signal:AbortSignal.timeout(90000)
  });
  if(!response.ok)throw Error(`Codegen HTTP ${response.status}; no local files changed.`);
  const bundle=await response.json(),files=codegenFiles(bundle,config);
  // Finish all validation before replacing this managed folder. No wrapper or
  // business source is a codegen output; ordinary builds only read these files.
  const stage=await fs.mkdtemp(path.join(root,'src/.plasmic-'));
  const backup=path.join(root,`src/.plasmic-backup-${process.pid}`);
  const state={schema:1,projectId,component:config.componentName,revision:bundle.projectConfig.revision,files:Object.fromEntries([...files].map(([name,body])=>[name,digest(body)]))};
  try{
    for(const [name,body]of files)await fs.writeFile(path.join(stage,name),body);
    await fs.writeFile(path.join(stage,manifestName),JSON.stringify(state,null,2)+'\n');
    await fs.rename(directory,backup).catch(error=>{if(error.code!=='ENOENT')throw error;});
    try{await fs.rename(stage,directory);}catch(error){await fs.rename(backup,directory).catch(()=>{});throw error;}
    await fs.rm(backup,{recursive:true,force:true});
  }finally{await fs.rm(stage,{recursive:true,force:true});}
  console.log(JSON.stringify({mode:'synced',projectId,component:state.component,revision:state.revision,files:files.size}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
