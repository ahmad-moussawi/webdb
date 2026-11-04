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
  <a href="https://ahmad-moussawi.github.io/webdb/playground/"><img src="https://img.shields.io/badge/Studio%20IDE-live%20playground-7c3aed?logo=visualstudiocode&logoColor=white" alt="Studio IDE" /></a>
  <a href="https://ahmad-moussawi.github.io/webdb/benchmark/"><img src="https://img.shields.io/badge/benchmarks-live%20suite-059669?logo=speedtest&logoColor=white" alt="Live Benchmarks" /></a>
  <a href="https://www.npmjs.com/package/@ahmadmoussawi/webdb"><img src="https://img.shields.io/npm/v/@ahmadmoussawi/webdb/alpha?label=npm%20alpha&color=orange&logo=npm" alt="npm alpha" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tests-348%20unit%20%2B%206%20e2e%20passing-brightgreen?logo=vitest&logoColor=white" alt="Tests" /></a>
  <a href="https://ahmad-moussawi.github.io/webdb/"><img src="https://img.shields.io/badge/docs-online-646cff?logo=vite&logoColor=white" alt="Docs" /></a>
</p>

<p align="center">
  <a href="https://ahmad-moussawi.github.io/webdb/playground/"><strong>🚀 Launch Studio Playground</strong></a> &nbsp;•&nbsp;
  <a href="https://ahmad-moussawi.github.io/webdb/benchmark/"><strong>⚡ Run Live Benchmarks</strong></a> &nbsp;•&nbsp;
  <a href="https://ahmad-moussawi.github.io/webdb/"><strong>📖 Documentation</strong></a> &nbsp;•&nbsp;
  <a href="https://ahmad-moussawi.github.io/webdb/plans/plan.html"><strong>📐 Specifications</strong></a>
</p>

**WebDB** is an ultra-lightweight, relational database built from scratch specifically for the web. Think of it as **SQLite reimagined for modern browsers**—bringing true SQL capabilities, ACID transactions, and persistent storage to offline-first apps without multi-megabyte bundles or complex server headers.

- 🪶 **Tiny Footprint (&lt;50 KB Wasm):** Up to 90%+ smaller than ported desktop SQLite or Postgres (PGlite) builds.
- ⚡ **True Relational Power:** Fast filtering, indexing, aggregations, multi-column sorting, and joins—replacing cumbersome IndexedDB cursor queries.
- 📡 **Reactive Live Queries (React, Vue, Angular &amp; Plain JS):** First-class UI bindings (`< 1 KB` subpath exports) with automatic table dependency tracking across `JOIN`s, subqueries, and open browser tabs.
- 🔄 **Async VFS by Heart:** Built from the ground up for asynchronous browser storage—clean non-blocking page faults with zero Emscripten `Asyncify` stack hacks or slow workarounds.
- 🌐 **Embraces the Web Platform:** Uses the browser instead of fighting it—delegating to native `crypto.subtle`, `Intl`, `RegExp`, `Date`, and Web Locks rather than packing redundant C libraries into Wasm.
- 💾 **Reliable Offline Persistence:** First-class storage with high-speed **OPFS** (desktop &amp; workers) and **IndexedDB** (Safari, mobile WebViews, private browsing).
- 🔌 **Zero Configuration:** Works everywhere out of the box with zero `COOP`/`COEP` header headaches.

---

## 🎮 Try WebDB Live in Your Browser

Experience WebDB directly on your device with zero installation or setup:

| Tool | Highlights | Link |
| :--- | :--- | :--- |
| **WebDB Studio Playground** | Full in-browser database IDE with Monaco editor, live table explorer, low-level binary 4KB slotted page inspector, buffer pool visualizer, and real-time bytecode disassembler. | [**Launch Studio IDE →**](https://ahmad-moussawi.github.io/webdb/playground/) |
| **In-Browser Benchmark Suite** | Live comparative benchmarking engine measuring throughput (ops/sec), latency, and memory allocations against Raw JS Arrays, Native IndexedDB, and official SQLite WASM on your hardware. | [**Run Benchmarks →**](https://ahmad-moussawi.github.io/webdb/benchmark/) |

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
- **Interactive Tools Live:** You can test queries in the [WebDB Studio Playground](https://ahmad-moussawi.github.io/webdb/playground/) or evaluate performance in the [In-Browser Benchmark Suite](https://ahmad-moussawi.github.io/webdb/benchmark/).

Read our complete specifications:

- [Strategic Master Plan](https://ahmad-moussawi.github.io/webdb/plans/plan.html)
- [System Limitations & Invariants](https://ahmad-moussawi.github.io/webdb/plans/limitations.html)
- [Future Extensions: Vector, JSON & Hybrid Search](https://ahmad-moussawi.github.io/webdb/plans/future_extensions_roadmap.html)

---

## 📦 Installation

Install the alpha release of `@ahmadmoussawi/webdb` via npm, pnpm, or yarn:

```bash
# npm
npm install @ahmadmoussawi/webdb@alpha

# pnpm
pnpm add @ahmadmoussawi/webdb@alpha

# yarn
yarn add @ahmadmoussawi/webdb@alpha
```

---

## 🚀 Quick Start (Runnable Example)

The snippet below is a complete, runnable example you can paste into any TypeScript or JavaScript project (Vite, Next.js, Node 20+, or Vitest):

```typescript
import { WebDB } from "@ahmadmoussawi/webdb";

async function main() {
  // 1. Open a database
  //    storage: 'idb' (IndexedDB) | 'opfs' (Origin Private File System) | 'memory' (In-Memory)
  //    core:    'wasm' (default ~13 KB Wasm engine) | 'js' (pure JS fallback)
  const db = await WebDB.open({
    name: "app_data",
    storage: typeof indexedDB !== "undefined" ? "idb" : "memory",
    core: "wasm",
  });

  // 2. Define a table schema stored in Page 1 (Binary Master Catalog)
  //    Supported column types: 'INT32' | 'INT64' | 'FLOAT64' | 'TEXT' | 'BLOB' | 'UUID' | 'ULID'
  await db.createTable("users", [
    { name: "id", type: "UUID", flags: { primaryKey: true } }, // Packed into 16 raw bytes
    { name: "name", type: "TEXT", flags: { notNull: true } },
    { name: "age", type: "INT32" },
    { name: "score", type: "FLOAT64" },
  ]);

  // Create a secondary B+Tree index for fast range scans & ordered queries
  await db.createIndex("users", "score");

  // 3. Insert single or bulk records
  await db.insert("users", {
    id: "018d3e2a-1b4c-7000-8000-123456789abc",
    name: "Alice",
    age: 28,
    score: 95.5,
  });

  await db.insertMany("users", [
    { id: crypto.randomUUID(), name: "Bob", age: 19, score: 82.0 },
    { id: crypto.randomUUID(), name: "Charlie", age: 34, score: 88.0 },
  ]);

  // 4. ACID Transactions with Write-Ahead Logging (WAL) & Nested Savepoints
  //    Automatically coordinates across browser tabs via Web Locks (navigator.locks)
  await db.transaction(async (tx) => {
    await tx.insert("users", {
      id: crypto.randomUUID(),
      name: "Diana",
      age: 25,
      score: 99.0,
    });

    // Nested transactions act as savepoints — rolling back an inner block
    // restores state without aborting the outer transaction
    await tx
      .transaction(async (nestedTx) => {
        await nestedTx.insert("users", {
          id: crypto.randomUUID(),
          name: "Temporary User",
          age: 40,
          score: 10.0,
        });
        throw new Error("Abort inner savepoint only");
      })
      .catch(() => {
        // Inner insert was cleanly rolled back; Diana remains!
      });
  });

  // 5. Fluent Queries (compiled directly to compact VDBE binary bytecode)
  const topAdults = await db
    .from("users")
    .select("name", "age", "score")
    .where("age", ">=", 21)
    .whereNotNull("score")
    .orderBy("score", "desc")
    .limit(10)
    .toArray();

  console.table(topAdults);
  // ┌─────────┬───────────┬─────┬───────┐
  // │ (index) │ name      │ age │ score │
  // ├─────────┼───────────┼─────┼───────┤
  // │ 0       │ 'Diana'   │ 25  │ 99    │
  // │ 1       │ 'Alice'   │ 28  │ 95.5  │
  // │ 2       │ 'Charlie' │ 34  │ 88    │
  // └─────────┴───────────┴─────┴───────┘

  // 6. Inspect the Query Plan & VDBE Bytecode Disassembly
  const explain = await db.from("users").where("score", ">", 80).explain();
  console.log("Execution Plan:", explain.plan);
  console.table(explain.instructions);

  await db.close();
}

main();
```

---

## 📡 Reactive Live Queries (React, Vue, Angular & Plain JS)

WebDB provides zero-bundle-bloat subpath exports (`< 1 KB` gzipped each) that automatically track every table read by your query—including `JOIN`s and nested subqueries—and push live updates whenever those tables change locally or from another browser tab:

```typescript
// 1. Plain JavaScript / TypeScript (@ahmadmoussawi/webdb)
const live = db
  .from("users")
  .where("score", ">=", 90)
  .orderBy("score", "desc")
  .live((topUsers) => renderLeaderboard(topUsers));

// Or consume as an AsyncIterable:
for await (const topUsers of db.from("users").where("score", ">=", 90).live()) {
  renderLeaderboard(topUsers);
}

// 2. React (@ahmadmoussawi/webdb/react)
import { useLiveQuery } from "@ahmadmoussawi/webdb/react";
const { data: users, isLoading } = useLiveQuery(
  () => db.from("users").where("age", ">=", minAge).orderBy("score", "desc"),
  [minAge],
  { initialData: [] }
);

// 3. Vue 3 (@ahmadmoussawi/webdb/vue)
import { useLiveQuery } from "@ahmadmoussawi/webdb/vue";
const { data: users, isLoading } = useLiveQuery(
  () => db.from("users").where("age", ">=", minAgeRef.value).orderBy("score", "desc"),
  [minAgeRef],
  { initialData: [] }
);

// 4. Angular Signals & RxJS (@ahmadmoussawi/webdb/angular)
import { liveQuerySignal, liveQuery$ } from "@ahmadmoussawi/webdb/angular";
users = liveQuerySignal(
  () => db.from("users").where("age", ">=", this.minAge()).orderBy("score", "desc"),
  { initialData: [] }
);
```

---

## ⚙️ Core Architecture: TypeScript ➔ C Transpiler

WebDB uses an automated **TypeScript-to-C Transpiler** (`scripts/transpiler/`) to maintain a single canonical source of truth for its core storage and execution engine (`src/core/js/*.c.ts`). 

TypeScript code is written in a strict, zero-allocation, C-compatible style. The transpiler translates this code into freestanding C99 (`src/core/c/`), which is then compiled via Clang (`wasm32-unknown-unknown -nostdlib -O3`) and optimized with `wasm-opt` into an **ultra-lean ~13 KB WASM binary**.

```
  ┌─────────────────────────────────────────────────────────────┐
  │         Canonical TypeScript Core (src/core/js/*.c.ts)      │
  │    (Runs in Node/Vitest tests & Host JS Fallback Mode)      │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                 npm run transpile:c / build:wasm
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │             Freestanding C99 Core (src/core/c/)              │
  │         Zero-libc, slotted-page pointer arithmetic          │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                   clang -nostdlib -O3 + wasm-opt
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │             WebAssembly Binary (~13 KB WASM)                │
  │     Embedded directly into npm package with zero bloat      │
  └─────────────────────────────────────────────────────────────┘
```

### CLI Commands

```bash
# Transpile all TypeScript core modules to C source (.c) and headers (.h)
npm run transpile:c

# Transpile a single file for inspection
npx vite-node scripts/transpiler/index.ts src/core/js/codecs.c.ts

# Complete build pipeline: layouts ➔ transpiler ➔ clang wasm32 ➔ wasm-opt -O3
npm run build:wasm

# Run the 275+ automated test suite across both JS and WASM cores
npm test
```

### Type System Mapping (`src/core/types.ts`)

Primitive type aliases in TypeScript map directly to C native fixed-width types:

| TypeScript Alias | C Native Type | Description |
| :--- | :--- | :--- |
| `u8`, `u16`, `u32` | `uint8_t`, `uint16_t`, `uint32_t` | Unsigned 8, 16, 32-bit integers |
| `i8`, `i16`, `i32` | `int8_t`, `int16_t`, `int32_t` | Signed 8, 16, 32-bit integers |
| `u64`, `i64` | `uint64_t`, `int64_t` | 64-bit integers (`bigint` in JS) |
| `f64` | `double` | 64-bit IEEE 754 floating point |
| `byte_ptr` | `uint32_t` | Linear memory byte offset |
| `const_u8_ptr` | `const uint8_t *` | Immutable byte buffer pointer |
| `u8_ptr` | `uint8_t *` | Mutable byte buffer pointer |
| `const_char_ptr` | `const char *` | Null-terminated C string pointer |
| `char_ptr` | `char *` | Mutable character buffer pointer |

### Transpiler Annotations Reference

The transpiler supports annotations to customize code generation and enable dual implementations:

#### 1. `@export_c` (Exported Function)
Exports the function in both the C source and the `.h` header with `WEBDB_EXPORT`.
```typescript
/**
 * @export_c
 */
export function page_get_cell_count(page_offset: u32): u16 {
  return load_u16(page_offset + PAGE_HEADER_OFFSET_CELL_COUNT);
}
```

#### 2. `@internal_c` (Module-Private Static Helper)
Generates a `static` C function internal to the translation unit, omitted from the `.h` header.
```typescript
/**
 * @internal_c
 */
function init_crc_table(): void {
  // Generated as static void init_crc_table(void)
}
```

#### 3. `@manual_c` / `@native_c` (Dual Implementation Shortcut)
Instructs the transpiler that a function is manually implemented in C:
- **In TypeScript / Vitest**: Executes the TypeScript body normally.
- **In C Header (`.h`)**: Still registers `WEBDB_EXPORT` so callers have the prototype.
- **In C Source (`.c`)**: **Skips** generating the body in `.c`. The implementation is resolved from existing C files, companion files, or headers.

```typescript
/**
 * @export_c
 * @manual_c
 */
export function btree_split_leaf(page_offset: u32, new_key: u32): i32 {
  // High-level TS implementation runs in JS mode & Vitest tests
  return 0;
}
```

#### 4. Inline C Blocks (` ```c ... ``` `)
Embed hand-crafted C code directly inside the TypeScript JSDoc comment. The transpiler emits the C code block verbatim:

```typescript
/**
 * @export_c
 * @manual_c
 * ```c
 * WEBDB_EXPORT uint32_t fast_crc32(uint32_t crc, const uint8_t *buf, uint32_t len) {
 *   // Hand-optimized C routine
 *   return crc ^ len;
 * }
 * ```
 */
export function fast_crc32(crc: u32, buf: Uint8Array, len: u32): u32 {
  return (crc ^ len) >>> 0;
}
```

#### 5. `@use_c: target_c_name` (Symbol & Call Rewriting)
Maps the TypeScript function to a differently named existing C function. The transpiler automatically rewrites all call sites across transpiled code to call `target_c_name(...)`:

```typescript
/**
 * @export_c
 * @use_c: c_fast_checksum
 */
export function checksum(ptr: u32): u32 {
  return 123;
}
```

#### 6. Companion Files (`<module>.manual.c`)
For large or performance-critical manual C functions:
- Create `src/core/c/<module>.manual.c` (e.g. `src/core/c/catalog.manual.c`).
- The transpiler automatically detects it and appends `#include "<module>.manual.c"` at the end of the generated `.c` file.
- The companion file is completely safe from transpiler overwrites.

#### 7. `c_inline(cCode, jsFallback)` (Compile-Time Intrinsic)
Embeds C-specific intrinsics without breaking TypeScript execution:

```typescript
import { c_inline, u32 } from "../types.ts";

export function compute_leading_zeros(val: u32): u32 {
  // In JS: returns Math.clz32(val)
  // In C:  emits __builtin_clz(val)
  return c_inline("__builtin_clz(val)", Math.clz32(val));
}
```

#### 8. `@c_include` & `@c_raw` Directives
- `/** @c_include "custom_header.h" */`: Adds `#include "custom_header.h"` at the top of the generated C file.
- `/** @c_raw ```c ... ``` */`: Injects top-level C macros or typedefs directly into the generated C file.

---

## Support the Project ⭐

WebDB is an ambitious open-source initiative to build a modern, featherweight relational database engine purpose-built for the web platform. If you believe in this vision, here is how you can support the development:

- ⭐ **Star this Repository:** If you find this project interesting or valuable, please give it a **Star on GitHub**. It takes two seconds, boosts project visibility, and helps attract more contributors!
- 🎮 **Explore the Playground & Benchmarks:** Experiment with live queries in the [WebDB Studio Playground](https://ahmad-moussawi.github.io/webdb/playground/) and test throughput with the [In-Browser Benchmarks](https://ahmad-moussawi.github.io/webdb/benchmark/).
- 📢 **Spread the Word:** Share WebDB on X (Twitter), Bluesky, LinkedIn, Reddit, or with developer friends building offline-first or local-first apps.
- 💬 **Join the Discussion:** Review our [Architectural Blueprints](https://ahmad-moussawi.github.io/webdb/plans/plan.html), open an issue with suggestions, or share your offline data use cases.
- 🛠️ **Contribute:** PRs, benchmarks, and feedback on our prototype and specifications are warmly welcome.

WebDB is open source under the [MIT License](https://github.com/ahmad-moussawi/webdb/blob/main/LICENSE).
