# How WebDB Stays Fast

WebDB is engineered around a single goal: **relational SQL queries in the browser should feel instantaneous—both on tiny initial download budgets and across tens of thousands of persistent rows on disk.**

Rather than porting a desktop database into WebAssembly with POSIX wrappers and stack-rewriting shims, WebDB optimizes every layer of the stack together:

1. **Startup & Bundle Size:** A {{ $sizes.wasmGzip }} gzipped ({{ $sizes.wasmRaw }} raw) Wasm core built from freestanding C99—smaller than a single hero image.
2. **CPU & Memory Layout:** Zero-allocation arithmetic over 4 KB slotted binary pages directly inside `WebAssembly.Memory`.
3. **Compilation & Planning:** Direct Query-Builder-to-bytecode compilation with zero runtime SQL text parsing.
4. **Storage & Buffer Pool I/O:** Non-blocking async page faults paired with **adaptive sequential read-ahead** and **contiguous write coalescing**.
5. **Extensions & Formatting:** 128-row vectorized UDF batching and native browser API delegation.

---

## 1. Freestanding C99 / Wasm Execution Core

Ported desktop databases typically ship `1 MB – 5 MB+` of C runtime, `libc` locales, pthread synchronization, and SQL parsers inside WebAssembly. WebDB compiles its core execution and B+Tree engine cleanly with `-nostdlib -O3` and `wasm-opt`:

- **Tiny Cold-Load Footprint:** Only **{{ $sizes.wasmGzip }} gzipped** (**{{ $sizes.wasmRaw }} raw**), instantiating via `WebAssembly.instantiateStreaming()` when using [`wasmUrl`](/guides/storage-and-configuration#streaming-an-external-wasm-file-wasmurl).
- **Shared Module Caching:** Sharing a single `new WasmEngine()` across multiple `WebDB.open()` calls compiles the `WebAssembly.Module` once while giving each database isolated `WebAssembly.Memory`.
- **Zero-Copy 4 KB Slotted Pages:** Rows, B+Tree interior nodes, index leaves, and overflow chains live in fixed 4 KB pages inside linear memory. Iterating rows uses typed pointer offsets rather than `JSON.parse` or per-row JS object deserialization on hot paths.
- **$O(1)$ Metadata Operations:** Master schema descriptors live in Page 1's catalog so checks like `db.getTableNames()`, `db.renameTable()`, and `db.renameColumn()` complete without scanning table data.

---

## 2. Direct Query-Builder-to-Bytecode Compilation

Text SQL parsers, lexers, and AST normalizers consume both bundle kilobytes and per-query CPU time.

In WebDB, the fluent TypeScript Query Builder compiles directly into compact binary **VDBE bytecode** (`Uint8Array`) on the host:

- **Cost-Based Join & Index Selection:** `CostBasedPlanner` chooses optimal B+Tree indexes, pushes down cheap predicates (`IS NOT NULL`, integer comparisons) before expensive filters (`LIKE`, UDFs), infers transitive join predicates, and eliminates `ORDER BY ... LIMIT` sorts whenever a B+Tree index already produces rows in order.
- **Compile-Time Contradiction Short-Circuiting:** Impossible filters (`where("id", "=", 1).where("id", "=", 2)` or `whereIn("status", [])`) compile to a 1-instruction early halt with zero page reads.

See [Query Performance, Planners & `.explain()`](/query-planner) for inspecting generated plans and bytecode.

---

## 3. Native Async VFS Without Emscripten `Asyncify`

Desktop engines expect synchronous POSIX `pread()`/`pwrite()`. Running them over asynchronous IndexedDB or HTTP Range APIs requires Emscripten `Asyncify`, which instruments Wasm control flow, inflates binary size, and saves/restores call stacks on yields.

WebDB is **async-native by design**:

- **Zero-Overhead Cache Hits:** When requested 4 KB pages are already in the `BufferPoolDriver` ring in `WebAssembly.Memory`, queries run synchronously with zero `Promise` allocations per row or per tuple.
- **Clean Page-Fault Suspension:** On a cache miss, the VDBE VM pins active cursor pages and returns `VmStatus.PAGE_FAULT` with `fault_page_id`. After the host storage (`Io`) fulfills the read into the buffer pool slot, the VM resumes cleanly from its saved cursor position.

---

## 4. Adaptive Sequential & Chain Read-Ahead (`readAhead`)

In browsers, **per-transaction IPC latency—not raw byte bandwidth—is the main bottleneck** on cold storage. Fetching 750 pages one at a time via IndexedDB costs 750 separate transaction setups and structured-clone IPC hops.

WebDB's `BufferPoolDriver` and `Io` layer automatically detect sequential access patterns and batch upcoming cold pages into single storage requests—**enabled out of the box** on persistent backends (`IdbStorage`, `OpfsStorage`, `NodeFsStorage`, and custom remote VFS adapters), and automatically disabled on `MemoryStorage`.

### How Stream Detection Works

```text
Miss #1 (page 10)  ──►  Fetch [10] alone            (window = 1; no speculation)
Miss #2 (page 11)  ──►  Sequential stride / chain detected!
                        or chain nextPageId matched
Miss #3..N         ──►  Adaptive ramp: 4 ──► 8 ──► 16 ──► 32 pages (up to maxPages: 256)
                        1 VFS readPages([p..p+31]) call + single I/O batch
```

- **Up to 8 Concurrent Streams:** Tracks up to 8 independent access frontiers simultaneously (with LRU replacement and pinning for in-flight requests), accelerating joins (`users ⋈ orders`), index-to-table lookups, and concurrent live queries without resetting each other's prefetch streaks.
- **Physical Strides & Logical Chains:** Detects both ascending/descending contiguous strides (`page_id ± 1`)—even skipping across warm cached page islands—and logical B+Tree `nextPageId` links across table leaf pages, index leaf pages, and `> 60 KB` overflow chains.
- **Zero Amplification on Point Lookups:** Random key lookups (`WHERE id = ?`) miss once per B+Tree level and never open a prefetch window; a physical stream only starts prefetching after consecutive sequential misses (2+ sequential hits / chain continuation).
- **Self-Throttling Under Memory Pressure:** Caps each batch dynamically to clean evictable slots and `<= 25%` of `slotCount` so read-ahead never thrashes dirty or pinned pages.
- **Concurrent Fault Coalescing:** Simultaneous faults on the same `page_id` or speculative range coalesce via `in_flight_acquires` and `in_flight_reads`, and write-generation counters invalidate stale speculative reads on concurrent writes, transaction spills, rollbacks, or cross-tab reloads.

### Storage Backend Fast Paths

When WebDB issues an ascending contiguous batch (e.g. `readPages([12, 13, ..., 43])`), each built-in storage adapter hits a single-operation fast path:

| Storage Backend | What Happens on a 32-Page Contiguous Batch |
| :--- | :--- |
| **`IdbStorage`** | Uses `IDBKeyRange.bound(start, end)` + one `store.getAll()` / `store.getAllKeys()` inside **1** `readonly` transaction (instead of 32 separate IDB transactions). |
| **`OpfsStorage`** (Worker & Main Thread) | Issues **1** contiguous 128 KB bulk read (`SyncAccessHandle.read` or `File.slice().arrayBuffer()`) instead of 32 small seeks. |
| **`NodeFsStorage`** | Issues **1** contiguous bulk `FileHandle.read()` instead of 32 separate offset reads. |
| **`MemoryStorage`** | Read-ahead automatically disabled (`maxPages: 1`) since memory copies are already synchronous. |

### Measured Impact (Cold Full-Table Scan)

Benchmark dataset: **6,000 rows** (~3 MB, **750 cold 4 KB leaf pages**), cold `BufferPoolDriver` (`slotCount: 256`), full scan `db.from("items").toArray()`:

| Scenario / Backend | `readAhead: false` | `readAhead: true` (`32`) | `{ maxPages: 64 }` | Improvement (`32` / `64`) |
| :--- | :---: | :---: | :---: | :---: |
| **VFS `readPages()` calls** | `750` | `29` | `18` | **~25.9x / ~41.7x fewer I/Os (~96% cut)** |
| **Browser IndexedDB** (~1.0 ms/tx typical/mobile) | `798.7 ms` | `43.8 ms` | `31.1 ms` | **~18.2x / ~25.7x faster** |
| **Browser IndexedDB** (~0.35 ms/tx fast desktop) | `307.1 ms` | `25.7 ms` | — | **~12.0x faster** |
| **In-process `fake-indexeddb`** (Node test env) | `85.7 ms` | `22.5 ms` | `16.4 ms` | **~3.8x / ~5.2x faster** |
| **`NodeFsStorage`** (macOS SSD / OS cache) | `39.6 ms` | `16.3 ms` | `13.0 ms` | **~2.4x / ~3.0x faster** |
| **Warm cache / point lookup / `MemoryStorage`** | `1.0x` | `1.0x` | `1.0x` | **Zero extra I/O** |

> [!TIP]
> Most apps need zero configuration: `readAhead` is enabled by default (`maxPages: 32`). For large analytical scans, bulk exports, or high-latency network storage (`HttpVfsAdapter`), you can raise it (e.g. `readAhead: { maxPages: 64 }`) alongside a larger `slotCount`.

---

## 5. Batched WAL & Contiguous Write Coalescing

Reads aren't the only path where WebDB eliminates small per-page round-trips:

- **Single-Batch WAL Commits & Recovery:** Modified pages inside a transaction commit together in one WAL append batch (`appendWalFrames`), and crash recovery on `IdbStorage` reads WAL frames with a single bounded `store.getAll()` IPC call.
- **Contiguous Dirty-Page Write Coalescing:** Dirty pool eviction and WAL checkpoints batch pages through `Io.writeSlots()`, sorting pages by `pageId`. Both `OpfsStorage` and `NodeFsStorage` merge adjacent page runs (`coalesceWriteRuns`) into single contiguous write syscalls, while `IdbStorage` writes all pages inside one `readwrite` transaction (defaulting to `durability: "relaxed"` to avoid unnecessary browser fsync stalls on every commit).

---

## 6. Vectorized UDF Batching & Native Web APIs

Custom JavaScript logic shouldn't force per-row call-boundary overhead:

- **128-Row Vectorized Dispatch:** `db.registerBatchedFunction()` and `UdfDefinition.batchCall` evaluate rows in **128-row batches** rather than crossing the engine/JS boundary once per row. Built-in `@ahmadmoussawi/webdb/search` functions (`fuzzy`, `fuzzy_score`, `bm25_score`, `highlight`, `snippet`) use batched execution automatically.
- **Zero-Bundle Native Web APIs:** Dates, locale collation, currency formatting, word tokenization, regex matching, and UUIDs run directly on `Intl.*`, `RegExp`, `Date`, and `crypto` without bundling megabytes of ICU tables into Wasm.

See [Expressions, Functions & UDFs](/guides/expressions-and-functions) for usage examples.

---

## 7. Quick Performance Tuning Checklist

| Lever | Default | When to Adjust | Where to Learn More |
| :--- | :--- | :--- | :--- |
| **`db.createIndex()` + `.explain()`** | Auto `CostBasedPlanner` | Any filtered, joined, or ordered column scanning >500 rows | [Query Performance & `.explain()`](/query-planner) |
| **`readAhead`** | Enabled (`maxPages: 32`) on disk; off on `MemoryStorage` | Raise to `{ maxPages: 64 }`–`128` for large cold scans/exports; `false` only for tiny caches | [Storage Backends & Config](/guides/storage-and-configuration) |
| **`slotCount`** | `1024` (`4 MB`) | Raise to `2048`–`4096` (`8–16 MB`) when working sets exceed 4 MB or `maxPages >= 64` | [Storage Backends & Config](/guides/storage-and-configuration) |
| **`maxQueryMemory`** | `16 MB` | Raise for unindexed `ORDER BY` / `GROUP BY` over 100k+ rows | [Storage Backends & Config](/guides/storage-and-configuration) |
| **`IdbStorage` `durability`** | `"relaxed"` | Switch to `"strict"` only when immediate power-loss fsync guarantees outweigh latency | [Storage Backends & Config](/guides/storage-and-configuration) |
| **`registerBatchedFunction()`** | 128-row batches | Custom CPU-heavy calculations over thousands of rows in `SELECT` / `WHERE` | [Expressions, Functions & UDFs](/guides/expressions-and-functions) |
