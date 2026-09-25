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
| **Fluent Query Builder** | Host | TypeScript | TypeScript | Validates table/column names; builds query AST; enforces type constraints before bytecode emission. |
| **Binary Bytecode Compiler** | Host | TypeScript | TypeScript | Translates query AST into flat `Uint8Array` bytecode; resolves column names to numeric indices; emits jump labels. |
| **Async FIFO Query Queue** | Host | TypeScript | TypeScript | Strictly serializes execution through the single active `VmContext`. Manages user `Promise` resolution. |
| **Transaction Coordinator** | Host | TypeScript | TypeScript | Enforces **Exclusive Transaction Lease**; manages `BEGIN`, `COMMIT`, `ROLLBACK`; writes WAL commit markers. |
| **VFS Orchestrator** | Host | TypeScript | TypeScript | Drives block I/O against OPFS (`FileSystemSyncAccessHandle`) or IndexedDB Object Stores via `IVfsAdapter`. |
| **Cache Controller & LRU** | Host | TypeScript | TypeScript | Tracks resident Page IDs in cache slots; enforces **Pinning Invariant**; coordinates WAL eviction flushes. |
| **Result Hydrator** | Host | TypeScript | TypeScript | Deserializes binary row records from the Output Result Buffer into JavaScript objects (`Record<string, any>`). |
| **VM Execution Loop** | Core | C-Style JS | C / Wasm | Synchronous `while` loop running `switch (opcode)`. Manipulates `ArrayBuffer` directly without dynamic allocations. |
| **Slotted Page Engine** | Core | C-Style JS | C / Wasm | Reads/writes 4KB pages; slot directory pointer arithmetic; dynamic null-bitmap checking; 2048B limit enforcement. |
| **B+Tree Traverser** | Core | C-Style JS | C / Wasm | Iterative tree search using `cursors[16]` stack; searches sorted keys; advances across leaf sibling pointers. |
| **Result Marshaller** | Core | C-Style JS | C / Wasm | Copies filtered rows into Output Result Buffer; yields `STATUS_BUFFER_FULL` when 64KB capacity is reached. |

---

## 3. Strict FFI Interface Specification (Host $\leftrightarrow$ Engine Core)

To guarantee that V1 (JS) and V2 (Wasm) are 100% interchangeable without modifying a single line of Host JS code, all engine entry points accept and return **only primitive numbers**:

```typescript
// Core Engine Exported Signatures
interface WebDbCoreEngine {
  /**
   * Initializes the engine memory offsets and cache geometry.
   * @param cacheOffset Byte offset where 4KB cache slots begin (0x000000)
   * @param slotCount Total number of 4KB slots (e.g. 1024)
   * @param scratchOffset Byte offset for scratchpad and VmContext (0x401080)
   */
  vm_init(cacheOffset: number, slotCount: number, scratchOffset: number): void;

  /**
   * Executes bytecode instructions until completion, yield, or error.
   * @param ctxOffset Byte offset of the active VmContext struct
   * @returns VmStatus code (0=RUNNING, 1=DONE, 2=PAGE_FAULT, 3=BUFFER_FULL, 4=ERROR)
   */
  vm_step(ctxOffset: number): number;

  /**
   * Compacts and defragments a slotted page in-place.
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
   - Inspection: `query.explain()` (high-level plan + VDBE disassembly).

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

### B. Serialization & Constraint Violations
* [ ] **Missing Table Handling:** Executing a query or insert on a non-existent table must throw `TableNotFoundError`.
* [ ] **Type Coercion & Range Safety:** Passing a floating-point number into an `INT32` column must truncate cleanly to 32-bit signed integer or throw `InvalidDataTypeError` on overflow.
* [ ] **`NOT NULL` Constraint Guard:** Any attempt to set a `NOT NULL` column to `null` or `undefined` must throw `NotNullConstraintError` immediately before writing dirty bytes.
* [ ] **Order By Column Ceiling:** Querying with $> 8$ sort columns must throw `TooManyOrderByColumnsError` at compile time.
* [ ] **Group By Column Ceiling:** Querying with $> 8$ grouping columns must throw `TooManyGroupByColumnsError` at compile time.

### C. Queue & Concurrency Fail-Fasts
* [ ] **Exclusive Transaction Lease Starvation:** Non-transaction queries enqueued during an active `db.transaction()` must wait in FIFO order without timing out or throwing lock conflicts.
* [ ] **Abandoned Transaction Timeout:** If user transaction code hangs on an unresolved network `Promise` inside `db.transaction()`, the JS Host must timeout after 30 seconds, automatically trigger `ROLLBACK`, release the lease, and unblock the queue.

---

## 6. Verification & Test Suite (`tests/components_scope.test.ts`)

1. **Schema DDL & Casing:** Create `MyTable`; assert queries against `mytable` succeed.
2. **Identifier Limits:** Assert table names of 65+ characters throw `IdentifierTooLongError`.
3. **Column Limits:** Assert creating a table with 257 columns throws `TooManyColumnsError`.
4. **Queue Serialization:** Dispatch 100 concurrent `Promise.all` read/write queries; assert zero race conditions and 100% deterministic results.
5. **Transaction Lease Isolation:** Dispatch a write query outside a transaction while a transaction is sleeping; assert write query executes strictly after `COMMIT`.
