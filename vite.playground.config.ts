import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'playground'),
  base: process.env.PLAYGROUND_BASE || './',
  build: {
    outDir: process.env.PLAYGROUND_OUT_DIR
      ? resolve(__dirname, process.env.PLAYGROUND_OUT_DIR)
      : resolve(__dirname, 'docs/public/playground'),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      '@ahmadmoussawi/webdb': resolve(__dirname, 'src/index.ts'),
    },
  },
});
