import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {defineConfig} from 'vite';
import {inlineCommonHtml} from '../../scripts/inline-common.mjs';
import {plasmicAutoSync} from './scripts/plasmic-watch.mjs';

const root = import.meta.dirname;
export default defineConfig(({command,mode}) => {
  const card=mode==='card';
  return {
    root, base: './',
    plugins: [react(), tailwindcss(), ...(command==='serve'&&mode==='plasmic'?[plasmicAutoSync()]:[]), ...(command === 'serve' ? [{
      name: 'resource-monitor-preview',
      transformIndexHtml(html) {
        return inlineCommonHtml(html.replace(/<link rel="stylesheet" href="react\/(?:monitor|card)\.css">/g, '')
          .replace('<script src="react/monitor.js"></script>', '<script type="module" src="/src/main.tsx"></script>')
          .replace('<script src="react/card.js"></script>', '<script type="module" src="/src/card-main.tsx"></script>'), {scriptPrefix:'/__common'});
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/') {res.writeHead(302, {Location: '/ui/index.html'}); res.end();} else next();
        });
        // Preview uses the same external theme script as packaged pages.
        server.middlewares.use('/__common', (req, res, next) => {
          if(req.url?.split('?')[0]!=='/flowhub-theme.js')return next();
          res.setHeader('Content-Type','text/javascript; charset=utf-8');
          readFile(resolve(root,'../common/ui/flowhub-theme.js'),'utf8')
            .then(code=>res.end(code)).catch(next);
        });
      }
    }] : [])],
    resolve: {alias: {react:resolve(root,'node_modules/react'),'react-dom':resolve(root,'node_modules/react-dom')},dedupe:['react','react-dom']},
    define: command === 'build' ? {'process.env.NODE_ENV':JSON.stringify('production')} : {},
    server: {strictPort:true,fs:{allow:[resolve(root,'../../../..')]},...(mode==='plasmic'?{
      // Studio owns an editor inside this host. Backend builds, test fixtures
      // and documentation must not reset that editor through a full reload.
      watch:{ignored:['**/build/**','**/bin/**','**/backend/**','**/docs/**',resolve(root,'design/**'),'**/tests/**','**/scripts/**','**/*.md','**/src/.plasmic-*','**/src/.plasmic-*/**','**/src/plasmic/**']}
    }:{})},
    build: {
      ...(card?{minify:'terser',terserOptions:{ecma:2020,compress:{passes:3}}}:{}),
      outDir:resolve(root,'build/ui/react'),emptyOutDir:false,sourcemap:false,
      lib:{entry:resolve(root,card?'src/card-main.tsx':'src/main.tsx'),formats:['iife'],name:card?'FlowHubResourceCard':'FlowHubResourceMonitor',fileName:()=>card?'card.js':'monitor.js',cssFileName:card?'card':'monitor'}
    }
  };
});
