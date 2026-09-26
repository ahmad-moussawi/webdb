# Phase 2 Technical Specification: Component Architecture & V1 Scope Boundary

## 1. Executive Summary & Orchestration Boundary

WebDB enforces a strict architectural boundary between **Host Orchestration (JavaScript/TypeScript)** and the **Engine Core (Strict C-Style JS in V1, Compiled C/Wasm in V2)**. 

All asynchronous operations (disk I/O, IndexedDB transactions, OPFS sync handles, microtask scheduling, and user Promise resolution) remain exclusively in the **Host Layer**. The **Engine Core** is a pure, synchronous, deterministic byte-manipulation state machine that accepts raw memory offsets, loops over binary bytecode, and returns numeric status codes.

---

## 2. Component Responsibility Matrix

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ HOST LAYER (JavaScript / TypeScript)                                                   │
│                                                                                         │
│  [Fluent Query Builder]  ──►  [Binary Bytecode Compiler]  ──►  [Async FIFO Query Queue] │
│           │                                                               │             │
│           ▼                                                               ▼             │
│  [Schema Catalog Manager]                                      [Single VmContext Lease] │
│           │                                                               │             │
│           ▼                                                               ▼             │
│  [VFS Adapter (OPFS/IDB)] ◄── [Cache Controller & LRU] ◄── [Transaction Coordinator]    │
└─────────────────────────────────────────┬───────────────────────────────────────────────┘
                                          │ Numeric FFI (vm_step(ctxOffset))
┌─────────────────────────────────────────▼───────────────────────────────────────────────┐
│ ENGINE CORE (V1: Strict C-Style JS / V2: C compiled to wasm32-nostdlib)                 │
│                                                                                         │
│  [Bytecode VM Loop]  ──►  [Slotted Page Engine]  ──►  [B+Tree Traversal Engine]         │
│           │                                                                             │
│           ├──►  [Transient Query Arena (Hash Tables / Sorters)]                         │
│           └──►  [Output Result Marshaller (Binary Record Packing)]                      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Detailed Component Breakdown

| Component Name | Layer | V1 Implementation | V2 Implementation | Invariants & Responsibilities |
| :--- | :--- | :--- | :--- | :--- |
| **Fluent Query Builder** | Host | TypeScript (`src/host/api/`) | TypeScript (`src/host/api/`) | Validates table/column names; builds query AST; enforces type constraints before bytecode emission. |
| **Binary Bytecode Compiler** | Host | TypeScript (`src/host/compiler/`) | TypeScript (`src/host/compiler/`) | Translates query AST into flat `Uint8Array` bytecode; resolves column names to numeric indices; emits jump labels. |
| **Async FIFO Query Queue** | Host | TypeScript (`src/host/driver/`) | TypeScript (`src/host/driver/`) | Strictly serializes execution through the single active `VmContext`. Manages user `Promise` resolution. |
| **Async I/O Driver Loop** | Host | TypeScript (`src/host/driver/`) | TypeScript (`src/host/driver/`) | Drives synchronous `vm_step()`, handles `PAGE_FAULT` by calling VFS to read/write pages, streams rows on `BUFFER_FULL`. |
| **Transaction Coordinator** | Host | TypeScript (`src/host/driver/`) | TypeScript (`src/host/driver/`) | Enforces **Exclusive Transaction Lease**; manages `BEGIN`, `COMMIT`, `ROLLBACK`; writes WAL commit markers. |
| **IO Orchestrator (`io`)** | Host | TypeScript (`src/host/storage/io.ts`) | TypeScript (`src/host/storage/io.ts`) | Drives block I/O against OPFS (`FileSystemSyncAccessHandle`) or IndexedDB Object Stores via `IVfsAdapter`; coordinates page acquires, flushes, and free list. |
| **Result Hydrator** | Host | TypeScript (`src/host/api/`) | TypeScript (`src/host/api/`) | Deserializes binary row records from the Output Result Buffer into JavaScript objects (`Record<string, any>`). |
| **VM Execution Loop** | Core | C-Style JS (`src/core/js/`) | C / Wasm (`src/core/c/`) | Synchronous `while` loop running `switch (opcode)`. Manipulates `ArrayBuffer` directly without dynamic allocations. |
| **Buffer Pool & Cache** | Core | C-Style JS (`src/core/js/`) | C / Wasm (`src/core/c/`) | Open-addressing `page_to_slot` hash table (0x401000); pin/unpin tracking; Clock eviction victim choice; dirty mask. |
| **Slotted Page Engine** | Core | C-Style JS (`src/core/js/`) | C / Wasm (`src/core/c/`) | Reads/writes 4KB pages; slot directory pointer arithmetic; dynamic null-bitmap checking; 2048B limit enforcement. |
| **B+Tree Traverser** | Core | C-Style JS (`src/core/js/`) | C / Wasm (`src/core/c/`) | Iterative tree search using `cursors[16]` stack; searches sorted keys; advances across leaf sibling pointers. |
| **Result Marshaller** | Core | C-Style JS (`src/core/js/`) | C / Wasm (`src/core/c/`) | Copies filtered rows into Output Result Buffer; yields `STATUS_BUFFER_FULL` when 64KB capacity is reached. |

---

## 3. Strict FFI Interface Specification (Host $\leftrightarrow$ Engine Core)

To guarantee that V1 (JS) and V2 (Wasm) are 100% interchangeable without modifying a single line of Host JS code, all engine entry points accept and return **only primitive numbers**:

```typescript
// Core Engine Exported Signatures
interface WebDbCoreEngine {
  /**
   * Initializes the engine memory offsets, hash table geometry, and cache bounds.
   * Explicitly passes all fixed-offset memory regions so the C engine needs zero hardcoded magic numbers.
   */
  vm_init(
    cacheOffset: number,           // 0x000000: Start of 4KB slotted page cache
    slotCount: number,             // e.g. 1024
    slotToPageOffset: number,      // 0x400000: uint32_t slot_to_page[slotCount]
    pageToSlotOffset: number,      // 0x401000: Open-addressing hash table (2048 x 8B)
    pageToSlotBuckets: number,     // e.g. 2048
    dirtyMaskOffset: number,       // 0x405000: Dynamic bitmask (slotCount / 8 bytes)
    vmCtxOffset: number,           // 0x405080: 8-frame VmContext nesting stack (12KB)
    resultBufOffset: number,       // 0x408080: Output result buffer (64KB)
    bytecodeOffset: number,        // 0x418080: Compiled bytecode instruction buffer (32KB)
    pageScratchOffset: number,     // 0x420080: Dedicated 4KB staging buffer for page compaction
    transientArenaOffset: number   // 0x430000: Aligned start of growable transient arena
  ): void;

  /**
   * Executes bytecode instructions until completion, yield, or error.
   * Synchronous state machine. On cache miss, pauses and returns PAGE_FAULT.
   *
   * @param ctxOffset Byte offset of the active VmContext struct
   * @returns VmStatus code:
   *   0 = RUNNING
   *   1 = DONE
   *   2 = PAGE_FAULT  (Host reads ctx.faultPageId, flushes ctx.flushPageId if > 0, loads into ctx.targetSlot)
   *   3 = BUFFER_FULL (Host drains Output Result Buffer, then resumes)
   *   4 = ERROR       (Host inspects ctx.errorCode)
   */
  vm_step(ctxOffset: number): number;

  /**
   * Compacts and defragments a slotted page in-place.
   * Uses the pre-allocated pageScratchOffset (0x420080) initialized via vm_init.
   *
   * @param pageSlotOffset Byte offset of the 4KB page slot in memory
   * @returns 0 on success, or error status code
   */
  page_defrag(pageSlotOffset: number): number;
}
```

---

## 4. Explicit V1 Query Scope & Limitations

### 4.1 Fully Supported Scope in V1
1. **Connection & Configuration:**
   - `WebDB.open({ name, storage: 'opfs' | 'idb' | 'auto', cacheSize: '2MB' | '4MB' | '8MB' })`.
2. **Schema DDL:**
   - `createTable(name, columns)` (up to 16 tables on Page 1 / $\infty$ via chained catalog pages; up to 256 columns per table; identifiers up to 64 characters; supports `int32`, `int64`, `float64`, `text`, `blob`, `uuid`, and `ulid`).
   - `dropTable(name)`.
   - `createIndex(tableName, columnName)`.
3. **Data Mutation (DML):**
   - `insert(tableName, row)`.
   - `update(tableName, values).where(...)`.
   - `delete(tableName).where(...)`.
4. **Query Operators:**
   - Projections & Aggregations: `select([...columns])` with aggregate functions (`count()`, `count(col)`, `sum(col)`, `avg(col)`, `min(col)`, `max(col)`).
   - Comparisons: `=`, `!=`, `>`, `>=`, `<`, `<=`.
   - SQLite Null Checks: `whereNull(col)`, `whereNotNull(col)`.
   - Grouping & Aggregation: `groupBy(col | cols[])` (up to 8 columns max) and `having(...)`.
   - Pagination: `limit(n)`, `offset(n)`.
   - Sorting: `orderBy(col, 'asc' | 'desc')` or multi-column `orderBy([{ column, direction?, nulls? }, ...])` (max 8 columns, SQLite null collation).
   - Table Joins: `join(table, leftCol, rightCol)`, `leftJoin(...)`. Fluent query builder has no syntactic join limit; engine supports up to 16 cursors/tables per frame (`TooManyCursorsError` if exceeded).
   - Subqueries: Correlated subqueries up to nesting depth 7 (`SubqueryNestingTooDeepError` if exceeded); sequential scalar subqueries unlimited; derived tables via query arena.
5. **Transactions:**
   - `await db.transaction(async (tx) => { ... })` with atomic auto-rollback on error.
6. **Extensibility & Diagnostics:**
   - UDF Registration: `db.registerFunction(name, fn)`.
   - Inspection: `query.explain()`. Returns:
     ```typescript
     interface ExplainResult {
       plan: string; // High-level human-readable query plan summary
       instructions: Array<{
         pc: number;
         opcode: string;
         p1: number;
         p2: number;
         p3: number;
         comment?: string;
       }>;
       disassembly: string; // ASCII tabular representation of compiled VDBE bytecode
     }
     ```

### 4.2 Explicitly Deferred Features (Scheduled for V1.1+)
- `FULL OUTER JOIN`, `RIGHT JOIN`, and hash-join acceleration (deferred to V1.1+; see [limitations.md §4.4–4.6](./limitations.md#_4-4-join-constraints-cursor-slot-allocation-query-builder-vs-engine-hard-limit)).
- Window functions (`OVER (PARTITION BY ...)`), `ROLLUP`, and `CUBE` (deferred to V1.1+; see [limitations.md §4.5–4.6](./limitations.md#_4-5-subqueries-8-frame-correlated-execution-stack)).
- Dynamic `ALTER TABLE` schema mutations (tables must be recreated in V1).
- Composite multi-column secondary indexes (single-column secondary indexes supported in V1; composite deferred to V1.1+ with zero file format changes via reserved `IndexDescriptor` slots; see [limitations.md §4.3](./limitations.md#_4-3-single-column-secondary-indexes-forward-compatible-indexdescriptor-architecture)).

---

## 5. Exhaustive Edge Cases & Failure Modes

### A. Identifier & Schema Validation
* [ ] **Case-Insensitive Identifiers:** Table and column names must resolve case-insensitively (e.g. `users`, `USERS`, `Users` resolve to the same table ID).
* [ ] **Identifier Length Clamping:** Table and column names exceeding 64 characters must be rejected with `IdentifierTooLongError`.
* [ ] **Duplicate Table / Column Names:** Creating a table with duplicate column names or creating an existing table without `ifNotExists` must throw `TableAlreadyExistsError`.
* [ ] **Column Ceiling Violation:** Creating a table with $> 256$ column definitions must throw `TooManyColumnsError`.
* [ ] **Cascade Drop on Active Indexes:** Executing `dropTable(name)` on a table with active secondary indexes automatically cascade-drops all associated indexes, recycles their B+Tree pages to the free-page list, and zeroes their `IndexDescriptor` slots in Page 1.

### B. Serialization, Constraints & Auto-Increment
* [ ] **Missing Table Handling:** Executing a query or insert on a non-existent table must throw `TableNotFoundError`.
* [ ] **Type Coercion & Range Safety:** Passing a floating-point number into an `INT32` column must truncate cleanly to 32-bit signed integer or throw `InvalidDataTypeError` on overflow.
* [ ] **`NOT NULL` Constraint Guard:** Any attempt to set a `NOT NULL` column to `null` or `undefined` must throw `NotNullConstraintError` immediately before writing dirty bytes.
* [ ] **`AUTO_INC` Column Semantics on `INSERT`:**
  - If omitted or explicitly passed as `null`/`undefined`: auto-assigns current `auto_inc_next` and increments `auto_inc_next++` in `TableDescriptor`.
  - If explicitly provided with an integer value $V$: assigns $V$, and advances `auto_inc_next = max(auto_inc_next, V + 1n)`.
  - If `auto_inc_next` reaches $2^{63}-1$ (`INT64_MAX`): throws `IntegerOverflowError`.
* [ ] **Order By Column Ceiling:** Querying with $> 8$ sort columns must throw `TooManyOrderByColumnsError` at compile time.
* [ ] **Group By Column Ceiling:** Querying with $> 8$ grouping columns must throw `TooManyGroupByColumnsError` at compile time.

### C. Queue & Concurrency Fail-Fasts
* [ ] **Exclusive Transaction Lease Starvation:** Non-transaction queries enqueued during an active `db.transaction()` must wait in FIFO order without timing out or throwing lock conflicts.
* [ ] **Abandoned Transaction Timeout (30 Seconds):** If user transaction code hangs on an unresolved network `Promise` inside `db.transaction()`, the JS Host must timeout after 30 seconds, automatically trigger `ROLLBACK`, release the lease, and unblock the queue.

---

## 6. Source Code Directory Structure

```
src/
├── host/                    # Host Orchestration Layer (TypeScript)
│   ├── api/                 # Fluent Query Builder & Public WebDB Interface
│   ├── compiler/            # AST -> Binary Bytecode Compiler
│   ├── storage/             # Asynchronous Block I/O Adapters (Memory, IDB, OPFS) & WAL
│   └── driver/              # Async State Machine Driver Loop (drives vm_step on PAGE_FAULT)
│
├── core/                    # Engine Core State Machine (Zero-Allocation, Deterministic)
│   ├── js/                  # Phase 1: Pure C-Style TypeScript/JS (to be ported 1:1 to C)
│   │   ├── vm.ts            # Synchronous VDBE opcode loop (vm_step)
│   │   ├── buffer_pool.ts   # Cache manager: slot assignment, clock eviction, pinning
│   │   ├── page_table.ts    # Binary open-addressing hash table (0x401000 page_to_slot)
│   │   ├── page.ts          # Slotted page engine, row packing, defragmentation
│   │   ├── btree.ts         # B+tree interior/leaf traversal and node splitting
│   │   └── catalog.ts       # Page 1 binary schema layout & table descriptors
│   │
│   └── c/                   # Phase 2: C Source Code (compiled to wasm32-nostdlib)
│       ├── vm.c             # Ported VDBE execution loop
│       ├── buffer_pool.c    # Ported cache manager & clock replacement
│       ├── page_table.c     # Ported open-addressing hash table
│       ├── page.c           # Ported slotted page geometry
│       ├── btree.c          # Ported B+tree traversal
│       └── catalog.c        # Ported catalog layout
│
├── layouts/                 # Shared JSON schemas & build-time generated struct offsets
└── types/                   # Shared TypeScript interfaces, FFI definitions & error taxonomy
```

---

## 7. Verification & Test Suite (`tests/components_scope.test.ts`)

1. **Schema DDL & Casing:** Create `MyTable`; assert queries against `mytable` succeed.
2. **Identifier Limits:** Assert table names of 65+ characters throw `IdentifierTooLongError`.
3. **Column Limits:** Assert creating a table with 257 columns throws `TooManyColumnsError`.
4. **Queue Serialization:** Dispatch 100 concurrent `Promise.all` read/write queries; assert zero race conditions and 100% deterministic results.
5. **Transaction Lease Isolation:** Dispatch a write query outside a transaction while a transaction is sleeping; assert write query executes strictly after `COMMIT`.
6. **Auto-Increment & Drop Index Cascade:** Assert explicit auto-inc adjusts high-water mark, and dropping a table cascade-recycles index pages.
