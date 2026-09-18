import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {inlineCommonHtml} from '../../../scripts/inline-common.mjs';
const root=resolve('ui');
createServer(async(req,res)=>{
  try {
    const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));
    if(!path.startsWith(root+sep))throw Error('invalid path');
    const raw=await readFile(path,'utf8');
    const data=extname(path)==='.html'?inlineCommonHtml(raw):raw;
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(path)]||'text/plain');
    res.end(data);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(5184,'127.0.0.1',()=>console.log('只读模拟预览：http://127.0.0.1:5184'));
