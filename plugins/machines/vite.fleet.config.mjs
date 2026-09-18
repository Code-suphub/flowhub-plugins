import {resolve} from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  root,
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  resolve: {
    alias: {
      react: resolve(root, 'node_modules/react'),
      'react-dom': resolve(root, 'node_modules/react-dom')
    },
    dedupe: ['react', 'react-dom']
  },
  build: {
    outDir: resolve(root, 'build/ui/react'),
    emptyOutDir: false,
    sourcemap: false,
    minify: 'esbuild',
    lib: {
      entry: resolve(root, 'src/fleet/main.tsx'),
      formats: ['iife'],
      name: 'FlowHubFleetBundle',
      fileName: () => 'fleet.js',
      cssFileName: 'fleet'
    }
  }
});
