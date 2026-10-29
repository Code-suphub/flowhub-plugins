import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
const root=resolve(fileURLToPath(new URL('../ui/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
createServer((req,res)=>{
  let file;
  try { file=resolve(root,'.'+decodeURIComponent((req.url||'/').split('?')[0])); }
  catch {res.writeHead(400).end();return;}
  if(file!==root && !file.startsWith(root+sep)){res.writeHead(403).end();return;}
  if(file===root)file=resolve(root,'index.html');
  try {res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'no-store'}).end(readFileSync(file));}
  catch{res.writeHead(404).end();}
}).listen(5188,'127.0.0.1',()=>console.log('Device Center preview: http://127.0.0.1:5188'));
