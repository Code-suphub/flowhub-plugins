import {defineConfig} from 'vite';
import {readFileSync} from 'node:fs';
export default defineConfig({
  root:'ui',server:{host:'127.0.0.1',port:5183,strictPort:true},
  plugins:[{name:'isolated-preview',configureServer(server){
    const fixture=new URL('./dev/machines-preview.js',import.meta.url);
    server.watcher.add(fixture.pathname);server.watcher.on('change',p=>{if(p===fixture.pathname)server.ws.send({type:'full-reload'});});
    server.middlewares.use('/__machines-preview.js',(_req,res)=>{res.setHeader('Content-Type','text/javascript');res.end(readFileSync(fixture,'utf8'));});
  },transformIndexHtml(html){return html.replace('<script src="plugin-bridge.js">','<script src="/__machines-preview.js"></script><script src="plugin-bridge.js">');}}]
});
