<p align="center">
  <img src="docs/public/logo.svg" width="96" height="96" alt="WebDB Logo" />
</p>

<h1 align="center">WebDB</h1>

<p align="center">
  <strong>An ultra-lean (&lt;50 KB), and powerful browser-native relational database engine built from scratch in C compiled to WASM.</strong>
</p>

<p align="center">
  <a href="https://github.com/ahmad-moussawi/webdb/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/wasm%20size-%3C50%20KB-success.svg?logo=webassembly&logoColor=white" alt="Wasm Size: <50KB" />
  <a href="https://github.com/ahmad-moussawi/webdb"><img src="https://img.shields.io/badge/status-early%20prototype-orange.svg" alt="Status: Prototype" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tests-15%2F15%20passing-brightgreen?logo=vitest&logoColor=white" alt="Tests" /></a>
  <a href="https://ahmad-moussawi.github.io/webdb/"><img src="https://img.shields.io/badge/docs-online-646cff?logo=vite&logoColor=white" alt="Docs" /></a>
</p>

**WebDB** is an ultra-lightweight, relational database built from scratch specifically for the web. Think of it as **SQLite reimagined for modern browsers**—bringing true SQL capabilities, ACID transactions, and persistent storage to offline-first apps without multi-megabyte bundles or complex server headers.

- 🪶 **Tiny Footprint (&lt;50 KB Wasm):** Up to 90%+ smaller than ported desktop SQLite or Postgres (PGlite) builds.
- ⚡ **True Relational Power:** Fast filtering, indexing, aggregations, multi-column sorting, and joins—replacing cumbersome IndexedDB cursor queries.
- 🔄 **Async VFS by Heart:** Built from the ground up for asynchronous browser storage—clean non-blocking page faults with zero Emscripten `Asyncify` stack hacks or slow workarounds.
- 🌐 **Embraces the Web Platform:** Uses the browser instead of fighting it—delegating to native `crypto.subtle`, `Intl`, `RegExp`, `Date`, and Web Locks rather than packing redundant C libraries into Wasm.
- 💾 **Reliable Offline Persistence:** First-class storage with high-speed **OPFS** (desktop & workers) and **IndexedDB** (Safari, mobile WebViews, private browsing).
- 🔌 **Zero Configuration:** Works everywhere out of the box with zero `COOP`/`COEP` header headaches.

---

## Why WebDB? (The Vision)

Web developers building offline apps have long been stuck between two extremes: **IndexedDB** is an awkward key-value cursor store lacking relational queries, joins, and aggregations; while **ported desktop engines (like SQLite or Postgres/PGlite)** drag 1 MB to 5 MB+ of desktop C legacy, POSIX thread logic, and Emscripten hacks into the browser.

WebDB fills this gap by **reimagining a database engine from scratch for modern browsers**.

```
┌─────────────────────────────────┐       ┌─────────────────────────────────┐
│  Ported Desktop DBs (Wasm)      │       │             WebDB               │
├─────────────────────────────────┤       ├─────────────────────────────────┤
│ • 500 KB - 5 MB+ (SQLite/PGlite)│       │ • <50 KB Wasm (ultra-lean)      │
│ • Bundles text SQL parser/lexer │  ──►  │ • Fluent TS Builder ➔ Bytecode  │
│ • Bundles POSIX pthread/mutexes │       │ • Single-threaded by design     │
│ • Bundles C date/regex/ICU shims│       │ • Embraces native Web APIs      │
│ • Asyncify call-stack rewriting │       │ • Native async page faults      │
└─────────────────────────────────┘       └─────────────────────────────────┘
```

### The Architectural Shift

**No Heavy SQL Parser:** Traditional SQL parsers, lexers, and tokenizer tables account for a huge portion of database binary size. In WebDB, the TypeScript Query Builder compiles queries directly into compact binary bytecode instructions (`Uint8Array`). The Wasm engine core only executes binary instructions—trimming tens of kilobytes of parser bloat.

**Single-Threaded by Design:** Browsers run in isolated, single-threaded contexts (Main Thread or Web Worker). Stripping out POSIX thread handling and internal lock contention keeps the engine razor-sharp, delegating cross-tab coordination to the browser's native **Web Locks API** (`navigator.locks`).

**Embracing Web APIs:** Instead of bundling heavy C libraries for dates, regexes, Unicode segmentation, or cryptography, WebDB delegates directly to native browser APIs (`Date`, `RegExp`, `Intl.Segmenter`, and `crypto.subtle`) via zero-overhead synchronous UDFs.

**Async VFS by Heart:** Desktop databases expect synchronous POSIX disk calls, forcing Wasm ports to rely on Emscripten’s slow, bloated `Asyncify` stack rewriting. WebDB's execution engine suspends cleanly via non-blocking page faults whenever a 4KB page is missing. This makes the storage layer completely pluggable: pages can be read from high-speed **OPFS**, persisted in **IndexedDB**, or even streamed on-demand across the network from an S3/CDN bucket via **HTTP Range Requests** (`HttpVfsAdapter`).

---

## Current Status & Development Strategy

WebDB is currently in an **early prototype ("walking skeleton") stage**:

- **V1 (C-Style JS Engine):** The initial release is built in **strict C-style TypeScript/JavaScript** (direct `ArrayBuffer` pointer arithmetic, flat structs, and zero heap allocations). Writing V1 in JS accelerates the development cycle, simplifies debugging, and creates an instant feedback loop with the web community.
- **V2 (Drop-In C / Wasm Port):** Once the binary formats, VDBE opcodes, and APIs are battle-tested, the core engine will be ported 1:1 to C and compiled to an ultra-lean Wasm binary (&lt;50 KB)—with zero changes required to the host JS orchestration layer.
- **Current Milestone:** Slotted-page layouts, basic VDBE opcode execution, in-memory/IndexedDB adapters, and query planning are implemented and verified with automated test suites. Full V1 engine development is actively underway.

Read our complete specifications:

- [Strategic Master Plan](https://ahmad-moussawi.github.io/webdb/plans/plan.html)
- [System Limitations & Invariants](https://ahmad-moussawi.github.io/webdb/plans/limitations.html)
- [Future Extensions: Vector, JSON & Hybrid Search](https://ahmad-moussawi.github.io/webdb/plans/future_extensions_roadmap.html)

---

## Expected Usage (V1 API)

### 1. Initialize & Create Tables

```typescript
import { WebDB } from "@webdb/core";

// Open database with automatic capability detection (OPFS if available, else IndexedDB)
const db = await WebDB.open({
  name: "app_data",
  storage: "auto", // 'opfs' | 'idb' | 'memory'
});

// Define a schema stored directly in Page 1 (Binary Master Table)
await db.createTable("users", [
  { name: "id", type: "UUID", flags: { primaryKey: true } }, // Native 16-byte binary storage
  { name: "name", type: "TEXT", flags: { notNull: true } },
  { name: "age", type: "INT32" },
  { name: "score", type: "FLOAT64" },
  { name: "embedding", type: "VECTOR", dimensions: 128 }, // Planned for future versions (SIMD search)
]);

await db.createIndex("users", "score");
```

### 2. Insert & Query Data

```typescript
// Insert records (string UUIDs or crypto.randomUUID() auto-packed into 16 bytes)
await db.insert("users", {
  id: "018d3e2a-1b4c-7000-8000-123456789abc",
  name: "Alice",
  age: 28,
  score: 95.5,
});
await db.insert("users", {
  id: crypto.randomUUID(),
  name: "Bob",
  age: 19,
  score: 82.0,
});

// Fluent, type-safe queries compiled to VDBE bytecode
const topScorers = await db
  .from("users")
  .where("age", ">=", 21)
  .whereNotNull("score")
  .orderBy("score", "desc")
  .limit(10)
  .toArray();

console.table(topScorers);
```

### 3. ACID Transactions with Auto-Rollback

```typescript
// Exclusive transaction lease logged to WAL before main disk sync
await db.transaction(async (tx) => {
  await tx.insert("users", {
    id: crypto.randomUUID(),
    name: "Charlie",
    age: 34,
    score: 88.0,
  });
  await tx
    .update("users", { score: 99.0 })
    .where("id", "=", "018d3e2a-1b4c-7000-8000-123456789abc");
  // Auto-commits on block exit; automatically rolls back on error
});
```

### 4. Query Inspection & Disassembly

```typescript
// Inspect the execution plan and disassembly
const explain = await db.from("users").where("score", ">", 80.0).explain();

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

## Support the Project ⭐

WebDB is an ambitious open-source initiative to build a modern, featherweight relational database engine purpose-built for the web platform. If you believe in this vision, here is how you can support the development:

- ⭐ **Star this Repository:** If you find this project interesting or valuable, please give it a **Star on GitHub**. It takes two seconds, boosts project visibility, and helps attract more contributors!
- 📢 **Spread the Word:** Share WebDB on X (Twitter), Bluesky, LinkedIn, Reddit, or with developer friends building offline-first or local-first apps.
- 💬 **Join the Discussion:** Review our [Architectural Blueprints](https://ahmad-moussawi.github.io/webdb/plans/plan.html), open an issue with suggestions, or share your offline data use cases.
- 🛠️ **Contribute:** PRs, benchmarks, and feedback on our prototype and specifications are warmly welcome.

WebDB is open source under the [MIT License](https://github.com/ahmad-moussawi/webdb/blob/main/LICENSE).
