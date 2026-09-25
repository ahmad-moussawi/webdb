# System Limitations & Architectural Invariants

This document catalogs the architectural limits, binary format invariants, and deliberate scope boundaries of WebDB V1.

WebDB is engineered for **ultra-lean, deterministic execution** inside browser runtimes (WebAssembly, Web Workers, OPFS, and IndexedDB). To guarantee zero dynamic heap thrashing, instant startup times, and sub-100 KB binary footprints, specific physical boundaries are enforced across storage, virtual machine execution, and query compilation.

---

## 1. Summary of System Limitations

| Category        | Parameter                             |                  V1 Limit                  | Error Thrown / Behavior on Breach                   |
| :-------------- | :------------------------------------ | :----------------------------------------: | :-------------------------------------------------- |
| **Storage**     | Page Size                             |            `4,096 bytes` (4 KB)            | Rigid physical constant.                            |
| **Storage**     | Maximum Row Size                      |               `2,048 bytes`                | `RowSizeLimitExceededError` (compile/insert time)   |
| **Storage**     | Maximum Database Size                 |             `16 TB` (physical)             | Browser Storage Quota Exceeded (OS/device limit)    |
| **Storage**     | Maximum Tables per DB                 | `16 tables` (Page 1) / $\infty$ (chained)  | `CatalogFullError` (forward-compatible to $\infty$) |
| **Storage**     | Maximum Columns per Table             |               `256 columns`                | `TooManyColumnsError` (DDL time)                    |
| **Storage**     | Maximum Identifier Length             |              `64 characters`               | `IdentifierTooLongError` (DDL time)                 |
| **VM**          | Register File Size                    |  `64 registers per frame` (`r[0]..r[63]`)  | `TooManyRegistersError` (compile time)              |
| **VM**          | Active Cursor Slots                   |   `16 cursors per frame` (`c[0]..c[15]`)   | `TooManyCursorsError` (compile time)                |
| **VM**          | Subquery Nesting Depth                |  `8 frames` (depth 0..7, correlated only)  | `SubqueryNestingTooDeepError` (compile time)        |
| **VM**          | Output Result Buffer                  |                  `64 KB`                   | Yields `STATUS_BUFFER_FULL` (chunked streaming)     |
| **VM**          | Transient Query Arena Ceiling         |      `16 MB` (default, configurable)       | `QueryArenaExhaustedError` (fail-fast OOM)          |
| **Query**       | Maximum Sort Columns (`ORDER BY`)     |                `8 columns`                 | `TooManyOrderByColumnsError`                        |
| **Query**       | Maximum Group By Columns (`GROUP BY`) |                `8 columns`                 | `TooManyGroupByColumnsError`                        |
| **Query**       | Secondary Indexes                     | Single-column in V1 (`IndexDescriptor` reserved) | Composite indexes deferred to V1.1+ (zero migration)|
| **Query**       | Table Joins                           |     Up to `16 tables` per query level      | `TooManyCursorsError` if > 16 cursors needed        |
| **Query**       | Subqueries                            | Correlated depth ≤ 7; sequential unlimited | `SubqueryNestingTooDeepError` (compile time)        |
| **Concurrency** | Concurrent Writers                    |         `1 writer` (Web Locks API)         | Serialized in FIFO order via browser locks          |
| **Concurrency** | Active Transactions per Connection    |              `1 transaction`               | `TransactionAlreadyActiveError`                     |

---

## 2. Storage & Binary Layout Invariants

### 2.1 Rigid Page Size (4,096 Bytes)

- **Invariant:** Every database page, internal node, leaf node, and WAL frame is sized to exactly **4,096 bytes** ($2^{12}$).
- **Rationale:** Aligns with standard operating system virtual memory page sizes and browser block I/O (IndexedDB block clustering and OPFS sync blocks). Eliminates variable-length page header decoding.

### 2.2 Maximum Row Size (2,048 Bytes) & No Overflow Pages

- **Invariant:** Serialized row records (header + null-bitmap + fixed-size columns + var-length strings/blobs) must never exceed **2,048 bytes** ($4096 / 2$).
- **Mathematical Proof:** A B+Tree leaf page requires at least 2 records to maintain B-Tree balance invariants during node splits without cascading page collapses. Capping row size at $\frac{\text{Page Size}}{2} = 2048\text{ bytes}$ guarantees every leaf page can hold at least 2 cells plus the page header and slot directory.
- **Failure Mode:** Attempting to insert or update a row whose serialized length $> 2048$ bytes immediately halts and throws `RowSizeLimitExceededError`. Overflow page chains are omitted in V1 to preserve zero-fragmentation slotted page math.

### 2.3 Maximum Database File Size (16 TB Physical / Browser Quota)

- **Invariant:** Page IDs are stored as 32-bit unsigned integers (`uint32_t page_id`).
- **Physical Upper Bound:** $2^{32} \times 4096\text{ bytes} = 17,592,186,044,416\text{ bytes} = 16\text{ TB}$.
- **Browser Runtime Limit:** In actual web browsers, storage is governed by the browser's storage manager quota (typically 60% of available disk space on desktop, or 2 GB–20 GB on mobile). When the device disk fills, the underlying `IVfsAdapter` write fails and yields `DiskFullError`.

### 2.4 Table Catalog Layout (128-Byte `TableDescriptor` & Master Page Layout)

- **Invariant:** Page 1 hosts the master table catalog with pre-allocated slots for up to **16 user tables** in v1, with infinite forward-compatibility via chained catalog pages (`next_catalog_page_id`).
- **Why the 128-Byte Fixed Descriptor Exists:**
  - Page 1 is the Master Database Page.
  - Bytes `0..99` are the Database File Header.
  - Bytes `100..4095` (3,996 bytes) house the **Master Table Catalog**.
  - To prevent format-breaking migrations when column counts or identifier lengths grow, table descriptors are standardized to a fixed **128-byte power-of-two struct**:
    ```c
    typedef struct {
        uint16_t table_id;              // Numeric table ID (1..65535)                    (offset 0..1,   2B)
        uint16_t column_count;          // Number of columns defined (1..256)             (offset 2..3,   2B)
        uint32_t root_page_id;          // Table B+Tree root Page ID                      (offset 4..7,   4B)
        uint32_t col_catalog_page_id;   // First 4KB Catalog Page ID storing ColumnMeta   (offset 8..11,  4B)
        char     name[64];              // Table name (null-padded UTF-8, max 64 chars)   (offset 12..75, 64B)
        uint32_t flags;                 // Status flags (0x1=ACTIVE, 0x2=SYSTEM)          (offset 76..79, 4B)
        uint32_t row_count_estimate;    // Approximate row count for query optimizer      (offset 80..83, 4B)
        uint8_t  _reserved[44];         // Reserved padding for future table metadata     (offset 84..127,44B)
    } TableDescriptor;                  // Exact size: 128 bytes (128 % 8 = 0)
    ```
  - **Page 1 Capacity:**
    - Bytes `100..2147`: 16 pre-allocated `TableDescriptor` slots ($16 \times 128\text{ B} = 2,048\text{ bytes}$).
    - Bytes `2148..3171`: 8 pre-allocated `IndexDescriptor` slots ($8 \times 128\text{ B} = 1,024\text{ bytes}$) for composite indexes.
    - Bytes `3172..3175`: `next_descriptor_catalog_page_id` (`uint32_t`, default `0`), forward-compatible chained catalog page pointer for future descriptor categories (sequences, triggers, constraints).
    - Bytes `3176..4095`: 920 bytes reserved space on Page 1 for future catalog descriptors.
  - **$O(1)$ Schema Dereference:** C/Wasm code locates table metadata via simple pointer arithmetic without parsing:
    ```c
    const TableDescriptor *tbl = (const TableDescriptor*)(page1_ptr + 100 + (table_idx * 128));
    ```
  - **Infinite Table Scalability (`next_catalog_page_id`):** Page 1 header bytes `32..35` point to the next chained 4KB catalog page if $> 16$ tables are created in future versions.

### 2.5 Maximum 256 Columns per Table & Dedicated Column Catalog Pages

- **Invariant:** Tables support between 1 and **256 columns** (`column_count <= 256`).
- **Dedicated Chained Column Catalog Architecture:**
  - Because columns with 64-character names require $72\text{ bytes}$ each (`ColumnMeta`), column metadata is decoupled from Page 1 and stored in dedicated 4KB **Column Catalog Pages** (`page_type = 0x0C`):
    ```c
    typedef struct {
        uint8_t  type;            // 1=INT32, 2=INT64, 3=FLOAT64, 4=TEXT, 5=BLOB, 6=UUID, 7=ULID (offset 0,   1B)
        uint8_t  flags;           // 0x1=PRIMARY KEY, 0x2=NOT NULL, 0x4=INDEXED, 0x8=AUTO_INC     (offset 1,   1B)
        uint16_t col_offset;      // Column offset inside fixed-width data slice                  (offset 2..3, 2B)
        char     name[64];        // Column name (null-padded UTF-8, max 64 chars)                (offset 4..67,64B)
        uint32_t index_root_page; // B+Tree root Page ID if indexed (0 if unindexed)              (offset 68..71,4B)
    } ColumnMeta;                 // Exact size: 72 bytes (72 % 8 = 0, 8-byte aligned)
    ```
  - Each 4KB Column Catalog Page has a 16-byte header (`CatalogPageHeader`), leaving $4,096 - 16 = 4,080$ bytes of payload.
  - Each page holds $\lfloor 4080 / 72 \rfloor = 56$ columns:
    - Tables with $1 \dots 56$ columns occupy **exactly 1 catalog page** (`next_col_catalog_page_id = 0`).
    - Tables with $57 \dots 256$ columns chain across up to **5 catalog pages** via `next_col_catalog_page_id` ($\lceil 256 / 56 \rceil = 5$ pages).
- **Dynamic Row Null-Bitmap Scaling:**
  - The row's binary **Null-Bitmap** is sized dynamically as $\lceil\text{column\_count} / 8\rceil$ bytes.
  - For a 256-column table, the Null-Bitmap is exactly **32 bytes** (`(256 + 7) >> 3 = 32`).
- **Interaction with Single Row Boundary (2,048 Bytes):**
  - All serialized row records must satisfy the rigid physical constraint $\le 2048\text{ bytes}$ (`RowSizeLimitExceededError`).
  - For 256 columns of 4-byte integers (`INT32`), row size is $1 + 32 + (256 \times 4) = 1,057\text{ bytes} \ll 2,048\text{ bytes}$.
  - Tables utilizing wide 8-byte columns (`INT64`, `FLOAT64`, `UUID`) or strings across all 256 columns must ensure non-null populated fields do not exceed 2,048 bytes per row.
- **Failure Mode:** Calling `db.createTable()` with $> 256$ column definitions immediately throws `TooManyColumnsError`.

### 2.6 Maximum Identifier Length (64 Characters)

- **Invariant:** Table names and column names support up to **64 characters** (stored as fixed 64-byte null-padded UTF-8 arrays `char name[64]`).
- **Industry Standard Compatibility:** Matches the enterprise SQL identifier limits of PostgreSQL (`NAMEDATALEN = 64`) and MySQL (`64 chars`), accommodating descriptive domain names (e.g. `organization_billing_subscription_events`).
- **Failure Mode:** Providing an identifier exceeding 64 characters immediately halts DDL compilation and throws `IdentifierTooLongError`.

---

## 3. Memory & Virtual Machine (VDBE) Execution Limits

### 3.1 64-Register File per Frame (`r[0]..r[63]`)

- **Invariant:** Each `VmFrame` provides **64 evaluation registers** per query nesting level.
- **Memory Footprint:** 64 tagged union structs $\times 16\text{ bytes} = 1,024\text{ bytes}$, pre-allocated inline in each `VmFrame` at offsets `224..1247`.
- **Design Rationale:** 64 registers comfortably covers the worst-case simultaneous register pressure of a maximally complex single query level — 16-table join predicates + 8 ORDER BY sort key extractions + 8 GROUP BY keys + 6 aggregate accumulators + UDF results + filter temporaries ≈ 46 registers peak. The 64-register ceiling provides a 38% safety margin.
- **Validation:** The bytecode compiler checks all register operands at compile time; any reference to register index $\ge 64$ halts compilation with `TooManyRegistersError`.

### 3.2 16 Active Cursor Slots per Frame (`cursors[0]..cursors[15]`)

- **Invariant:** A single query level can open at most **16 concurrent cursors** (table scans, index seeks, sorter iterators, arena cursors).
- **Join Support:** With 16 cursor slots, a single query level supports up to **16-table joins** (one scan cursor per table, plus index seek cursors sharing the pool).
- **Subquery Isolation:** Each nesting frame has its own independent cursor set. A correlated subquery at `depth=1` gets a fresh `cursors[0..15]` without disrupting the outer query's pinned cursors at `depth=0`.
- **Buffer Headroom Guarantee:** Across all 8 nesting frames (depth 0..7), the worst-case maximum number of simultaneously active cursors is $8 \times 16 = 128$. In a standard 512-slot cache (2 MB), at least $512 - 128 = 384$ slots remain permanently unpinned for page eviction. In a 1,024-slot cache (4 MB), at least $1,024 - 128 = 896$ slots remain unpinned. Eviction deadlock is mathematically impossible.

### 3.3 8-Frame Nesting Stack (Correlated Subquery Depth ≤ 7)

- **Invariant:** `VmContext` maintains a fixed stack of **8 `VmFrame` structs** (`frames[0..7]`, depth field `0..7`).
- **What counts toward depth:** Only **simultaneously active correlated subqueries** consume frame depth. Sequential scalar subqueries (multiple in a SELECT clause), `FROM` derived tables (materialized in arena), `EXISTS`/`IN` semi-joins (run to completion before outer continues), and JOINs (same frame, more cursors) do NOT consume frame stack depth.
- **Supported depth:** Depth 7 = one outer query + 7 levels of nested correlated subqueries. Depth 3–4 covers virtually all real-world SQL. Depth 7 is a future-proof ceiling that eliminates any practical chance of hitting the limit.
- **Hard limit:** Compiling a correlated subquery requiring `depth > 7` throws `SubqueryNestingTooDeepError` at compile time.
- **Memory Footprint & Future Expansion Budget:** 8 frames $\times 1{,}280\text{ bytes} = 10{,}240\text{ bytes}$ ($+8\text{ B}$ header $= 10{,}248\text{ bytes}$). The `VmContext` memory window is rigidly pre-allocated at $12{,}288\text{ bytes}$ (`0x401080..0x40407F`), providing **2,040 bytes of unallocated expansion cushion** ($12{,}288 - 10{,}248 = 2{,}040\text{ B}$). While each `VmFrame` includes 32 bytes of internal padding for word-alignment, this 2,040-byte unallocated cushion is the designated future expansion budget: if a future engine version requires wider frames (e.g. expanding from 16 to 32 cursors per frame adds $16 \times 12\text{ B} = 192\text{ bytes}$ per frame) or deeper frame stacks, the expansion is absorbed entirely within this cushion without moving the Output Result Buffer at `0x404080` or breaking memory offsets.

### 3.4 64 KB Fixed Result Buffer

- **Invariant:** Output rows are streamed into a pre-allocated 64 KB memory window.
- **Streaming Protocol:** When the 64 KB boundary is reached, the VM yields `STATUS_BUFFER_FULL`. JavaScript drains the rows, resets `result_offset = 0`, and calls `vm_step()` to continue. Memory overhead for query results is strictly bounded at 64 KB regardless of table size.

### 3.4 Transient Query Arena Ceiling (Default: 16 MB, Fully Configurable)

- **Invariant:** Dynamic aggregation hash tables (`GROUP BY`) and unindexed sorting buffers (`ORDER BY`) bump-allocate from the Transient Query Arena (`0x420000..Ceiling`).
- **Why 16 MB is the Default:**
  - **Browser Tab Safety:** Mobile browsers (iOS Safari Jetsam, Android Chrome) terminate web application tabs with zero warning when heap spikes exceed device thresholds. The 16 MB default prevents runaway analytical queries from crashing the user's browser tab.
  - **Fail-Fast Predictability:** Queries with unexpected Cartesian products or pathological cardinality fail fast rather than stalling the UI thread.
- **Extending the Arena Beyond 16 MB:**
  - **Not a Physical Limit:** Because the arena sits at the very tail of the memory map (`0x420000` to end of memory) with no structures placed after it, it can expand dynamically via `WebAssembly.Memory.grow()` up to available host memory (up to 2 GB – 4 GB in Wasm32).
  - **Configuration:** Developers can configure a larger ceiling upon opening the database:
    ```typescript
    const db = await WebDB.open({
      name: "analytics_db",
      maxQueryMemory: 64 * 1024 * 1024, // 64 MB (or 128 MB, 256 MB, etc.)
    });
    ```
- **Fail-Fast Invariant:** If aggregation or sorting exceeds the configured ceiling (`max_query_memory`), the VM halts immediately with `STATUS_ERR_ARENA_EXHAUSTED` and the Promise rejects with `QueryArenaExhaustedError`. **Silent truncation, dropped rows, or partial sums are strictly prohibited.**
- **Instant Recovery:** Resetting `arena_offset = 0` reclaims 100% of transient memory in $O(1)$ time with zero fragmentation.

---

## 4. Query & SQL Feature Limits

### 4.1 Maximum 8 Sort Columns for `ORDER BY`

- **Invariant:** Multi-column sorting (`orderBy([ { column, direction, nulls }, ... ])`) accepts at most **8 sort columns**.
- **Rationale:**
  - Stores the sorting descriptor in a compact 18-byte `KeyInfo` struct (`num_keys: uint8`, `directions: uint8[8]`, `null_orders: uint8[8]`).
  - Allows the multi-key comparator loop in the in-place Introsort algorithm to remain unrolled and SIMD-friendly.
- **Failure Mode:** Emitting an `ORDER BY` with $> 8$ columns throws `TooManyOrderByColumnsError` at compile time.

### 4.2 Maximum 8 Grouping Columns for `GROUP BY`

- **Invariant:** Grouping clauses (`groupBy(['col1', 'col2', ...])`) accept at most **8 grouping columns**.
- **Rationale:**
  - Standardizes the FNV-1a composite hash computation and linear-probe equality checks in the Transient Query Arena.
  - Keeps the 40-byte `AggBucket` layout compact and deterministic.
- **Execution Pathways:**
  - **Hash Aggregation (Unindexed):** Accumulates groups in an open-addressing hash table starting at 1,024 buckets (40 KB) and doubling at 70% load factor up to the 16 MB arena ceiling (`QueryArenaExhaustedError` on overflow).
  - **Stream Aggregation (Indexed/Sorted):** Groups pre-ordered by an index or sorter stream through in $O(1)$ constant memory without allocating a hash table.
- **Failure Mode:** Querying with $> 8$ grouping columns throws `TooManyGroupByColumnsError` at compile time.

### 4.3 Single-Column Secondary Indexes (Forward-Compatible `IndexDescriptor` Architecture)

- **Supported in V1:** Single-column secondary B+Tree indexes (`createIndex(tableName, columnName)`).
- **Format in V1:** Index leaf cells store fixed-width `(indexed_value, rowid)` binary pairs.
- **Forward-Compatible Schema Reservation (Zero Format Breakage in V1.1+):**
  - To prevent breaking changes when composite multi-column indexes (`createIndex('users', ['org_id', 'created_at'])`) are introduced in V1.1, Page 1 pre-allocates an array of **128-byte `IndexDescriptor` structs** at bytes `2148..3171`:
    ```c
    typedef struct {
        uint16_t index_id;              // Numeric index ID (1..65535)                    (offset 0..1,   2B)
        uint16_t table_id;              // Owning table numeric identifier                (offset 2..3,   2B)
        uint32_t root_page_id;          // Index B+Tree root Page ID (0 if unallocated)   (offset 4..7,   4B)
        uint8_t  column_count;          // Number of indexed columns (1=single, 2..8=comp)(offset 8,     1B)
        uint8_t  flags;                 // 0x1=UNIQUE, 0x2=PRIMARY, 0x4=SPATIAL/VECTOR    (offset 9,     1B)
        uint16_t column_indices[8];     // 0-indexed column IDs participating in index   (offset 10..25,16B)
        uint8_t  col_directions[8];     // Sort order per column (0=ASC, 1=DESC)          (offset 26..33, 8B)
        char     name[64];              // Index identifier name (null-padded UTF-8)      (offset 34..97,64B)
        uint8_t  _reserved[30];         // Reserved for partial index filters / stats     (offset 98..127,30B)
    } IndexDescriptor;                  // Exact size: 128 bytes (128 % 8 = 0, power of 2)
    ```
  - **V1 Execution:** Single-column indexes populate `column_count = 1` and `column_indices[0] = col_idx`. The engine creates a single-key B+Tree.
  - **V1.1 Upgrade Path (Zero Migration):** In V1.1+, multi-column indexes populate `column_count = 2..8` and `column_indices[0..N-1]`, with leaf keys serialized as `(val1, val2, ..., rowid)`.
  - **Zero Migration Guarantee:** Because the `IndexDescriptor` slot is already burned into the V1 Page 1 binary format, existing V1 `.db` files load seamlessly in V1.1+ with zero file rewriting or migration tools.

### 4.4 Join Constraints & Cursor Slot Allocation (Query Builder vs. Engine Hard Limit)

A critical distinction exists between the **TypeScript Query Builder layer** and the **Wasm Execution Engine layer**:

1. **TypeScript Query Builder Layer (No Arbitrary Syntactic Ceiling):**
   - The fluent query builder API (`db.from('...').join(...).join(...)...`) has **no arbitrary limit** on the number of `.join()` calls chained in client code.
   - Developers can syntactically chain 20+ joins without TypeScript compiler errors.
2. **Wasm Execution Engine Layer (16 Cursor Hard Limit per Frame):**
   - The physical WebAssembly virtual machine allocates a fixed array of **16 cursor slots per `VmFrame`** (`Cursor cursors[16]`, byte offsets `32..223`).
   - Every joined table in a query plan requires at least 1 cursor for table scanning or index lookup (plus any intermediate sorter or hash probe iterators within the frame).
   - Consequently, the VDBE runtime can execute queries joining **up to 16 tables** per query level.
3. **Compiler Validation & Failure Mode (`TooManyCursorsError`):**
   - When compiling a query AST into bytecode, the WebDB Query Compiler calculates the total number of cursor slots required by the execution plan.
   - If the query requires more than 16 cursors (for example, attempting to execute a 17+ table join, or a complex join graph that exhausts available cursor slots), compilation immediately halts and throws:
     ```typescript
     TooManyCursorsError: Query requires 21 cursors, exceeding the engine limit of 16 cursor slots per frame.
     ```
4. **Supported Join Semantics in V1:**
   - Supported: `INNER JOIN` and `LEFT OUTER JOIN`.
   - Execution Strategy: Left-deep Nested Loop Join and Indexed Nested Loop Join (outer table scan + inner table B+Tree index seeks).
   - Deferred: `RIGHT JOIN` and `FULL OUTER JOIN` (deferred to V1.1+).
5. **Cost Considerations (Absence of CBO in V1):**
   - WebDB V1 executes joins in the exact order specified by the developer in the query builder (left-deep pipeline).
   - Indexed nested loops on indexed foreign keys run in $O(M \log N)$ time.
   - However, unindexed nested loops over multiple tables degrade with Cartesian multiplier complexity ($O(R_1 \times R_2 \times \dots)$). Creating secondary indexes on joined foreign keys is strongly recommended when joining 3+ tables.

### 4.5 Subqueries & 8-Frame Correlated Execution Stack

WebDB V1 supports both uncorrelated and correlated subqueries via its **8-frame nesting stack** (`VmContext.frames[8]`, depth `0..7`):

1. **Correlated Subqueries (`WHERE col = (SELECT ... WHERE inner.x = outer.y)`):**
   - **Supported Nesting Depth:** Up to **7 levels of nested correlated subqueries** (`depth` 0 = outer query, `depth` 1..7 = nested subqueries).
   - **Frame Push & Pop:** When entering a correlated subquery, the VM executes `ctx->depth++`, allocating a fresh `VmFrame` with an independent 64-register file and 16 cursor slots. On completion, the result register is passed to `frames[ctx->depth - 1]`, `ctx->depth--` is popped, and the parent resumes at its saved `pc`.
   - **Failure Mode:** If a correlated subquery hierarchy exceeds depth 7, the compiler rejects the query and throws `SubqueryNestingTooDeepError`.
2. **Sequential Scalar Subqueries (`SELECT (SELECT a FROM ...), (SELECT b FROM ...)`):**
   - Sequential subqueries execute to completion one after the other.
   - They reuse the same frame slot (`depth = 1`), resetting registers and cursors between runs.
   - **Limit:** **Unlimited**. Sequential subqueries do not consume stack depth.
3. **Semi-Joins & Anti-Joins (`EXISTS`, `NOT EXISTS`, `IN (subquery)`):**
   - `EXISTS` and `NOT EXISTS` run to first match and short-circuit.
   - `IN (subquery)` evaluates the inner set into an ephemeral hash set in the Transient Query Arena (`0x420000`) for $O(1)$ probing.
4. **Derived Tables (`FROM (SELECT ...)`):**
   - Derived tables are materialized into the Transient Query Arena (`0x420000`) and iterated using an arena cursor (`flags = 0x4`).
   - They do not consume subquery stack depth (`depth = 0`).

### 4.6 Join & Subquery Evolution Roadmap

| Phase              |    Target Scope    | Join Features                                                                                                                                             | Subquery Features                                                                                                                      | Implementation Architecture                                                                                  |
| :----------------- | :----------------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| **V1.0** (Current) |    Core Engine     | Up to 16 tables per frame (`INNER` & `LEFT JOIN`); query builder has no syntactic ceiling, compiler throws `TooManyCursorsError` if > 16 cursors required | Correlated subqueries up to depth 7 (`SubqueryNestingTooDeepError`); sequential subqueries unlimited; derived tables via arena cursors | 8-frame nesting stack (`VmContext`), 64 registers + 16 cursors per frame; Left-Deep Nested Loop & Index Seek |
| **V1.1**           | Expressive Queries | In-Arena Hash Joins; `RIGHT JOIN` support                                                                                                                 | Hash-accelerated `IN (subquery)` semi-joins in Transient Query Arena                                                                   | In-Arena Hash Tables (`0x420000`), register hoisting, hash probe iterators                                   |
| **V1.2**           | Analytical Queries | Arbitrary join trees with manual hints                                                                                                                    | Subquery decorrelation heuristics                                                                                                      | Adaptive join selection (hash vs nested loop); cross-frame cursor caching                                    |
| **V2.0**           |   Enterprise SQL   | Cost-Based Optimizer (CBO), `FULL OUTER JOIN`                                                                                                             | Advanced subquery unnesting, Cost-based decorrelation                                                                                  | Catalog statistics & histograms, dynamic programming join ordering ($O(3^N)$)                                |

### 4.7 Aggregations & Analytical Queries

- **Supported Aggregate Functions:** `COUNT(*)`, `COUNT(col)`, `SUM(col)`, `AVG(col)`, `MIN(col)`, `MAX(col)`.
- **Post-Aggregation Filtering:** `having(...)` clauses evaluated after bucket aggregation.
- **Deferred:** Window functions (`OVER (PARTITION BY ...)`), `ROLLUP`, `CUBE`, and common table expressions (`WITH ...`).

### 4.8 Schema Mutations (`ALTER TABLE`)

- **Invariant:** Tables cannot be modified in-place dynamically after creation.
- **Migration Pattern:** To alter a schema in V1, applications create the new table, migrate data via `insert()`, and drop the old table. Dynamic column addition/removal is scheduled for future catalog revisions.

---

## 5. Concurrency & Transaction Limits

### 5.1 Single Writer Lock (Multi-Tab Coordination)

- **Invariant:** Only one browser tab or Web Worker may hold an active write transaction at any instant.
- **Mechanism:** Coordination is enforced via the browser's native **Web Locks API** (`navigator.locks.request('webdb_writer_lock_...')`).
- **Behavior:** Concurrent tabs attempting write transactions wait asynchronously in FIFO order. If a holding tab crashes or closes, the browser automatically releases the lock without file corruption.

### 5.2 Single Active Transaction per Database Instance

- **Invariant:** A single `WebDB` instance supports at most one active `db.transaction()` block at a time.
- **Failure Mode:** Initiating a second transaction before the first has resolved or rolled back throws `TransactionAlreadyActiveError`. Nested transactions (savepoints) are deferred.

### 5.3 WAL Checkpoint Threshold (1,000 Frames)

- **Invariant:** The Write-Ahead Log (.wal file) automatically triggers a synchronous checkpoint and truncation when it accumulates **1,000 frames** (~4.1 MB).
- **Rationale:** Keeps crash recovery scans fast (<10 ms on database open) and bounds storage expansion in quota-constrained environments.

---

## 6. Supported Data Types & Conversions

| Type          | Binary Storage        |        Width        | Notes & Emulation                                                           |
| :------------ | :-------------------- | :-----------------: | :-------------------------------------------------------------------------- |
| **`INT32`**   | 32-bit signed integer |       4 bytes       | Little-endian. Clamped range: $-2^{31} \dots 2^{31}-1$.                     |
| **`INT64`**   | 64-bit signed integer |       8 bytes       | Represented in JS as `bigint`. Used for row IDs and millisecond timestamps. |
| **`FLOAT64`** | 64-bit IEEE 754 float |       8 bytes       | Standard JavaScript `number` representation.                                |
| **`TEXT`**    | UTF-8 byte stream     | Var (2B len + data) | Max length bounded by 2048-byte row ceiling.                                |
| **`BLOB`**    | Raw binary bytes      | Var (2B len + data) | Max length bounded by 2048-byte row ceiling.                                |

### Unsupported Types & Recommended Emulations

- **`DECIMAL` / `NUMERIC`:** Store as integer cents/micros (`INT64`) or formatted strings (`TEXT`).
- **`DATE` / `DATETIME`:** Store as UNIX epoch milliseconds (`INT64`) or ISO-8601 strings (`TEXT`).
- **`BOOLEAN`:** Store as `INT32` (`0` for false, `1` for true).
- **`JSON`:** Store as stringified UTF-8 text (`TEXT`).

---

## 7. Comparison Matrix: WebDB V1 vs. SQLite Defaults

| Specification Metric              |              WebDB V1              |       SQLite Default       | Architectural Trade-Off in WebDB                            |
| :-------------------------------- | :--------------------------------: | :------------------------: | :---------------------------------------------------------- |
| **Engine Footprint**              |             `< 100 KB`             |     `~800 KB - 1.5 MB`     | Zero SQL parser in engine, ultra-lean VDBE.                 |
| **Page Size**                     |             Rigid 4 KB             | Configurable (512B - 64KB) | Deterministic memory layout for browser cache.              |
| **Max Row Size**                  |           `2,048 bytes`            |   `1,000,000,000 bytes`    | Eliminates overflow page complexity in V1.                  |
| **Tables per Database**           |  `16 tables` (Page 1) / $\infty$   |   Unlimited ($2^{31}-1$)   | $O(1)$ 128B descriptors; forward-compatible link.           |
| **Columns per Table**             |           `256 columns`            |      `2,000 columns`       | Dedicated catalog pages; dynamic 32-byte Null-Bitmap.       |
| **Max Identifier Length**         |          `64 characters`           | Unlimited (no fixed limit) | Standard SQL length (`char name[64]`); zero string parsing. |
| **Sort Columns (`ORDER BY`)**     |            `8 columns`             |         Unlimited          | Compact 18B key descriptor; unrolled comparisons.           |
| **Grouping Columns (`GROUP BY`)** |            `8 columns`             |         Unlimited          | Compact 40B `AggBucket`; unrolled key comparisons.          |
| **Secondary Indexes**             | Single-column in V1 (`IndexDescriptor` reserved) |   Multi-column composite   | Lean binary traversal in V1; zero-migration composite support in V1.1+. |
| **Virtual Registers**             |   `64 per frame` (8-frame stack)   |    Unlimited (dynamic)     | Static 1,024B inline per frame; per-level isolation.        |
| **Subquery Nesting**              |       Depth ≤ 7 (correlated)       |         Unlimited          | 8-frame fixed stack; sequential subqueries unlimited.       |
| **Table Joins**                   | Up to 16 tables (16 cursors/frame) |         Unlimited          | One cursor per table; 16-cursor frame ceiling.              |
| **Query Arena Ceiling**           |  `16 MB` (default, configurable)   |    Bound by host memory    | Safe default for mobile tabs; configurable up to 2 GB.      |
| **Concurrency Model**             |     Web Locks (Single Writer)      |  POSIX / Win32 file locks  | Native browser multi-tab serialization.                     |
