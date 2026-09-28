import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'benchmark'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/benchmark'),
    emptyOutDir: true,
  },
  server: {
    port: 3001,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  resolve: {
    alias: {
      '@webdb/core': resolve(__dirname, 'src/index.ts'),
    },
  },
});
