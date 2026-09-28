import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'playground'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'docs/public/playground'),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      '@webdb/core': resolve(__dirname, 'src/index.ts'),
    },
  },
});
