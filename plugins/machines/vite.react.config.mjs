import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {resolve} from 'node:path';

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
    // Fleet shares this directory; incremental editor builds must preserve it.
    // The full plugin packager owns cleaning the build directory.
    emptyOutDir: false,
    sourcemap: false,
    minify: 'esbuild',
    lib: {
      entry: resolve(root, 'src/widget-editor/main.tsx'),
      formats: ['es'],
      fileName: () => 'widget-editor.js',
      cssFileName: 'widget-editor'
    }
  }
});
