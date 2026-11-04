import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*'],
      exclude: ['src/react/**/*', 'src/angular/**/*', 'src/vue/**/*'],
      entryRoot: 'src',
      rollupTypes: true,
    }),
  ],
  resolve: {
    alias: {
      '@ahmadmoussawi/webdb/react': resolve(__dirname, 'src/react/index.ts'),
      '@ahmadmoussawi/webdb/angular': resolve(__dirname, 'src/angular/index.ts'),
      '@ahmadmoussawi/webdb/vue': resolve(__dirname, 'src/vue/index.ts'),
      '@ahmadmoussawi/webdb': resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    testTimeout: 30000,
    alias: {
      '@angular/core': resolve(__dirname, 'tests/helpers/framework_test_harness.ts'),
      'rxjs': resolve(__dirname, 'tests/helpers/framework_test_harness.ts'),
      'vue': resolve(__dirname, 'tests/helpers/framework_test_harness.ts'),
    },
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
