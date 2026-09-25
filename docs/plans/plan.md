# Strategic Master Plan: WebDB

An ultra-lean, browser-native relational database engine with 4KB slotted pages, register-based VDBE bytecode execution, WAL crash resilience, and dual first-class storage engines (OPFS & IndexedDB).

---

## 1. Executive Summary & Core Philosophy

For over a decade, browser data storage has been caught between two unsatisfactory extremes:
* **The High-Level Gap:** WebSQL was deprecated and abandoned; IndexedDB exposes an awkward, low-level cursor API with no native relational query planning, aggregation, multi-column sorting, or joins.
* **The Low-Level Bloat:** Porting monolithic C databases (like SQLite) via Emscripten produces heavy WebAssembly bundles (500 KB to 2 MB+), requires complex multithreading headers (`COOP`/`COEP`), and bundles redundant C implementations of functions the browser already provides natively.

### The WebDB Vision
**WebDB** is designed from first principles for the modern web platform:
1. **Ultra-Lean Binary Footprint:** Engineered to compile into **<50 KB of WebAssembly** (<20 KB gzipped) in Phase 2.
2. **Web-Native Symbiosis:** Rather than compiling bloated C libraries for dates, regexes, unicode tokenization, cryptography, or locking, WebDB delegates directly to native browser APIs (`Intl.Segmenter`, `crypto.subtle`, `navigator.locks`, `Date`, and `RegExp`) via synchronous User Defined Functions (UDFs).
3. **Dual First-Class Storage:** Co-equal support for high-performance **Origin Private File System (OPFS)** via synchronous access handles and **IndexedDB** for universal compatibility (Safari, iOS WebViews, Private Browsing).
4. **Two-Phase Evolutionary Architecture:**
   * **Version 1 (V1):** Built entirely in JavaScript/TypeScript with **zero C/Wasm compiler dependencies**, but implementing the engine core under **strict C memory semantics** (direct `ArrayBuffer` byte-level pointer arithmetic and flat structs).
   * **Version 2 (V2):** Drop-in replacement of the engine core with compiled C/WebAssembly, requiring **zero changes** to the host JavaScript orchestration layer.

---

## 2. High-Level Macro Architecture

WebDB strictly separates **Host Orchestration** (dynamic, high-level JavaScript) from the **Engine Core** (deterministic, zero-heap byte-level execution).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             HOST ORCHESTRATION LAYER (TypeScript)           │
│                                                                             │
│   Fluent Query Builder ──► Bytecode Compiler ──► Serialized Query FIFO      │
│   Transaction Lease    ──► Result Hydrator   ──► UDF Host Registry          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Shared ArrayBuffer (FFI)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                                ENGINE CORE (C-Style JS in V1 / C-Wasm in V2)│
│                                                                             │
│   ┌─────────────────────┐   ┌──────────────────────┐   ┌────────────────┐   │
│   │ VDBE Bytecode Loop  │   │  B+Tree & Slotted    │   │ Page Cache &   │   │
│   │ 32 Register Machine │   │  Page Engine (4KB)   │   │ Free List      │   │
│   └─────────────────────┘   └──────────────────────┘   └────────────────┘   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Block I/O via Unified IVfsAdapter
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                         DUAL FIRST-CLASS STORAGE ENGINES                    │
│                                                                             │
│   OPFS (SyncAccessHandle)       IndexedDB (Object Stores)       In-Memory   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Clean Boundary Matrix: Host vs. Core

| System Responsibility | Layer | Language (V1 / V2) | Key Function |
| :--- | :--- | :--- | :--- |
| **Query AST & Validation** | Host | TypeScript | Parses fluent calls, validates identifiers, generates query plan |
| **Bytecode Compiler** | Host | TypeScript | Emits flat binary bytecode instructions (`Uint8Array`) |
| **Concurrency & Queue** | Host | TypeScript | Serializes queries, manages user Promises, enforces transaction leases |
| **Block Storage (VFS)** | Host | TypeScript | Drives block I/O against OPFS, IndexedDB, or Memory via `IVfsAdapter` |
| **Result Hydration** | Host | TypeScript | Deserializes output binary row buffers into JavaScript objects |
| **Bytecode Execution** | Core | C-Style JS / Wasm | Synchronous opcode `switch` loop; zero dynamic allocations |
| **Slotted Page Layout** | Core | C-Style JS / Wasm | Formats 4KB pages, slot directories, row records, and in-place compaction |
| **B+Tree Traversal** | Core | C-Style JS / Wasm | Iterative tree search, node splits, cursor navigation |
| **Filter & Aggregates** | Core | C-Style JS / Wasm | Hardware-speed numeric and string comparisons, grouping, sorting |

---

## 3. Phase-by-Phase Strategic Roadmap

The implementation of WebDB is organized into 9 self-contained, sequentially verifiable phases. Each phase has its own dedicated specification document containing full binary layouts, struct definitions, and verification suites.

### Phase 1: Storage & Memory Architecture
* **Focus:** Shared memory layouts, slotted page geometry, database catalog, and VFS abstraction.
* **Core Decisions:**
  * Fixed **4,096-byte page size** and single shared `ArrayBuffer` buffer pool (configurable: 2MB, 4MB, 8MB).
  * Page 1 is a self-contained binary master table (schema catalog and database header) requiring no external JSON or DDL parser.
  * Maximum single row size strictly capped at **2,048 bytes (2KB)** in V1 (preventing complex multi-page overflow chains).
  * First-class support for native 128-bit identity types (**`UUID`** and **`ULID`**) stored as compact 16-byte binary slices (58% storage savings over string representations).
  * Unified `IVfsAdapter` providing co-equal, fully tested persistence for OPFS and IndexedDB.
* 📖 *Full Technical Specification:* [01_storage_memory_arch.md](./01_storage_memory_arch.md)

### Phase 2: Component Architecture & Scope Boundary
* **Focus:** Explicit query feature scope for V1, strict host-engine FFI interfaces, and fail-fast invariants.
* **Core Decisions:**
  * Complete single-table query operators (projections, comparisons, arithmetic, `ORDER BY` with multi-column null collation, `GROUP BY`, `HAVING`, `LIMIT`/`OFFSET`).
  * Joins (`INNER JOIN`, `LEFT JOIN`) supported up to 16 tables per frame (no query builder limit, engine throws `TooManyCursorsError` if > 16 cursors required); subqueries supported up to depth 7 (`SubqueryNestingTooDeepError`).
  * Strict FFI protocol where engine entry points pass and return only primitive numbers (pointers and status codes).
* 📖 *Full Technical Specification:* [02_components_v1_scope.md](./02_components_v1_scope.md)

### Phase 3: VDBE Bytecode Execution Engine
* **Focus:** Register-based virtual database engine designed specifically for WebAssembly constraints.
* **Core Decisions:**
  * Rejection of the classic Volcano iterator model (which incurs high JS/Wasm call-stack overhead and requires dynamic heap allocations).
  * Adoption of an 8-frame execution nesting stack (`VmContext`), with 64 evaluation registers and 16 active cursors per frame.
  * Non-blocking suspension: when a required page is not in the cache, the engine saves its Program Counter and yields `STATUS_PAGE_FAULT` to the host, resuming seamlessly once fetched.
* 📖 *Full Technical Specification:* [03_vdbe_execution_engine.md](./03_vdbe_execution_engine.md)

### Phase 4: Transactions, ACID & WAL Reliability
* **Focus:** Write-Ahead Logging (WAL), atomic commit/rollback, and crash recovery.
* **Core Decisions:**
  * Physical 4,128-byte WAL frame architecture with 32-byte header, CRC32 verification, and atomic commit markers.
  * Page 1 (schema catalog and database counters) is protected uniformly under the WAL write-ahead protocol.
  * Two-phase checkpointing: committed pages are flushed to the main `.db` storage before the WAL is truncated, ensuring zero risk of torn writes.
  * Instant startup crash recovery: incomplete transactions are discarded, and torn frame writes at the tail of the WAL are detected and truncated safely in <10ms.
* 📖 *Full Technical Specification:* [04_transactions_acid_wal.md](./04_transactions_acid_wal.md)

### Phase 5: JavaScript UDF Support (Function Extensibility)
* **Focus:** Synchronous execution of host JavaScript functions during query evaluation.
* **Core Decisions:**
  * Dedicated bytecode instruction (`OP_CALL_UDF`) that calls registered JavaScript functions with arguments marshaled directly through shared memory.
  * Direct access to browser features: `Math`, `Date`, `RegExp`, cryptographic hashing, and `Intl` string operations with zero bundle-size cost.
  * Seamless FFI evolution: in V1, the engine calls registered JS closures directly; in V2, Wasm invokes host JS via standard WebAssembly imports.
* 📖 *Full Technical Specification:* [05_javascript_udf_support.md](./05_javascript_udf_support.md)

### Phase 6: Strict C-Style Rules for V1
* **Focus:** Enforcing low-level memory disciplines in TypeScript to guarantee 1:1 drop-in replacement with C.
* **Core Decisions:**
  * **Zero Dynamic Heap Allocations:** Zero `new Object()`, array literals, closures, or temporary strings created in the hot query execution loop.
  * All structs are modeled as fixed byte offsets within the pre-allocated `ArrayBuffer`.
  * Pointer arithmetic and multi-byte reads explicitly use Little-Endian access via `DataView`.
* 📖 *Full Technical Specification:* [06_c_style_rules_v1.md](./06_c_style_rules_v1.md)

### Phase 7: Multi-Tab Concurrency & Coordination
* **Focus:** Cross-tab synchronization, single-writer coordination, and connection leasing.
* **Core Decisions:**
  * Tier 1 (Evergreen Browsers): Centralized coordination via `SharedWorker`, routing all database operations through a single shared engine.
  * Tier 2 (Universal Tab Coordination): Automatic leader election using the Web Locks API (`navigator.locks`), ensuring a single active writer tab while maintaining read safety across multiple tabs.
* 📖 *Full Technical Specification:* [07_concurrency_multitab_coordination.md](./07_concurrency_multitab_coordination.md)

### Phase 8: V2 C/Wasm Build Pipeline & Toolchain
* **Focus:** Compiling the C engine core into an ultra-lean WebAssembly artifact.
* **Core Decisions:**
  * Standalone compilation via Clang/Emscripten with flags tuned for minimal binary size (`-Os`, `-flto`, `--no-entry`).
  * Exclusion of standard C runtime bloat: zero `libc` overhead, zero custom memory allocators (using WebDB's static buffer pool).
  * Strict binary size ceiling: **<50 KB total uncompressed Wasm** (<20 KB gzipped).
* 📖 *Full Technical Specification:* [08_v2_c_wasm_build_pipeline.md](./08_v2_c_wasm_build_pipeline.md)

### Phase 9: QA, Differential Testing & Verification
* **Focus:** Robust correctness validation, fuzzing, and comparative testing against reference engines.
* **Core Decisions:**
  * Differential testing suite that executes identical SQL statements against both WebDB and SQLite, asserting byte-for-byte query result equivalence.
  * Crash injection harness that randomly interrupts WAL writes to verify 100% crash resilience and zero database corruption.
  * Continuous property-based fuzz testing for slotted page compaction, B+Tree split/merge, and null collation.
* 📖 *Full Technical Specification:* [09_qa_verification_differential_testing.md](./09_qa_verification_differential_testing.md)

---

## 4. Fundamental System Invariants & Guarantees

Every phase of WebDB adheres strictly to the following non-negotiable architectural invariants:

| Category | Invariant Rule | Guarantee & Rationale |
| :--- | :--- | :--- |
| **Memory** | **Zero Dynamic Allocations** | The engine execution loop never invokes memory allocators. All state lives in fixed pre-allocated buffer slots. |
| **Storage** | **Rigid 4,096-Byte Pages** | Every database page and WAL frame payload is strictly 4,096 bytes, aligning perfectly with OS block sizes and OPFS sync access handles. |
| **Row Size** | **2,048-Byte Ceiling** | Maximum single row size is 2KB in V1. Oversized rows fail fast with explicit errors rather than causing silent corruption or complex page chains. |
| **Integrity** | **CRC32 Checksum Validation** | Every 4KB page and WAL frame includes an IEEE 802.3 CRC32 checksum. Torn writes or bit corruption are caught immediately on read. |
| **Durability** | **WAL-First Checkpoint Ordering** | The main database file is flushed to disk before the WAL is truncated. If power is lost at any point, recovery reconstructs committed state cleanly. |
| **Concurrency** | **Single-Writer Exclusive Lease** | Only one active write transaction is permitted at any given moment, serialized via browser Web Locks or SharedWorker. |
| **Portability** | **100% Self-Contained Files** | Database files are fully self-describing via Page 1. No auxiliary catalog files or external configuration are required to open a database. |

---

## 5. Future Extensions & Search Roadmap

WebDB's core architecture is deliberately designed to accommodate advanced modern workloads in future phases:
* **Vector Embeddings & Wasm SIMD:** Native `VECTOR<float32, D>` types with 128-bit Wasm SIMD hardware acceleration for client-side semantic search.
* **Full-Text Search (BM25):** Zero-bundle-size text tokenization using the native `Intl.Segmenter` API combined with Okapi BM25 relevance scoring.
* **Hybrid Search:** Reciprocal Rank Fusion (RRF) combining vector cosine similarity with BM25 full-text scoring in a single query pass.
* **Transparent Database Encryption:** Hardware-accelerated AES-256-GCM page-level encryption via Web Crypto (`crypto.subtle`) decorating the VFS layer.

> For the comprehensive roadmap covering vector search, BM25 text search, and encryption, see [Future Extensions & Search Roadmap](./future_extensions_roadmap.md) and [System Limits & Invariants](./limitations.md).
