# System Limitations & Architectural Invariants

This document catalogs the architectural limits, binary format invariants, and deliberate scope boundaries of WebDB V1. 

WebDB is engineered for **ultra-lean, deterministic execution** inside browser runtimes (WebAssembly, Web Workers, OPFS, and IndexedDB). To guarantee zero dynamic heap thrashing, instant startup times, and sub-100 KB binary footprints, specific physical boundaries are enforced across storage, virtual machine execution, and query compilation.

---

## 1. Summary of System Limitations

| Category | Parameter | V1 Limit | Error Thrown / Behavior on Breach |
| :--- | :--- | :---: | :--- |
| **Storage** | Page Size | `4,096 bytes` (4 KB) | Rigid physical constant. |
| **Storage** | Maximum Row Size | `2,048 bytes` | `RowSizeLimitExceededError` (compile/insert time) |
| **Storage** | Maximum Database Size | `16 TB` (physical) | Browser Storage Quota Exceeded (OS/device limit) |
| **Storage** | Maximum Tables per DB | `10 tables` (V1) | `CatalogFullError` (forward-compatible to $\infty$) |
| **Storage** | Maximum Columns per Table | `16 columns` | `TooManyColumnsError` |
| **Storage** | Maximum Identifier Length | `15 ASCII characters` | `IdentifierTooLongError` |
| **VM** | Register File Size | `16 registers` (`r[0]..r[15]`) | Compile-time rejection |
| **VM** | Active Cursor Slots | `16 cursors` (`c[0]..c[15]`) | Compile-time rejection |
| **VM** | Output Result Buffer | `64 KB` | Yields `STATUS_BUFFER_FULL` (chunked streaming) |
| **VM** | Transient Query Arena Ceiling | `16 MB` (default, configurable) | `QueryArenaExhaustedError` (fail-fast OOM) |
| **Query** | Maximum Sort Columns (`ORDER BY`) | `8 columns` | `TooManyOrderByColumnsError` |
| **Query** | Maximum Group By Columns (`GROUP BY`) | `8 columns` | `TooManyGroupByColumnsError` |
| **Query** | Secondary Indexes | Single-column only | Composite indexes deferred to V1.1+ |
| **Query** | Table Joins | Up to 2 tables (`INNER`, `LEFT`) | Right & Full Outer Joins deferred |
| **Concurrency** | Concurrent Writers | `1 writer` (Web Locks API) | Serialized in FIFO order via browser locks |
| **Concurrency** | Active Transactions per Connection | `1 transaction` | `TransactionAlreadyActiveError` |

---

## 2. Storage & Binary Layout Invariants

### 2.1 Rigid Page Size (4,096 Bytes)
* **Invariant:** Every database page, internal node, leaf node, and WAL frame is sized to exactly **4,096 bytes** ($2^{12}$).
* **Rationale:** Aligns with standard operating system virtual memory page sizes and browser block I/O (IndexedDB block clustering and OPFS sync blocks). Eliminates variable-length page header decoding.

### 2.2 Maximum Row Size (2,048 Bytes) & No Overflow Pages
* **Invariant:** Serialized row records (header + null-bitmap + fixed-size columns + var-length strings/blobs) must never exceed **2,048 bytes** ($4096 / 2$).
* **Mathematical Proof:** A B+Tree leaf page requires at least 2 records to maintain B-Tree balance invariants during node splits without cascading page collapses. Capping row size at $\frac{\text{Page Size}}{2} = 2048\text{ bytes}$ guarantees every leaf page can hold at least 2 cells plus the page header and slot directory.
* **Failure Mode:** Attempting to insert or update a row whose serialized length $> 2048$ bytes immediately halts and throws `RowSizeLimitExceededError`. Overflow page chains are omitted in V1 to preserve zero-fragmentation slotted page math.

### 2.3 Maximum Database File Size (16 TB Physical / Browser Quota)
* **Invariant:** Page IDs are stored as 32-bit unsigned integers (`uint32_t page_id`).
* **Physical Upper Bound:** $2^{32} \times 4096\text{ bytes} = 17,592,186,044,416\text{ bytes} = 16\text{ TB}$.
* **Browser Runtime Limit:** In actual web browsers, storage is governed by the browser's storage manager quota (typically 60% of available disk space on desktop, or 2 GB–20 GB on mobile). When the device disk fills, the underlying `IVfsAdapter` write fails and yields `DiskFullError`.

### 2.4 Maximum 10 Tables per Database (V1 Master Page Layout)
* **Invariant:** A single database file supports up to **10 user tables** in V1.
* **Why the 10-Table Limit Exists:**
  - Page 1 is the Master Database Page.
  - Bytes `0..99` are the Database File Header.
  - Bytes `100..4095` (3,996 bytes) house the **Binary Master Table** (schema catalog).
  - WebDB avoids SQL DDL parsers and JSON catalogs; schemas are stored as packed C structs:
    ```c
    typedef struct {
        uint8_t  type;          // 1B
        uint8_t  flags;         // 1B
        uint16_t col_offset;    // 2B
        char     name[16];      // 16B
    } ColumnMeta;               // Total: 20 bytes

    typedef struct {
        uint16_t table_id;      // 2B
        uint16_t column_count;  // 2B
        uint32_t root_page_id;  // 4B
        char     name[16];      // 16B
        ColumnMeta columns[16]; // 16 * 20B = 320B
    } TableMeta;                // Total: 344 bytes
    ```
  - Usable space: $\frac{3,996\text{ bytes}}{344\text{ bytes}} = 11.61\text{ tables}$.
  - Rounded down to **10 tables** ($10 \times 344 = 3,440\text{ bytes}$), leaving 556 bytes free for reserved header flags.
* **Benefit:** Instant $O(1)$ schema lookup on database boot. Zero string parsing, zero heap allocations, and zero secondary disk fetches to load the catalog.
* **Forward-Compatible Upgrade Hook (`next_catalog_page_id`):**
  - Page 1 header bytes `32..35` are formally assigned to `next_catalog_page_id` (`uint32_t`, default `0` in V1).
  - In V2/future extensions, creating an 11th table allocates a chained 4KB catalog page. Existing V1 databases with $\le 10$ tables will load seamlessly with zero schema migrations.

### 2.5 Maximum 16 Columns per Table
* **Invariant:** Tables support between 1 and 16 columns (`column_count <= 16`).
* **Rationale:**
  - Standardizes the `TableMeta.columns[16]` struct array to exactly 320 bytes.
  - Keeps the row's binary **Null-Bitmap** compact: $\lceil 16 / 8 \rceil = 2\text{ bytes}$.
* **Failure Mode:** Calling `db.createTable()` with $> 16$ column definitions throws `TooManyColumnsError`.

### 2.6 Maximum Identifier Length (15 ASCII Characters)
* **Invariant:** Table names and column names must be at most **15 ASCII characters** long.
* **Rationale:** Names are stored in null-padded fixed 16-byte arrays (`char name[16]`). The 16th byte is reserved for the null terminator (`\0`).
* **Failure Mode:** Providing an identifier with $> 15$ characters throws `IdentifierTooLongError`.

---

## 3. Memory & Virtual Machine (VDBE) Execution Limits

### 3.1 16-Register File (`r[0]..r[15]`)
* **Invariant:** The bytecode engine provides exactly 16 evaluation registers per query context.
* **Memory Footprint:** 16 tagged union structs $\times 16\text{ bytes} = 256\text{ bytes}$, pre-allocated inline in `VmContext` at offsets `216..471`.
* **Validation:** The bytecode compiler checks all register operands at compile time; any reference to register index $\ge 16$ halts compilation with an error.

### 3.2 16 Active Cursor Slots (`cursors[0]..cursors[15]`)
* **Invariant:** A single query plan can open at most 16 concurrent cursors (table scans, index seeks, sorter iterators).
* **Buffer Headroom Guarantee:** With 64 total page slots in the shared memory buffer cache, 16 active cursors ensure that at most 16 slots are pinned at any moment. The Clock eviction algorithm is mathematically guaranteed $\ge 48$ unpinned slots to satisfy page faults without deadlock.

### 3.3 64 KB Fixed Result Buffer
* **Invariant:** Output rows are streamed into a pre-allocated 64 KB memory window.
* **Streaming Protocol:** When the 64 KB boundary is reached, the VM yields `STATUS_BUFFER_FULL`. JavaScript drains the rows, resets `result_offset = 0`, and calls `vm_step()` to continue. Memory overhead for query results is strictly bounded at 64 KB regardless of table size.

### 3.4 Transient Query Arena Ceiling (Default: 16 MB, Fully Configurable)
* **Invariant:** Dynamic aggregation hash tables (`GROUP BY`) and unindexed sorting buffers (`ORDER BY`) bump-allocate from the Transient Query Arena (`0x420000..Ceiling`).
* **Why 16 MB is the Default:**
  - **Browser Tab Safety:** Mobile browsers (iOS Safari Jetsam, Android Chrome) terminate web application tabs with zero warning when heap spikes exceed device thresholds. The 16 MB default prevents runaway analytical queries from crashing the user's browser tab.
  - **Fail-Fast Predictability:** Queries with unexpected Cartesian products or pathological cardinality fail fast rather than stalling the UI thread.
* **Extending the Arena Beyond 16 MB:**
  - **Not a Physical Limit:** Because the arena sits at the very tail of the memory map (`0x420000` to end of memory) with no structures placed after it, it can expand dynamically via `WebAssembly.Memory.grow()` up to available host memory (up to 2 GB – 4 GB in Wasm32).
  - **Configuration:** Developers can configure a larger ceiling upon opening the database:
    ```typescript
    const db = await WebDB.open({
      name: 'analytics_db',
      maxQueryMemory: 64 * 1024 * 1024, // 64 MB (or 128 MB, 256 MB, etc.)
    });
    ```
* **Fail-Fast Invariant:** If aggregation or sorting exceeds the configured ceiling (`max_query_memory`), the VM halts immediately with `STATUS_ERR_ARENA_EXHAUSTED` and the Promise rejects with `QueryArenaExhaustedError`. **Silent truncation, dropped rows, or partial sums are strictly prohibited.**
* **Instant Recovery:** Resetting `arena_offset = 0` reclaims 100% of transient memory in $O(1)$ time with zero fragmentation.

---

## 4. Query & SQL Feature Limits

### 4.1 Maximum 8 Sort Columns for `ORDER BY`
* **Invariant:** Multi-column sorting (`orderBy([ { column, direction, nulls }, ... ])`) accepts at most **8 sort columns**.
* **Rationale:**
  - Stores the sorting descriptor in a compact 18-byte `KeyInfo` struct (`num_keys: uint8`, `directions: uint8[8]`, `null_orders: uint8[8]`).
  - Allows the multi-key comparator loop in the in-place Introsort algorithm to remain unrolled and SIMD-friendly.
* **Failure Mode:** Emitting an `ORDER BY` with $> 8$ columns throws `TooManyOrderByColumnsError` at compile time.

### 4.2 Maximum 8 Grouping Columns for `GROUP BY`
* **Invariant:** Grouping clauses (`groupBy(['col1', 'col2', ...])`) accept at most **8 grouping columns**.
* **Rationale:**
  - Standardizes the FNV-1a composite hash computation and linear-probe equality checks in the Transient Query Arena.
  - Keeps the 40-byte `AggBucket` layout compact and deterministic.
* **Execution Pathways:**
  - **Hash Aggregation (Unindexed):** Accumulates groups in an open-addressing hash table starting at 1,024 buckets (40 KB) and doubling at 70% load factor up to the 16 MB arena ceiling (`QueryArenaExhaustedError` on overflow).
  - **Stream Aggregation (Indexed/Sorted):** Groups pre-ordered by an index or sorter stream through in $O(1)$ constant memory without allocating a hash table.
* **Failure Mode:** Querying with $> 8$ grouping columns throws `TooManyGroupByColumnsError` at compile time.

### 4.3 Single-Column Secondary Indexes Only (No Composite Indexes in V1)
* **Invariant:** Secondary B+Tree indexes index exactly one column (`createIndex(tableName, columnName)`).
* **Format:** Index leaf cells store fixed-width `(indexed_value, rowid)` binary pairs.
* **Status:** Composite multi-column indexes (`createIndex('users', ['org_id', 'created_at'])`) are deferred to V1.1+.

### 4.4 Join Constraints (Max 2 Tables, INNER and LEFT JOIN Only)
* **Supported:** Single-table scans, 2-table `INNER JOIN`, and 2-table `LEFT OUTER JOIN`.
* **Deferred:** 3+ table join graphs, `RIGHT JOIN`, and `FULL OUTER JOIN`.

### 4.5 Aggregations & Analytical Queries
* **Supported Aggregate Functions:** `COUNT(*)`, `COUNT(col)`, `SUM(col)`, `AVG(col)`, `MIN(col)`, `MAX(col)`.
* **Post-Aggregation Filtering:** `having(...)` clauses evaluated after bucket aggregation.
* **Deferred:** Window functions (`OVER (PARTITION BY ...)`), `ROLLUP`, `CUBE`, and common table expressions (`WITH ...`).

### 4.6 Schema Mutations (`ALTER TABLE`)
* **Invariant:** Tables cannot be modified in-place dynamically after creation.
* **Migration Pattern:** To alter a schema in V1, applications create the new table, migrate data via `insert()`, and drop the old table. Dynamic column addition/removal is scheduled for future catalog revisions.

---

## 5. Concurrency & Transaction Limits

### 5.1 Single Writer Lock (Multi-Tab Coordination)
* **Invariant:** Only one browser tab or Web Worker may hold an active write transaction at any instant.
* **Mechanism:** Coordination is enforced via the browser's native **Web Locks API** (`navigator.locks.request('webdb_writer_lock_...')`).
* **Behavior:** Concurrent tabs attempting write transactions wait asynchronously in FIFO order. If a holding tab crashes or closes, the browser automatically releases the lock without file corruption.

### 5.2 Single Active Transaction per Database Instance
* **Invariant:** A single `WebDB` instance supports at most one active `db.transaction()` block at a time.
* **Failure Mode:** Initiating a second transaction before the first has resolved or rolled back throws `TransactionAlreadyActiveError`. Nested transactions (savepoints) are deferred.

### 5.3 WAL Checkpoint Threshold (1,000 Frames)
* **Invariant:** The Write-Ahead Log (.wal file) automatically triggers a synchronous checkpoint and truncation when it accumulates **1,000 frames** (~4.1 MB).
* **Rationale:** Keeps crash recovery scans fast (<10 ms on database open) and bounds storage expansion in quota-constrained environments.

---

## 6. Supported Data Types & Conversions

| Type | Binary Storage | Width | Notes & Emulation |
| :--- | :--- | :---: | :--- |
| **`INT32`** | 32-bit signed integer | 4 bytes | Little-endian. Clamped range: $-2^{31} \dots 2^{31}-1$. |
| **`INT64`** | 64-bit signed integer | 8 bytes | Represented in JS as `bigint`. Used for row IDs and millisecond timestamps. |
| **`FLOAT64`**| 64-bit IEEE 754 float | 8 bytes | Standard JavaScript `number` representation. |
| **`TEXT`** | UTF-8 byte stream | Var (2B len + data) | Max length bounded by 2048-byte row ceiling. |
| **`BLOB`** | Raw binary bytes | Var (2B len + data) | Max length bounded by 2048-byte row ceiling. |

### Unsupported Types & Recommended Emulations
* **`DECIMAL` / `NUMERIC`:** Store as integer cents/micros (`INT64`) or formatted strings (`TEXT`).
* **`DATE` / `DATETIME`:** Store as UNIX epoch milliseconds (`INT64`) or ISO-8601 strings (`TEXT`).
* **`BOOLEAN`:** Store as `INT32` (`0` for false, `1` for true).
* **`JSON`:** Store as stringified UTF-8 text (`TEXT`).

---

## 7. Comparison Matrix: WebDB V1 vs. SQLite Defaults

| Specification Metric | WebDB V1 | SQLite Default | Architectural Trade-Off in WebDB |
| :--- | :---: | :---: | :--- |
| **Engine Footprint** | `< 100 KB` | `~800 KB - 1.5 MB` | Zero SQL parser in engine, ultra-lean VDBE. |
| **Page Size** | Rigid 4 KB | Configurable (512B - 64KB) | Deterministic memory layout for browser cache. |
| **Max Row Size** | `2,048 bytes` | `1,000,000,000 bytes` | Eliminates overflow page complexity in V1. |
| **Tables per Database** | `10 tables` (V1) | Unlimited ($2^{31}-1$) | $O(1)$ zero-parsing schema read; forward-compatible link. |
| **Columns per Table** | `16 columns` | `2,000 columns` | Fixed 320B descriptor; 2-byte null-bitmap. |
| **Sort Columns (`ORDER BY`)** | `8 columns` | Unlimited | Compact 18B key descriptor; unrolled comparisons. |
| **Grouping Columns (`GROUP BY`)** | `8 columns` | Unlimited | Compact 40B `AggBucket`; unrolled key comparisons. |
| **Secondary Indexes** | Single-column only | Multi-column composite | Lean binary index traversal without composite keys. |
| **Virtual Registers** | `16 registers` | Unlimited (dynamic) | Static 256B inline allocation inside `VmContext`. |
| **Query Arena Ceiling** | `16 MB` (default, configurable) | Bound by host memory | Safe default for mobile tabs; configurable up to 2 GB. |
| **Concurrency Model** | Web Locks (Single Writer) | POSIX / Win32 file locks | Native browser multi-tab serialization. |
