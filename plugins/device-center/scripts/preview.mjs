import {createServer} from 'node:http';
import {readFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
const root=resolve(fileURLToPath(new URL('../ui/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'};
const port=Number(process.env.FLOWHUB_PREVIEW_PORT||5188);
const server=createServer((req,res)=>{
  let path;
  try{path=resolve(root,'.'+decodeURIComponent((req.url||'/').split(/[?#]/)[0]));}
  catch{res.writeHead(400).end('Bad request');return;}
  if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403).end('Forbidden');return;}
  if(path===root)path=resolve(root,'index.html');
  try{if(!statSync(path).isFile())throw Error('not a file');res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream','cache-control':'no-store'}).end(readFileSync(path));}
  catch{res.writeHead(404).end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log(`FlowHub Device Center preview: http://127.0.0.1:${port}/index.html`));
