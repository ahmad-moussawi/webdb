import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['src/react/**/*', 'src/angular/**/*', 'src/vue/**/*', 'src/migrations/**/*', 'src/search/**/*', 'src/intl/**/*', 'src/index.ts', 'src/host/api/live_query.ts', 'src/types/**/*'],
      entryRoot: 'src',
      outDir: 'dist',
      beforeWriteFile: (filePath, content) => {
        if (filePath.endsWith('migrations/index.d.ts')) {
          return {
            filePath: resolve(__dirname, 'dist/migrations.d.ts'),
            content,
          };
        }
        if (filePath.endsWith('search/index.d.ts')) {
          return {
            filePath: resolve(__dirname, 'dist/search.d.ts'),
            content,
          };
        }
        if (filePath.endsWith('intl/index.d.ts')) {
          return {
            filePath: resolve(__dirname, 'dist/intl.d.ts'),
            content,
          };
        }
        if (filePath.endsWith('react/index.d.ts')) {
          return {
            filePath: resolve(__dirname, 'dist/react.d.ts'),
            content,
          };
        }
        if (filePath.endsWith('angular/index.d.ts')) {
          return {
            filePath: resolve(__dirname, 'dist/angular.d.ts'),
            content: content.replace(/\/\/\/\s*<reference path="\.\/*peer-types\.d\.ts"\s*\/>\s*/g, ''),
          };
        }
        if (filePath.endsWith('vue/index.d.ts')) {
          return {
            filePath: resolve(__dirname, 'dist/vue.d.ts'),
            content: content.replace(/\/\/\/\s*<reference path="\.\/*peer-types\.d\.ts"\s*\/>\s*/g, ''),
          };
        }
        return false;
      },
    }),
  ],
  build: {
    emptyOutDir: false,
    lib: {
      entry: {
        migrations: resolve(__dirname, 'src/migrations/index.ts'),
        search: resolve(__dirname, 'src/search/index.ts'),
        intl: resolve(__dirname, 'src/intl/index.ts'),
        react: resolve(__dirname, 'src/react/index.ts'),
        angular: resolve(__dirname, 'src/angular/index.ts'),
        vue: resolve(__dirname, 'src/vue/index.ts'),
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) =>
        `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: [
        '@ahmadmoussawi/webdb',
        'react',
        '@angular/core',
        'rxjs',
        'vue',
      ],
    },
    sourcemap: true,
  },
});

