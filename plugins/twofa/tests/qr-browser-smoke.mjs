import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import QRCode from 'qrcode';
// Public RFC test secret only; all files and accounts live in this disposable directory.
const uri='otpauth://totp/Example:public?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example';
const directory=mkdtempSync('/tmp/flowhub-twofa-qr-'),base=fileURLToPath(new URL('../build/',import.meta.url)),pending=new Map();let serial=0;
await QRCode.toFile(directory+'/public.png',uri,{width:360,margin:4});
const child=spawn('./bin/flowhub-twofa',[],{env:{...process.env,FLOWHUB_PLUGIN_DATA:directory+'/data'},stdio:['pipe','pipe','inherit']});
createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line),item=pending.get(response.id);if(!item)return;clearTimeout(item.timer);pending.delete(response.id);response.error?item.reject(Error(response.error)):item.resolve(response.result);});
function call(method,params){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
const host=`<!doctype html><meta charset="utf-8"><title>2FA QR 隔离验收</title><style>body{margin:0}iframe{display:block;width:100%;height:100dvh;border:0}</style><iframe title="2FA 插件" src="/ui/index.html"></iframe><script>const frame=document.querySelector('iframe');addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.data?.type!=='flowhub:request')return;const{id,method,params}=event.data;const reply=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,params})}).then(r=>r.json());frame.contentWindow.postMessage({type:'flowhub:response',id,...reply},location.origin);});</script>`;
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://fixture');
 if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(host);return;}
 if(url.pathname==='/rpc'&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>20000){res.writeHead(413).end();return;}}try{const {method,params={}}=JSON.parse(body);if(!['list','code','preview_import','import'].includes(method)||['preview_import','import'].includes(method)&&params.uri!==uri)throw Error('隔离验证仅处理公开测试二维码');res.end(JSON.stringify({result:await call(method,params)}));}catch(error){res.end(JSON.stringify({error:error.message}));}return;}
 const file=path.resolve(base,'.'+url.pathname);if(!file.startsWith(base)){res.writeHead(403).end();return;}
 try{const bytes=readFileSync(file),headers={'Content-Type':{'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'};if(file.endsWith('.html'))headers['Content-Security-Policy']="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'";res.writeHead(200,headers).end(bytes);}catch{res.writeHead(404).end();}
});
try{await new Promise(resolve=>server.listen(5206,'127.0.0.1',resolve));console.log('Isolated 2FA QR UI ready on 5206; public fixture '+directory+'/public.png');await new Promise(resolve=>process.once('SIGINT',resolve));}
finally{child.kill();for(const item of pending.values())clearTimeout(item.timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
