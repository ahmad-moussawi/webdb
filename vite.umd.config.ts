import { resolve } from 'path';
import { defineConfig } from 'vite';

/**
 * Single-file UMD/CJS build for legacy CommonJS and `<script>` tag consumers.
 * Dynamic imports are intentionally inlined here so UMD stays self-contained,
 * while the primary ESM build (`vite.config.ts`) code-splits engines and VFS adapters.
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'WebDB',
      formats: ['umd'],
      fileName: () => 'webdb.umd.cjs',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    sourcemap: true,
  },
});
