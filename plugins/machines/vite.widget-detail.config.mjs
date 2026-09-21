import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
const root = import.meta.dirname;
export default defineConfig({ root, base: './', plugins: [react(), tailwindcss()], define: { 'process.env.NODE_ENV': JSON.stringify('production') }, resolve: { alias: { react: resolve(root, 'node_modules/react'), 'react-dom': resolve(root, 'node_modules/react-dom') }, dedupe: ['react', 'react-dom'] }, build: { outDir: resolve(root, 'build/ui/widget'), emptyOutDir: false, sourcemap: false, minify: 'esbuild', lib: { entry: resolve(root, 'src/widget/detail.tsx'), formats: ['iife'], name: 'FlowHubWidgetDetail', fileName: () => 'detail.js', cssFileName: 'detail' } } });
