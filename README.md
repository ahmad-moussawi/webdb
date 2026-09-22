<p align="center">
  <img src="docs/public/logo.svg" width="96" height="96" alt="WebDB Logo" />
</p>

<h1 align="center">WebDB</h1>

<p align="center">
  <strong>An ultra-lean (&lt;50 KB Wasm), browser-native relational database engine built from scratch.</strong>
</p>

<p align="center">
  <a href="https://github.com/ahmad-moussawi/webdb/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/wasm%20size-%3C50%20KB-success.svg?logo=webassembly&logoColor=white" alt="Wasm Size: <50KB" />
  <a href="https://github.com/ahmad-moussawi/webdb"><img src="https://img.shields.io/badge/status-early%20prototype-orange.svg" alt="Status: Prototype" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tests-15%2F15%20passing-brightgreen?logo=vitest&logoColor=white" alt="Tests" /></a>
  <a href="https://ahmad-moussawi.github.io/webdb/"><img src="https://img.shields.io/badge/docs-online-646cff?logo=vite&logoColor=white" alt="Docs" /></a>
</p>

WebDB is a relational database engine designed specifically for modern web browsers. Instead of compiling massive desktop engines (like SQLite or Postgres) into multi-megabyte WebAssembly bundles, WebDB pairs a **zero-heap 4KB slotted-page binary architecture** with a **register-based VDBE bytecode machine** that embraces browser asynchronous storage natively.

---

## Why WebDB?

Existing browser SQL solutions compile desktop C engines with Emscripten, causing:
* **Bundle Bloat:** Multi-megabyte binaries dragging along redundant C shims and heavy ICU tables.
* **The `Asyncify` Penalty:** Rewriting call stacks to bridge synchronous C code to async browser storage hurts execution speed.
* **Ignoring Web APIs:** Re-implementing crypto, regex, and date libraries already native to the browser.

### The WebDB Approach:

1. **Ultra-Lean Wasm Engine (&lt;50 KB):**
   * **Date & Time:** Delegates to native `Date` and `Intl` via UDFs—zero C date parser bloat.
   * **Regex & Text:** Uses native `RegExp` and `Intl.Segmenter` for zero-byte Unicode tokenization (no ICU tables).
   * **Hardware Crypto:** Transparent AES-256-GCM page encryption via native Web Crypto (`crypto.subtle`).
   * **Multi-Tab Sync:** Single-writer coordination via the native Web Locks API (`navigator.locks`).
2. **Co-Equal First-Class Storage (OPFS & IndexedDB):**
   * **OPFS:** Bare-metal block I/O with `FileSystemSyncAccessHandle` for Dedicated Web Workers.
   * **IndexedDB:** Co-equal first-class engine for Main Thread, ServiceWorkers, and mobile WebViews without COOP/COEP headers.
3. **Native Async Page Faults:** VDBE step loop yields `STATUS_PAGE_FAULT` on cache misses and resumes cleanly—zero Emscripten `Asyncify` overhead.
4. **Zero-Heap Shared Memory:** 4KB slotted pages, buffer pools, and cursors reside in pre-allocated slices—0 dynamic runtime heap allocations.

---

## Current Status

WebDB is currently in an **early prototype ("walking skeleton") stage**:
* The core slotted-page format, basic VDBE opcode loop, in-memory/IndexedDB adapters, and query planner are working and verified with automated test suites.
* Detailed architectural blueprints, binary formats, and memory specifications are complete and open for community review.
* Development of the complete V1 engine is actively in progress.

Read our complete specifications:
* [Strategic Master Plan](https://ahmad-moussawi.github.io/webdb/plans/plan.html)
* [System Limitations & Invariants](https://ahmad-moussawi.github.io/webdb/plans/limitations.html)
* [Future Extensions: Vector, JSON & Hybrid Search](https://ahmad-moussawi.github.io/webdb/plans/future_extensions_roadmap.html)

---

## Expected Usage (V1 API)

### 1. Initialize & Create Tables
```typescript
import { WebDB } from '@webdb/core';

// Open database with automatic capability detection (OPFS if available, else IndexedDB)
const db = await WebDB.open({
  name: 'app_data',
  storage: 'auto', // 'opfs' | 'idb' | 'memory'
});

// Define a schema stored directly in Page 1 (Binary Master Table)
await db.createTable('users', [
  { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
  { name: 'name', type: 'TEXT', flags: { notNull: true } },
  { name: 'age', type: 'INT32' },
  { name: 'score', type: 'FLOAT64' },
]);

await db.createIndex('users', 'score');
```

### 2. Insert & Query Data
```typescript
// Insert records
await db.insert('users', { id: 1, name: 'Alice', age: 28, score: 95.5 });
await db.insert('users', { id: 2, name: 'Bob', age: 19, score: 82.0 });

// Fluent, type-safe queries compiled to VDBE bytecode
const topScorers = await db
  .from('users')
  .where('age', '>=', 21)
  .whereNotNull('score')
  .orderBy('score', 'desc')
  .limit(10)
  .toArray();

console.table(topScorers);
```

### 3. ACID Transactions with Auto-Rollback
```typescript
// Exclusive transaction lease logged to WAL before main disk sync
await db.transaction(async (tx) => {
  await tx.insert('users', { id: 3, name: 'Charlie', age: 34, score: 88.0 });
  await tx.update('users', { score: 99.0 }).where('id', '=', 1);
  // Auto-commits on block exit; automatically rolls back on error
});
```

### 4. Query Inspection & Disassembly
```typescript
// Inspect the execution plan and disassembly
const explain = await db
  .from('users')
  .where('score', '>', 80.0)
  .explain();

console.log(explain.assembly);
/*
  ADDR  OPCODE          P1   P2   P3   COMMENT
  0000  OP_INIT          0    0    0   Start execution
  0001  OP_CURSOR_OPEN   0    2    0   Open table 'users'
  0002  OP_NEXT_ROW      0    6    0   Scan next slot
  0003  OP_COLUMN        0    3    1   Extract 'score' into r[1]
  0004  OP_GT            1   80    2   Compare score > 80.0
  0005  OP_EMIT_ROW      0    0    0   Emit row to result buffer
  0006  OP_HALT          0    0    0   Query complete
*/
```

---

## Contributing & Community

WebDB is open source under the MIT License. We welcome discussions, architecture reviews, and contributions!

* **GitHub Repository:** [https://github.com/ahmad-moussawi/webdb](https://github.com/ahmad-moussawi/webdb)
* **Documentation & Plans:** [https://ahmad-moussawi.github.io/webdb/](https://ahmad-moussawi.github.io/webdb/)
