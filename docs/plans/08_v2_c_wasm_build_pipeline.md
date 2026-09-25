# Phase 8 Technical Specification: Future V2 Drop-In Swap & C/Wasm Build Pipeline

## 1. Executive Summary

When upgrading from **Version 1 (JavaScript/TypeScript Reference Engine)** to **Version 2 (Compiled C/WebAssembly)**, the Host JavaScript orchestration layer (Query Builder, VFS, Cache Controller, Transaction Coordinator, Schema Catalog) undergoes **zero code modifications**.

The compiled WebAssembly module exports the exact same numeric FFI entry points (`vm_step`, `vm_init`, `page_defrag`), operates on the exact same shared `ArrayBuffer`, and executes with microsecond-level native CPU speed.

---

## 2. C Codebase Architecture & Directory Layout

The C engine is built as a **Freestanding C99** module with zero dependencies on standard C libraries (`libc`, `stdio.h`, `stdlib.h`):

```
src/c/
├── engine.c          # Primary entry point & FFI export definitions
├── engine.h          # Shared structs (TableDescriptor, ColumnMeta, VmContext, Cursor)
├── page.c            # 4KB Slotted page mechanics, slot directory, compaction
├── btree.c           # Table B+Tree and Secondary Index B-Tree traversal/split
├── vm.c              # Synchronous Bytecode Virtual Machine (VDBE) step loop
├── arena.c           # Transient Query Arena bump allocator & hash table
└── runtime.c         # Zero-libc minimal implementations of memcpy, memset, memcmp
```

---

## 3. Freestanding C Runtime & Zero-Allocation Invariant

1. **Zero `libc` Dependency (`-nostdlib`):**
   - The engine does not link against `musl`, `glibc`, or Emscripten runtime layers.
   - Eliminates all runtime bloat, keeping the binary featherweight.
2. **Minimal Freestanding Primitives (`runtime.c`):**
   ```c
   void *memcpy(void *dest, const void *src, unsigned long n) {
       uint8_t *d = (uint8_t*)dest;
       const uint8_t *s = (const uint8_t*)src;
       while (n--) *d++ = *s++;
       return dest;
   }

   void *memset(void *dest, int c, unsigned long n) {
       uint8_t *d = (uint8_t*)dest;
       while (n--) *d++ = (uint8_t)c;
       return dest;
   }
   ```
3. **Zero Dynamic `malloc` / `free`:**
   - Memory is strictly partitioned within the imported `WebAssembly.Memory`.
   - Dynamic allocations for hash tables and sort buffers draw exclusively from the **Transient Query Arena**, which reclaims memory via `arena_offset = 0`.

---

## 4. Clang WebAssembly Compilation Pipeline

Compiled directly using upstream LLVM / Clang without Emscripten:

```bash
clang --target=wasm32 -O3 -flto -nostdlib \
  -Wl,--no-entry \
  -Wl,--export=vm_init \
  -Wl,--export=vm_step \
  -Wl,--export=page_defrag \
  -Wl,--import-memory \
  -Wl,--strip-all \
  -Wl,--lto-O3 \
  -o dist/engine.wasm src/c/engine.c
```

### 4.1 Flag Explanations:
- `--target=wasm32`: Targets 32-bit WebAssembly bytecode.
- `-nostdlib`: Bypasses standard C library linking.
- `-Wl,--no-entry`: Declares a library module without `main()`.
- `-Wl,--import-memory`: Instructs Wasm to import `memory` from JavaScript (`importObject.env.memory`), sharing the Host's `ArrayBuffer`.
- `-Wl,--strip-all`: Strips debug symbols and dead code.
- `-flto -Wl,--lto-O3`: Performs aggressive Link-Time Optimization across C files.

---

## 5. Binary Size Budget Breakdown

| Subsystem | Estimated Uncompressed Wasm | Estimated Gzipped Wasm |
| :--- | :---: | :---: |
| **Slotted Page Engine & Compaction** | 18 KB | ~5 KB |
| **B+Tree Balanced Traversal & Splitting** | 36 KB | ~10 KB |
| **VDBE Bytecode VM Loop & Opcodes** | 28 KB | ~8 KB |
| **Transient Query Arena & Hash Tables** | 16 KB | ~4 KB |
| **UDF Dispatcher & FFI Bridges** | 6 KB | ~2 KB |
| **Minimal Freestanding Runtime (`memcpy`)**| 2 KB | ~1 KB |
| **Total Engine Size** | **~106 KB** | **~30 KB** |

> **Result:** The final engine is well within our relaxed budget of **~150 KB Wasm** (~40 KB gzipped), delivering unmatched speed while remaining featherweight.

---

## 6. The Seamless Host Adapter Drop-In Swap

In `src/engine/adapter.ts`:

```typescript
export interface IEngineAdapter {
  vm_init(cacheOffset: number, slotCount: number, scratchOffset: number): void;
  vm_step(ctxOffset: number): number;
  page_defrag(pageOffset: number): number;
}

// Seamless Factory:
export async function loadEngine(memory: WebAssembly.Memory, mode: 'v1' | 'v2'): Promise<IEngineAdapter> {
  if (mode === 'v2') {
    const wasm = await WebAssembly.instantiateStreaming(fetch('engine.wasm'), {
      env: {
        memory,
        js_call_udf: (id, argOff, argLen) => dispatchHostUdf(id, argOff, argLen),
      },
    });
    return wasm.instance.exports as unknown as IEngineAdapter;
  }

  // V1 JS Reference Engine (Fallback)
  return new JsEngineAdapter(memory.buffer);
}
```

---

## 7. Verification & Test Suite (`tests/v2_build_pipeline.test.ts`)

1. **Wasm Instantiation Verification:** Instantiate `engine.wasm` with imported `WebAssembly.Memory`; assert all exported symbols match FFI signatures.
2. **Binary Footprint Assertion:** Assert that `engine.wasm` file size does not exceed **150,000 bytes** (150 KB).
3. **Differential Execution Check:** Run query on V1; run identical query on V2; assert bitwise identical output buffers and status codes.
