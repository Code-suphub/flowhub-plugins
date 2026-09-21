import {resolve} from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {defineConfig} from 'vite';
import {inlineCommonHtml} from '../../scripts/inline-common.mjs';

const root = import.meta.dirname;
export default defineConfig(({command}) => ({
  root, base: './',
  plugins: [react(), tailwindcss(), ...(command === 'serve' ? [{
    name: 'twofa-preview',
    transformIndexHtml(html) {
      return inlineCommonHtml(html.replace('<link rel="stylesheet" href="react/twofa.css">', '')
        .replace('<script src="react/twofa.js"></script>', '<script type="module" src="/src/main.tsx"></script>'));
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/') { res.writeHead(302, {Location: '/ui/index.html'}); res.end(); }
        else next();
      });
    }
  }] : [])],
  resolve: {
    alias: {react: resolve(root, 'node_modules/react'), 'react-dom': resolve(root, 'node_modules/react-dom')},
    dedupe: ['react', 'react-dom']
  },
  define: command === 'build' ? {'process.env.NODE_ENV': JSON.stringify('production')} : {},
  server: {strictPort: true},
  build: {
    outDir: resolve(root, 'build/ui/react'), emptyOutDir: false, sourcemap: false,
    lib: {entry: resolve(root, 'src/main.tsx'), formats: ['iife'], name: 'FlowHubTwofa',
      fileName: () => 'twofa.js', cssFileName: 'twofa'}
  }
}));
