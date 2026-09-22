<p align="center">
  <img src="docs/public/logo.svg" width="96" height="96" alt="WebDB Logo" />
</p>

<h1 align="center">WebDB</h1>

<p align="center">
  <strong>An ultra-lean, browser-native relational database engine built from scratch.</strong>
</p>

<p align="center">
  <a href="https://github.com/ahmad-moussawi/webdb/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/ahmad-moussawi/webdb"><img src="https://img.shields.io/badge/status-early%20prototype-orange.svg" alt="Status: Prototype" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tests-15%2F15%20passing-brightgreen?logo=vitest&logoColor=white" alt="Tests" /></a>
  <a href="https://ahmad-moussawi.github.io/webdb/"><img src="https://img.shields.io/badge/docs-online-646cff?logo=vite&logoColor=white" alt="Docs" /></a>
</p>

WebDB is a relational database engine designed specifically for modern web browsers. Instead of compiling massive desktop engines (like SQLite or Postgres) into multi-megabyte WebAssembly bundles, WebDB pairs a **zero-heap 4KB slotted-page binary architecture** with a **register-based VDBE bytecode machine** that embraces browser asynchronous storage natively.

---

## Why WebDB?

Most SQL solutions in the browser today rely on compiling existing C engines with Emscripten. This approach introduces major drawbacks:
* **Bundle Bloat:** Compiling desktop engines drags along multi-megabyte binaries, bloated ICU Unicode tables, and heavy runtime shims.
* **The Async Call-Stack Penalty:** Traditional C engines expect synchronous POSIX file I/O. Bridging them to browser storage (OPFS / IndexedDB) requires Emscripten `Asyncify`, which rewrites every function call, balloons binary size, and severely degrades execution speed.
* **Ignoring Native Web APIs:** Modern browsers already provide world-class, hardware-accelerated APIs that desktop C engines duplicate from scratch.

### The WebDB Approach:
1. **Leverage the Browser Platform:**
   * **Multi-Lingual Tokenization:** Uses native `Intl.Segmenter` (0 KB bundle cost, zero ICU tables).
   * **Hardware-Accelerated Encryption:** Uses native Web Crypto (`crypto.subtle`) for transparent AES-256-GCM.
   * **Multi-Tab Concurrency:** Uses the native Web Locks API (`navigator.locks`) for single-writer coordination.
   * **Dual First-Class Storage:** Direct block I/O against bare-metal **OPFS** and universal **IndexedDB**.
2. **Native Async Page Faults:** The VDBE virtual machine is a step-loop state machine. When a page isn't in memory, it cleanly yields `STATUS_PAGE_FAULT` to the JavaScript event loop and resumes execution without call-stack rewrites.
3. **Strict C-Style Shared Memory:** Zero dynamic runtime heap allocations in the query path. Slotted pages, buffer pools, bytecode, and cursors reside in predictable, pre-allocated memory slices.

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
