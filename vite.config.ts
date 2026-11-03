import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*'],
      entryRoot: 'src',
      rollupTypes: true,
    }),
  ],
  resolve: {
    alias: {
      '@ahmadmoussawi/webdb': resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    testTimeout: 30000,
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'WebDB',
      formats: ['es', 'umd'],
      fileName: (format) => `webdb.${format === 'es' ? 'js' : 'umd.cjs'}`,
    },
    sourcemap: true,
  },
});
