import { describe, it, expect } from 'vitest';
import { TsToCTranspiler } from '../scripts/transpiler/transpiler.ts';

describe('TypeScript-to-C Core Transpiler', () => {
  it('transpiles simple arithmetic and bitwise functions', () => {
    const tsCode = `
      export function add_and_hash(a: u32, b: u32, mask: u32): u32 {
        const sum = a + b;
        return ((sum ^ (sum >>> 16)) >>> 0) & mask;
      }
    `;

    const transpiler = new TsToCTranspiler();
    const result = transpiler.transpile(tsCode, 'test_hash.c.ts');

    expect(result.cSource).toContain('uint32_t add_and_hash(uint32_t a, uint32_t b, uint32_t mask)');
    expect(result.cSource).toContain('uint32_t sum = a + b;');
    expect(result.hHeader).toContain('uint32_t add_and_hash(uint32_t a, uint32_t b, uint32_t mask);');
  });

  it('transpiles memory loads and stores with DataView stripping', () => {
    const tsCode = `
      export function read_and_write(view: DataView, offset: u32, val: u32): u32 {
        const old_val = view.getUint32(offset, true);
        view.setUint32(offset, val, true);
        return old_val;
      }
    `;

    const transpiler = new TsToCTranspiler({ stripDataView: true });
    const result = transpiler.transpile(tsCode, 'test_mem.c.ts');

    expect(result.cSource).toContain('uint32_t read_and_write(uint32_t offset, uint32_t val)');
    expect(result.cSource).toContain('load_u32((const void *)(uintptr_t)(offset))');
    expect(result.cSource).toContain('store_u32((void *)(uintptr_t)(offset), val)');
  });

  it('transpiles loops, conditional breaks, and error returns', () => {
    const tsCode = `
      export function find_entry(offset: u32, count: u32, target: u32): i32 {
        for (let i = 0; i < count; i++) {
          if (i === target) {
            return i;
          }
        }
        return -1;
      }
    `;

    const transpiler = new TsToCTranspiler();
    const result = transpiler.transpile(tsCode, 'test_loop.c.ts');

    expect(result.cSource).toContain('int32_t find_entry(uint32_t offset, uint32_t count, uint32_t target)');
    expect(result.cSource).toContain('for (uint32_t i = 0; i < count; i++)');
    expect(result.cSource).toContain('if (i == target)');
    expect(result.cSource).toContain('return -1;');
  });

  it('supports @manual_c with external implementation (skips C body, emits header export)', () => {
    const tsCode = `
      /**
       * @export_c
       * @manual_c
       */
      export function complex_btree_operation(node_offset: u32, key: u32): i32 {
        // High-level JS implementation for host engine & vitest
        return 42;
      }
    `;

    const transpiler = new TsToCTranspiler();
    const result = transpiler.transpile(tsCode, 'test_manual.c.ts');

    // Header must contain the export signature so C callers know about it
    expect(result.hHeader).toContain('WEBDB_EXPORT int32_t complex_btree_operation(uint32_t node_offset, uint32_t key);');
    // C source must NOT contain the transpiled function body
    expect(result.cSource).not.toContain('int32_t complex_btree_operation');
    expect(result.cSource).not.toContain('return 42');
  });

  it('supports @manual_c with inline C block (emits verbatim C implementation)', () => {
    const tsCode = `
      /**
       * @export_c
       * @manual_c
       * \`\`\`c
       * WEBDB_EXPORT uint32_t fast_crc32(uint32_t crc, const uint8_t *buf, uint32_t len) {
       *   // Hand-optimized C version
       *   return crc ^ len;
       * }
       * \`\`\`
       */
      export function fast_crc32(crc: u32, buf: Uint8Array, len: u32): u32 {
        return (crc ^ len) >>> 0;
      }
    `;

    const transpiler = new TsToCTranspiler();
    const result = transpiler.transpile(tsCode, 'test_inline_c.c.ts');

    expect(result.cSource).toContain('// Hand-optimized C version');
    expect(result.cSource).toContain('return crc ^ len;');
    expect(result.hHeader).toContain('WEBDB_EXPORT uint32_t fast_crc32(uint32_t crc, uint8_t * buf, uint32_t len);');
  });

  it('supports @use_c alias and call rewriting', () => {
    const tsCode = `
      /**
       * @export_c
       * @use_c: c_fast_checksum
       */
      export function checksum(ptr: u32): u32 {
        return 123;
      }

      /**
       * @export_c
       */
      export function verify_page(page_offset: u32): i32 {
        const sum = checksum(page_offset);
        return sum > 0 ? 1 : 0;
      }
    `;

    const transpiler = new TsToCTranspiler();
    const result = transpiler.transpile(tsCode, 'test_alias.c.ts');

    expect(result.hHeader).toContain('WEBDB_EXPORT uint32_t c_fast_checksum(uint32_t ptr);');
    // Function call inside verify_page must be rewritten to c_fast_checksum
    expect(result.cSource).toContain('uint32_t sum = c_fast_checksum(page_offset);');
  });

  it('supports c_inline compile-time intrinsic and companion file inclusion', () => {
    const tsCode = `
      /**
       * @c_include "custom_math.h"
       * @export_c
       */
      export function compute_square(x: u32): u32 {
        return c_inline("__builtin_clz(x)", x * x);
      }
    `;

    const transpiler = new TsToCTranspiler({ companionFile: 'test.manual.c' });
    const result = transpiler.transpile(tsCode, 'test_inline.c.ts');

    expect(result.cSource).toContain('#include "custom_math.h"');
    expect(result.cSource).toContain('return __builtin_clz(x);');
    expect(result.cSource).toContain('#include "test.manual.c"');
  });
});
