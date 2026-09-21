import {defineConfig} from 'vite';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inlineCommonHtml} from '../../scripts/inline-common.mjs';

const pluginRoot=dirname(fileURLToPath(import.meta.url));
const fleetBuild=join(pluginRoot,'build/ui/react');
const fleetSource=join(pluginRoot,'src/fleet');
const hostEditorSource=join(pluginRoot,'src/host-editor');
const monitoringSource=join(pluginRoot,'src/monitoring');
const trafficSource=join(pluginRoot,'src/traffic');
const historySource=join(pluginRoot,'src/history');
const commandSource=join(pluginRoot,'src/command');
const apiSource=join(pluginRoot,'src/api');
const backupSource=join(pluginRoot,'src/backup');
const collectionsSource=join(pluginRoot,'src/collections');
const commonReact=join(pluginRoot,'../common/src/react');
const buildFleet=()=>execFileSync('npm',['run','build:fleet'],{
  cwd:pluginRoot,
  stdio:'inherit',
  env:{...process.env,NODE_ENV:'production'}
});
const buildWidgets=()=>{
  execFileSync('npm',['run','build:widget-editor'],{cwd:pluginRoot,stdio:'inherit'});
  for(const name of ['card','detail']) execFileSync('npx',['vite','build','--config',`vite.widget-${name}.config.mjs`],{cwd:pluginRoot,stdio:'inherit'});
};

export default defineConfig({
  root:'ui',server:{host:'127.0.0.1',port:5183,strictPort:true,cors:{origin:/^(?:null|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/}},
  plugins:[{name:'isolated-preview',configureServer(server){
    buildFleet();
    buildWidgets();
    server.middlewares.use((request,response,next)=>{
      if(request.url==='/'||request.url==='/index.html'){
        response.statusCode=302;response.setHeader('Location','/machines.html');response.end();return;
      }
      next();
    });
    server.middlewares.use('/react/',(request,response,next)=>{
      const name=new URL(request.url,'http://local').pathname.replace(/^\/+/, '');
      if(!['fleet.js','fleet.css','widget-editor.js','widget-editor.css'].includes(name)){next();return;}
      response.setHeader('Content-Type',name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
      response.setHeader('Cache-Control','no-store');
      response.end(readFileSync(join(fleetBuild,name)));
    });
    server.middlewares.use('/widget/',(request,response,next)=>{
      const name=new URL(request.url,'http://local').pathname.replace(/^\/+/, '');
      if(!['card.js','card.css','detail.js','detail.css'].includes(name)){next();return;}
      response.setHeader('Content-Type',name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
      response.setHeader('Cache-Control','no-store');
      response.end(readFileSync(join(pluginRoot,'build/ui/widget',name)));
    });
    const fixture=new URL('./dev/machines-preview.js',import.meta.url);
    const commonFiles=[new URL('../common/ui/flowhub-common.js',import.meta.url).pathname,new URL('../common/ui/flowhub-common.css',import.meta.url).pathname];
    const reactSources=[fleetSource,hostEditorSource,monitoringSource,trafficSource,historySource,commandSource,apiSource,backupSource,collectionsSource,commonReact];
    const widgetSources=[join(pluginRoot,'src/widget'),join(pluginRoot,'src/widget-editor'),join(pluginRoot,'ui/widget/card.css'),join(pluginRoot,'ui/widget/detail.css')];
    server.watcher.add([fixture.pathname,...commonFiles,...reactSources,...widgetSources]);
    let fleetTimer,widgetTimer;
    server.watcher.on('change',p=>{
      if(widgetSources.some(source=>p.startsWith(source))||p.startsWith(commonReact)){
        clearTimeout(widgetTimer);
        widgetTimer=setTimeout(()=>{buildWidgets();server.ws.send({type:'full-reload'});},120);
      }
      if(reactSources.some(source=>p.startsWith(source))){
        clearTimeout(fleetTimer);
        fleetTimer=setTimeout(()=>{buildFleet();server.ws.send({type:'full-reload'});},120);
        return;
      }
      if(p===fixture.pathname||commonFiles.includes(p))server.ws.send({type:'full-reload'});
    });
    server.middlewares.use('/__machines-preview.js',(_req,res)=>{res.setHeader('Content-Type','text/javascript');res.end(readFileSync(fixture,'utf8'));});
  },transformIndexHtml(html){
    const preview=html
      .replace('<script src="plugin-bridge.js">','<script src="/__machines-preview.js"></script><script src="plugin-bridge.js">')
      .replace('<link data-flowhub-fleet rel="stylesheet">','<link rel="stylesheet" href="react/fleet.css">')
      .replace('<script data-flowhub-fleet></script>','<script src="react/fleet.js"></script>');
    return inlineCommonHtml(preview);
  }}]
});
