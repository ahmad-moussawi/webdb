import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * Node.js build for `@ahmadmoussawi/webdb/storage/node`, `@ahmadmoussawi/webdb/cli`,
 * and the `webdb` CLI binary (`dist/cli.js`).
 *
 * Kept separate from `vite.config.ts` so browser builds never reference `node:*` built-ins.
 */
export default defineConfig({
  define: {
    __WEBDB_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    dts({
      include: [
        'src/cli/node-types.d.ts',
        'src/host/storage/node_fs.ts',
        'src/cli/index.ts',
        'src/cli/commands.ts',
        'src/cli/open.ts',
        'src/host/storage/vfs.ts',
      ],
      entryRoot: 'src',
      outDir: 'dist',
      beforeWriteFile: (filePath, content) => {
        const normalized = content
          .replace(/((?:from|import)\s*\(?\s*['"]\.\.?\/[^'"]+)\.ts(['"])/g, '$1.js$2')
          .replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/g, '\n');
        if (filePath.endsWith('host/storage/node_fs.d.ts')) {
          return {
            filePath: resolve(__dirname, 'dist/storage-node.d.ts'),
            content: normalized.replace(/\.\/vfs\.js/g, './host/storage/vfs.js'),
          };
        }
        if (filePath.endsWith('cli/index.d.ts')) {
          return {
            filePath: resolve(__dirname, 'dist/cli.d.ts'),
            content: [
              "import type { NodeFsStorageOptions } from './storage-node.js';",
              "import { NodeFsStorage } from './storage-node.js';",
              'export type CoreMode = "wasm" | "js";',
              'export interface CliIo {',
              '  stdout(text: string): void;',
              '  stderr(text: string): void;',
              '}',
              'export declare const CLI_VERSION: string;',
              'export declare const HELP_TEXT: string;',
              'export declare function runCli(argv: string[], io?: CliIo): Promise<number>;',
              'export { NodeFsStorage, type NodeFsStorageOptions };',
              '',
            ].join('\n'),
          };
        }
        return false;
      },
    }),
    {
      name: 'webdb-cli-chmod',
      closeBundle() {
        const binPath = resolve(__dirname, 'dist/cli.js');
        if (existsSync(binPath)) {
          chmodSync(binPath, 0o755);
        }
      },
    },
  ],
  build: {
    emptyOutDir: false,
    target: 'node20',
    lib: {
      entry: {
        'storage-node': resolve(__dirname, 'src/host/storage/node_fs.ts'),
        'cli-lib': resolve(__dirname, 'src/cli/index.ts'),
        cli: resolve(__dirname, 'src/cli/bin.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [/^node:/],
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        banner: (chunk) => (chunk.name === 'cli' ? '#!/usr/bin/env node\n' : ''),
      },
    },
    sourcemap: true,
  },
});
