import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*'],
      exclude: ['src/react/**/*', 'src/angular/**/*', 'src/vue/**/*', 'src/migrations/**/*', 'src/search/**/*'],
      entryRoot: 'src',
      rollupTypes: true,
    }),
  ],
  resolve: {
    alias: {
      '@ahmadmoussawi/webdb/migrations': resolve(__dirname, 'src/migrations/index.ts'),
      '@ahmadmoussawi/webdb/search': resolve(__dirname, 'src/search/index.ts'),
      '@ahmadmoussawi/webdb/intl': resolve(__dirname, 'src/intl/index.ts'),
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
    projects: [
      {
        extends: true,
        test: {
          name: 'js',
          include: ['tests/**/*.test.ts'],
          env: {
            WEBDB_CORE: 'js',
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'wasm',
          include: ['tests/**/*.test.ts'],
          env: {
            WEBDB_CORE: 'wasm',
          },
        },
      },
    ],
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
