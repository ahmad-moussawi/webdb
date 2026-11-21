import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*'],
      exclude: ['src/react/**/*', 'src/angular/**/*', 'src/vue/**/*', 'src/migrations/**/*', 'src/search/**/*', 'src/intl/**/*'],
      entryRoot: 'src',
      beforeWriteFile: (filePath, content) => ({
        filePath,
        content: content.replace(/((?:from|import)\s*\(?\s*['"]\.\.?\/[^'"]+)\.ts(['"])/g, '$1.js$2'),
      }),
    }),
  ],
  resolve: {
    alias: {
      '@ahmadmoussawi/webdb/slim': resolve(__dirname, 'src/slim.ts'),
      '@ahmadmoussawi/webdb/core/js': resolve(__dirname, 'src/core/js/entry.ts'),
      '@ahmadmoussawi/webdb/core/wasm': resolve(__dirname, 'src/core/wasm/entry.ts'),
      '@ahmadmoussawi/webdb/storage/memory': resolve(__dirname, 'src/host/storage/memory.ts'),
      '@ahmadmoussawi/webdb/storage/idb': resolve(__dirname, 'src/host/storage/idb.ts'),
      '@ahmadmoussawi/webdb/storage/opfs': resolve(__dirname, 'src/host/storage/opfs.ts'),
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
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        slim: resolve(__dirname, 'src/slim.ts'),
        'core-js': resolve(__dirname, 'src/core/js/entry.ts'),
        'core-wasm': resolve(__dirname, 'src/core/wasm/entry.ts'),
        'storage-memory': resolve(__dirname, 'src/host/storage/memory.ts'),
        'storage-idb': resolve(__dirname, 'src/host/storage/idb.ts'),
        'storage-opfs': resolve(__dirname, 'src/host/storage/opfs.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) =>
        entryName === 'index' ? 'webdb.js' : `${entryName}.js`,
    },
    rollupOptions: {
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
    sourcemap: true,
  },
});
