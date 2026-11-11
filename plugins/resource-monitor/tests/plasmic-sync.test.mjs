import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {assertManaged,codegenFiles} from '../scripts/plasmic-sync.mjs';
const config={projectId:'rKroot8WmpiogJg8366SaB',componentName:'ResourceMonitorCardLayout',bindings:['header','alerts','list','footer']};
const fixture=()=>({projectConfig:{projectId:config.projectId,cssFileName:'plasmic.css',cssRules:'.root{}'},components:[{
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
