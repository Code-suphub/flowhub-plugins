import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export function manifest(id){
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))throw Error('Invalid plugin ID');
  const dir=path.join(root,'plugins',id),m=json(path.join(dir,'flowhub-plugin.json'));
  if(m.id!==id||m.schema!==2||!/^\d+\.\d+\.\d+$/.test(m.version))throw Error('Invalid manifest');
  const pkg=json(path.join(dir,'package.json'));
  const cargo=fs.readFileSync(path.join(dir,'backend/Cargo.toml'),'utf8').match(/\[package\][\s\S]*?version\s*=\s*"([^"]+)"/);
  if(pkg.version!==m.version||cargo?.[1]!==m.version)throw Error('Plugin versions must match');
  return {dir,m};
}
export function parseTag(tag){const match=/^([a-z0-9]+(?:-[a-z0-9]+)*)-v(\d+\.\d+\.\d+)$/.exec(tag);if(!match)throw Error('Expected <plugin>-vX.Y.Z');const {m}=manifest(match[1]);if(m.version!==match[2])throw Error('Tag does not match plugin version');return m.id;}
export function changedPlugins(files,ids){return ids.filter(id=>files.some(f=>f.startsWith(`plugins/${id}/`)||f.startsWith('scripts/')||f.startsWith('.github/')||f==='package.json'));}
function plan(){
  const ids=fs.readdirSync(path.join(root,'plugins')).filter(id=>fs.existsSync(path.join(root,'plugins',id,'flowhub-plugin.json')));
  const release=process.env.GITHUB_REF_TYPE==='tag';
  let selected;
  if(release)selected=[parseTag(process.env.GITHUB_REF_NAME)];
  else {
    const event=json(process.env.GITHUB_EVENT_PATH);
    const base=event.pull_request?.base.sha||event.before;
    const files=base&&!/^0+$/.test(base)?execFileSync('git',['diff','--name-only',base,'HEAD'],{encoding:'utf8'}).trim().split('\n'):['scripts/'];
    selected=changedPlugins(files,ids);
  }
  const include=selected.flatMap(plugin=>[{plugin,runner:'macos-15',target:'macos-aarch64'},{plugin,runner:'macos-15-intel',target:'macos-x86_64'}]);
  fs.appendFileSync(process.env.GITHUB_OUTPUT,`matrix=${JSON.stringify({include})}\nhas_jobs=${include.length>0}\nrelease=${release}\n`);
}
function bundle(id,target){
  const {dir,m}=manifest(id);
  if(target!==`macos-${process.arch==='arm64'?'aarch64':process.arch==='x64'?'x86_64':'unsupported'}`||process.platform!=='darwin')throw Error('Runner architecture mismatch');
  const files={};
  const add=relative=>{const full=path.join(dir,relative),stat=fs.lstatSync(full);if(stat.isSymbolicLink())throw Error('Symlinks not allowed');if(stat.isDirectory()){for(const name of fs.readdirSync(full).sort())add(`${relative}/${name}`);}else if(stat.isFile())files[relative]=fs.readFileSync(full).toString('base64');else throw Error('Unsupported file');};
  add('flowhub-plugin.json');add('ui');add(m.executable);
  if(!files[m.ui])throw Error('Missing entry page');
  fs.mkdirSync('release-output',{recursive:true});
  const name=`${id}-${m.version}-${target}.fhplugin`,output=path.join('release-output',name);
  const bytes=Buffer.from(JSON.stringify({schema:2,files}));if(bytes.length>192*1024*1024)throw Error('Bundle too large');fs.writeFileSync(output,bytes);
  execFileSync('minisign',['-S','-s',process.env.PLUGIN_SIGNING_KEY_FILE,'-m',output,'-x',`${output}.minisig`]);
  execFileSync('minisign',['-V','-p','release-key.pub','-m',output,'-x',`${output}.minisig`]);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(`${output}.sha256`,`${sha256}  ${name}\n`);
  const entry={manifest:m,target,sha256,signature:fs.readFileSync(`${output}.minisig`,'utf8'),url:`https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${process.env.GITHUB_REF_NAME}/${name}`};
  fs.writeFileSync(path.join('release-output',`${target}.json`),JSON.stringify(entry,null,2)+'\n');
}
function catalog(){
  const entries=fs.readdirSync('release-output').filter(n=>/^macos-.*\.json$/.test(n)).map(n=>json(path.join('release-output',n)));
  const id=parseTag(process.env.GITHUB_REF_NAME);
  if(entries.length!==2||new Set(entries.map(e=>e.target)).size!==2||entries.some(e=>e.manifest.id!==id||e.manifest.version!==manifest(id).m.version))throw Error('Incomplete release');
  for(const e of entries){const name=e.url.split('/').at(-1),file=path.join('release-output',name);if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==e.sha256)throw Error('Hash mismatch');execFileSync('minisign',['-V','-p','release-key.pub','-m',file,'-x',`${file}.minisig`]);}
  fs.writeFileSync('release-output/catalog.json',JSON.stringify({schema:2,plugins:entries},null,2)+'\n');
  fs.copyFileSync('release-key.pub','release-output/release-key.pub');
  for(const e of entries)fs.unlinkSync(path.join('release-output',`${e.target}.json`));
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [cmd,id,target]=process.argv.slice(2);
  if(cmd==='plan')plan();else if(cmd==='bundle')bundle(id,target);else if(cmd==='catalog')catalog();else throw Error('Unknown release command');
}
