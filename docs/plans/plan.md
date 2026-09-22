## This high-level implementation plan outlines how to build and orchestrate an ultra-lean relational database engine.
- **Target Footprint:** Relaxed to **~150 KB Wasm** (~40 KB gzipped) for production builds, providing ample room for full transactional reliability while staying featherweight.
- **Version 1 (V1):** Built entirely in JavaScript/TypeScript with **zero C/Wasm dependencies**, but implementing the engine core under **strict C-semantics** (direct `ArrayBuffer` byte-level pointer arithmetic and flat structs).
- **Version 2 (V2):** Drop-in replacement of the engine core with compiled C/WebAssembly, with **zero changes** required to the host JS orchestration layer (Query Builder, VFS, Schema, LRU, Transaction Coordinator).

---

## Phase 1: Storage & Memory Architecture (The Foundation)

This layer configures how data is laid out in memory and how files are structured on disk.

### 1. Global Shared Memory (`ArrayBuffer`)

- In **V1 (JS)**: The host allocates a single `ArrayBuffer` (or `WebAssembly.Memory` page pool directly, as `memory.buffer` is an `ArrayBuffer`).
- In **V2 (Wasm)**: The exact same `ArrayBuffer` is passed to the imported WebAssembly instance.
- **Configurable Shared Cache Array:** A flat slice of memory reserved as rigid 4KB page slots, sized dynamically when opening the database (`db.open({ cacheSize: '4MB' })`):
  - **Default:** **4 MB (1,024 slots $\times$ 4KB)**.
  - **Configurable Range:** **2 MB (512 slots)**, **4 MB (1,024 slots)**, or **8 MB (2,048 slots)**.
  - **Initial & Max Memory:** For a 4 MB cache, JS allocates an initial `WebAssembly.Memory` of **70 Wasm pages** (~4.4 MB), with a maximum ceiling of **320 Wasm pages** (~20 MB).
- **Dynamic Slot Mapping Table (`slot_to_page`):** A shared array of `slot_count` values (`uint32_t`) mapping each cache slot to its active database Page ID (e.g. 1,024 entries = 4 KB for a 4MB cache).
- **Buffer Pinning Invariant:** A cache slot referenced by any active cursor (`cursors[0..15].slot_idx` where `page_id != 0`) in the currently active `VmContext` is strictly **pinned (immune to LRU eviction)**. With 1,024 slots and at most 16 cursors, at least 1,008 unpinned slots are always guaranteed available for eviction.
- **Dynamic Dirty Bitmask (`dirty_mask`):** Sized to `slot_count / 8` bytes (e.g. 128 bytes for 1,024 slots). When the engine writes to slot `i`, it sets bit `i`. The JS LRU eviction engine and Transaction Manager check this bit to coordinate WAL flushing.
- **Execution Scratchpad, Query Arena & Result Window:** Dedicated memory regions reserved for bytecode payloads (32KB), the `VmContext` state struct (512B), a chunked output result buffer (64KB), a dedicated **Page Scratchpad** (4KB, for zero-heap page compaction and node splits), and a growable **Transient Query Arena**:
  - **Initial Allocation:** 256 KB.
  - **Hard Memory Ceiling:** Capped at **16 MB** default (256 Wasm pages; configurable via `db.open({ maxQueryMemory: ... })`). Memory grows dynamically via `memory.grow()` in 64KB increments only as needed.

### 2. Slotted Page Format & Constraints

- The database file is divided into rigid 4KB pages.
- **16-Byte Uniform Page Header:** All pages begin with a 16-byte header: `page_type` (1B), `reserved` (1B), `cell_count` (2B), `cell_content_offset` (2B, starts at 4096), `next_page_id` (4B), `free_bytes` (2B), and `checksum` (4B, CRC32 IEEE 802.3).
- **Page-Level CRC32 Integrity & Torn-Write Protection:**
  - On write/flush: Bytes `12..15` are zeroed, CRC32 is computed over the 4096 bytes and stored at `12..15`.
  - On read/page-fault: Stored CRC32 is compared against the computed checksum. Any torn write, truncation, or flipped bit immediately throws `CorruptPageError`.
- **Max Row Size Constraint (v1):** Strict maximum single row size of **2048 bytes (2KB)**. Rows do not span multiple pages in v1, keeping B-tree and slotted page code ultra-lean.
  - **Explicit Fail-Fast Error:** If any `INSERT` or `UPDATE` payload exceeds 2048 bytes, the engine **must throw an immediate explicit error** (`RowSizeLimitExceededError`). **Silent truncation of user data is strictly prohibited.**
- **Data Pages:** Rows grow from the bottom of the page upward. A "slot directory" grows from offset 16 downward, tracking the exact byte offset and length of each row.
- **Row Deletion & Slot Directory Shift (`memmove`):** Deleting a row shifts subsequent slot directory entries left by 2 bytes (`memmove`) and decrements `cell_count--`. Vacated payload bytes are tracked as `free_bytes`. Because WebDB uses physical 4KB page logging in WAL, this byte shift is internal to the page and zero-overhead to the log. Foreign keys and secondary indexes reference logical Primary Keys and remain 100% unaffected.
- **In-Place Compaction & Gap Defragmentation:** When an insert requires space and `contiguous_free < L + 2` but `total_free >= L + 2`, active records are compacted to the bottom of the page in-place, resetting `free_bytes = 0` without requiring page allocation.
- **Row Updates (3 Scenarios):** (1) Same-size/shrinking updates overwrite in-place. (2) Expanding updates that fit within the page's total free space abandon the old slot and reallocate after compaction. (3) Expanding updates exceeding page capacity trigger a B-Tree leaf split or row migration.
- **Index Pages:** Uniform B-Tree nodes containing sorted keys, row IDs, and child page references. Traversal is strictly iterative (using an explicit cursor stack, avoiding call-stack recursion).

### 3. Page 1: Database Header & Binary Master Table (Schema Catalog)

Instead of external JSON files or complex SQL DDL parsers, **Page 1 is a self-contained binary master page**:
* **Bytes 0..99 (File Header):** Magic bytes (`"WEBDB\0"`), page size (`4096`), file format version (`file_format_version`, bytes 8..9), minimum readable version (`min_read_version`, bytes 10..11), total allocated pages (`total_pages`, bytes 12..15), free page head pointer (`free_page_head`, bytes 16..19; points to first recycled free page, traversed via bytes 6..9 of each free page), logical schema version (`schema_version`, bytes 20..23), transaction change counter (`change_counter`, bytes 24..27), Page 1 CRC32 checksum (`page_checksum`, bytes 28..31), forward-compatible next catalog page pointer (`next_catalog_page_id`, bytes 32..35, default 0 in V1), and reserved padding (bytes 36..99).
* **Version Handshake Fail-Fast:** If `min_read_version > CURRENT_ENGINE_VERSION`, opening the database immediately throws `UnsupportedFormatVersionError`, preventing corruption from incompatible layout versions.
* **WAL-First Failover Protection:** Page 1 is managed uniformly as `page_id = 1` under the WAL write-ahead protocol. DDL mutations and counter updates are logged to the `.wal` file first. During checkpointing, the main `.db` file is flushed before the `.wal` is truncated. Any crash or torn write to Page 1 on disk is automatically healed on startup by replaying the intact Page 1 frame from the WAL.
* **Bytes 100..4095 (Binary Master Table):** A packed binary array defined and written by JavaScript, and directly readable by C via struct pointer casting. Supports up to 10 tables in V1, each with up to 16 columns ($10 \times 344\text{ B} = 3,440\text{ B}$):

```c
// Binary Master Table Layout (Stored directly on Page 1)
typedef struct {
    uint8_t  type;          // 1=INT32, 2=INT64, 3=FLOAT64, 4=TEXT, 5=BLOB
    uint8_t  flags;         // 0x1=PRIMARY KEY, 0x2=NOT NULL, 0x4=INDEXED
    uint16_t col_offset;    // Column offset inside fixed data slice
    char     name[16];      // Column name (null-padded UTF-8)
} ColumnMeta;               // 20 bytes

typedef struct {
    uint16_t table_id;      // Numeric table identifier
    uint16_t column_count;  // Number of active columns (up to 16)
    uint32_t root_page_id;  // Table B+Tree root Page ID
    char     name[16];      // Table name (null-padded UTF-8)
    ColumnMeta columns[16]; // Fixed array of columns (16 * 20B = 320B)
} TableMeta;                // Size: 24 + 320 = 344 bytes
```
* **JS Role:** On `CREATE TABLE`, JS encodes the struct fields into Page 1 via `DataView` and increments the schema version.
* **C Role:** Reads and resolves table IDs, root pages, and column types via instant $O(1)$ struct dereferencing (`const TableMeta *tbl = (const TableMeta*)(page1_ptr + offset)`). Zero string parsing code needed.
* **Result:** The `.db` file is **100% self-contained and portable**.

### 4. Binary Row Format (Dynamic Null-Bitmap & Column Layout)

Inside a slotted data page, each row is packed into a compact, self-describing binary record:

```
┌──────────────┬──────────────────────────┬─────────────────────────┬─────────────────────────┬──────────────────────────┐
│ Flags (1B)   │ Null-Bitmap (ceil(N/8)B) │ Fixed Columns (4B / 8B) │ Var-Offset Table (2B/ea)│ Var Payloads (UTF-8/Blob)│
└──────────────┴──────────────────────────┴─────────────────────────┴─────────────────────────┴──────────────────────────┘
```

* **Flags (1 byte):** Tracks row state (e.g. `0x01` = Active, `0x00` = Deleted).
* **Dynamic Null-Bitmap (`ceil(column_count / 8)` bytes):**
  - Sized dynamically based on the table's column count: `(col_count + 7) >> 3` bytes.
  - Supports any column count: 1 byte for 1–8 columns, 2 bytes for 9–16 columns (V1 maximum is 16 columns; dynamically extensible to N bytes in row format).
  - Bit $i$ is set to `1` if column $i$ is `NULL`. If set, the column value is skipped entirely, saving space.
* **Fixed-Width Column Slice:** Predictable offsets for numeric fields (`INT32` = 4B, `INT64` = 8B, `FLOAT64` = 8B).
* **Variable-Length Offset Table & Payloads:** For `TEXT` and `BLOB` columns, a 2-byte relative offset and length pointer indexes into the variable payload data stored at the tail of the row.
* **Strict Size Enforcement (Max 2048 Bytes):** The total serialized record size (flags + null-bitmap + fixed slice + var-offsets + payloads) cannot exceed 2048 bytes. Any attempt to write a row exceeding 2048 bytes immediately throws an explicit `RowSizeLimitExceededError`. Data is never silently truncated.

### 5. Supported Datatypes & SQLite-Compatible NULL Semantics

WebDB enforces strict binary typing for maximum storage and execution efficiency, combined with full compatibility with SQLite's **Three-Valued Logic (3VL)** and `NULL` semantics.

#### 1. Supported Core Datatypes & Binary Encodings:
| Datatype | Code (`type`) | Fixed Width | C Engine Representation | JS Runtime Representation | Nullability Support |
| :--- | :---: | :---: | :--- | :--- | :--- |
| **`INT32`** | `1` | 4 bytes | `int32_t` (little-endian) | `number` | Nullable (or `NOT NULL` via flag `0x02`) |
| **`INT64`** | `2` | 8 bytes | `int64_t` (little-endian) | `bigint` (or safe `number`) | Nullable (or `NOT NULL` via flag `0x02`) |
| **`FLOAT64`** | `3` | 8 bytes | `double` (IEEE 754) | `number` | Nullable (or `NOT NULL` via flag `0x02`) |
| **`TEXT`** | `4` | Variable | UTF-8 payload + 2B length | `string` | Nullable (or `NOT NULL` via flag `0x02`) |
| **`BLOB`** | `5` | Variable | Raw binary bytes + 2B length | `Uint8Array` | Nullable (or `NOT NULL` via flag `0x02`) |

* **Column Flags (`ColumnMeta.flags`):**
  - `0x01 = PRIMARY KEY` (Implicitly unique and `NOT NULL`).
  - `0x02 = NOT NULL` (Rejects `NULL` insertions; throws `NotNullConstraintError`).
  - `0x04 = INDEXED` (Has dedicated secondary B-Tree).
* **Storage Optimization for NULLs:**
  - If column $i$ is `NULL`, its bit in the dynamic row Null-Bitmap is set to `1`.
  - For `NULL` values, **zero payload bytes are stored**: fixed-width columns occupy 0 bytes, and variable-length offset entries are omitted, saving space.

#### 2. SQLite-Compatible Three-Valued Logic (3VL) & NULL Comparison Rules:
In SQL and WebDB, `NULL` represents missing or unknown information rather than zero, empty string, or false.
1. **Equality & Inequality Comparisons (`=`, `!=`, `<`, `<=`, `>`, `>=`):**
   - Any standard comparison against `NULL` evaluates to **`UNKNOWN`** (which evaluates to **falsy** in `WHERE` and `HAVING` filters).
   - `col = NULL` $\to$ evaluates to `UNKNOWN` (never matches any row).
   - `NULL = NULL` $\to$ evaluates to `UNKNOWN` (does **not** match in standard `=` joins or comparisons).
   - `col != NULL` $\to$ evaluates to `UNKNOWN`.
2. **Explicit Null Testing (`IS NULL` and `IS NOT NULL`):**
   - Because `=` cannot match `NULL`, queries must use explicit null checks:
     - `col IS NULL` $\to$ evaluates to `TRUE` if the row's null-bitmap bit is `1`, `FALSE` otherwise.
     - `col IS NOT NULL` $\to$ evaluates to `TRUE` if non-null, `FALSE` if null.
3. **SQLite `IS` vs `=` Distinctness Operator:**
   - In SQLite, the `IS` operator compares values with null-awareness (identical to SQL:1999 `IS NOT DISTINCT FROM`):
     - `a IS b` $\to$ evaluates to `TRUE` if both are identical values **or if both are `NULL`**.
     - `a IS NOT b` $\to$ evaluates to `FALSE` if both are `NULL` or identical.
4. **B-Tree Index Ordering & Sorting (`ORDER BY`):**
   - In B-Tree indexes and `ORDER BY` operations, WebDB implements SQLite's exact collation precedence where **`NULL` is smaller than any other value**:
     $$\text{NULL} < \text{Negative Infinity} < \text{Numbers (INT/FLOAT)} < \text{TEXT (UTF-8)} < \text{BLOB}$$
   - **`ORDER BY col ASC`:** Rows with `NULL` values appear first.
   - **`ORDER BY col DESC`:** Rows with `NULL` values appear last.
5. **Unique Constraints & Unique Indexes:**
   - Following ANSI SQL and SQLite: **Multiple `NULL` values do not violate a `UNIQUE` constraint or unique index**.
   - Multiple rows may have `col = NULL` simultaneously without triggering a uniqueness violation.
6. **Aggregate Functions (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`):**
   - `COUNT(*)` counts all matching rows, including rows where columns are `NULL`.
   - `COUNT(col)` counts only rows where `col` is not null (`NULL` rows are skipped).
   - `SUM(col)`, `AVG(col)`, `MIN(col)`, and `MAX(col)` ignore `NULL` values. If all rows in a group contain `NULL`, the aggregate result is `NULL`.
7. **Arithmetic & 3VL Boolean Logic:**
   - Any arithmetic operation on `NULL` yields `NULL` (`col + 5` $\to$ `NULL`).
   - Standard 3VL truth tables apply:
     - `TRUE AND UNKNOWN` $\to$ `UNKNOWN`; `FALSE AND UNKNOWN` $\to$ `FALSE`.
     - `TRUE OR UNKNOWN` $\to$ `TRUE`; `FALSE OR UNKNOWN` $\to$ `UNKNOWN`.
     - `NOT UNKNOWN` $\to$ `UNKNOWN`.

### 6. Page Allocation & Free List Management

WebDB recycles empty pages dynamically to prevent database file bloat using a LIFO freelist headed by `Page1.free_page_head` (bytes 16..19):

#### Free Page On-Disk Format (`page_type = 0x00`)
Every recycled free page maintains the uniform 16-byte header:
* `Byte 0`: `page_type = 0x00` (`PAGE_TYPE_FREE`).
* `Byte 1`: `reserved = 0x00`.
* `Bytes 2..5`: Zeroed (`cell_count = 0`, `cell_content_offset = 0`).
* **`Bytes 6..9` (`next_free_page_id`, `uint32_t` LE):** Pointer to next recycled free page (`0` = freelist tail).
* `Bytes 10..11`: Zeroed (`free_bytes = 0`).
* **`Bytes 12..15` (`checksum`, `uint32_t` LE):** CRC32 IEEE 802.3 checksum of the 4KB page (computed with bytes 12..15 zeroed).
* `Bytes 16..4095`: Discarded / zero-filled payload area (4,080 bytes).

```c
typedef struct {
    uint8_t  page_type;          // Offset 0: 0x00 (PAGE_TYPE_FREE)
    uint8_t  reserved1;          // Offset 1: 0x00
    uint16_t reserved2;          // Offset 2..3: 0x0000
    uint16_t reserved3;          // Offset 4..5: 0x0000
    uint32_t next_free_page_id;  // Offset 6..9: Next free page in LIFO chain (0 = tail)
    uint16_t reserved4;          // Offset 10..11: 0x0000
    uint32_t checksum;          // Offset 12..15: CRC32 checksum of 4KB page
    uint8_t  unused[4080];       // Offset 16..4095: Discarded payload
} FreePage;                      // Exact size: 4096 bytes
```

#### Lifecycle Protocols
1. **Empty Page De-allocation (LIFO Free List Push):** When all rows on a data page are deleted (`cell_count == 0`), the page unlinks from its sibling pointers. Its header is formatted as `page_type = 0x00`, its `next_free_page_id` pointer (bytes 6..9) is set to the current `Page1.free_page_head`, its 4KB CRC32 checksum is calculated at bytes 12..15, and `Page1.free_page_head` is updated to point to this page.
2. **Recycled Page Reuse (LIFO Free List Pop):** When an `INSERT` triggers a B-Tree page split or a new table is created, the engine checks `Page1.free_page_head`. If non-zero, it pops the head page, asserts `page_type == 0x00`, reads `next_free_page_id` from bytes 6..9, updates `Page1.free_page_head = popped_page.next_free_page_id`, and re-initializes the page without growing the database file.
3. **Page File Growth:** If the free list is empty (`free_page_head == 0`), the engine increments `total_pages` in the Page 1 header and allocates a new `page_id` at the end of the file.
4. **VFS Allocation:** The JS VFS writes the 4KB page at `fileOffset = page_id * 4096`. Storage engines (OPFS/IndexedDB) append the block without needing complex filesystem restructuring.

### 7. B+Tree Architecture: Table B+Tree vs. Secondary Index B-Tree

Following the battle-tested SQLite storage pattern, WebDB cleanly separates Table B+Trees from Secondary Index B-Trees across a 4-page taxonomy:

#### 1. Page Type Taxonomy
* **Table Leaf (`page_type = 0x0D`):** Stores actual row data: `[uint16_t row_len, int64_t rowid, binary_row_record]`. Header offset `6..9` holds `next_page_id` for $O(1)$ linear scans.
* **Table Interior (`page_type = 0x05`):** Routes traversal by 64-bit integer `rowid`. Each cell is a fixed 12-byte struct `TableInteriorCell`:
  - `uint32_t child_page_id` (4 bytes, offset 0): Pointer to child subtree where keys $\le \text{rowid}$.
  - `int64_t rowid` (8 bytes, offset 4): 64-bit routing separator key.
  - Header offset `6..9` holds `right_child_page_id` (pointer to subtree where keys $>$ all keys on page).
  - **Capacity & Fan-out:** $12\text{B cell} + 2\text{B slot} = 14\text{B per entry} \to \lfloor (4096 - 16) / 14 \rfloor = \mathbf{291 \text{ routing entries}}$ per 4KB page.
  - **Binary Search:** Searches slot directory in $O(\log K)$ ($K \le 291$, max 8 iterations); falls back to `right_child_page_id` if key exceeds maximum.
  - **Internal Node Split:** Splits at median entry 145, moving upper entries to a new 4KB page, and promotes the median `rowid` to the parent node.
* **Secondary Index Leaf (`page_type = 0x0A`):** Slotted page storing index entries: `[uint16_t key_len, uint8_t key_data[key_len], int64_t rowid]`. Slot directory is strictly ordered by SQLite 3VL collation (`NULL < -inf < numbers < text < blob`), with `rowid` as deterministic tie-breaker. Header offset `6..9` links sibling leaf pages for sequential range scans.
* **Secondary Index Interior (`page_type = 0x02`):** Routes traversal through secondary indexes: `[uint32_t child_page_id, uint16_t key_len, key_data, int64_t rowid]`. Header offset `6..9` holds `right_child_page_id`.

#### 2. Query Traversal
An index seek performs an $O(\log N)$ binary search across index pages to locate matching `rowid`s, followed by a direct $O(\log N)$ point seek on the Table B+Tree. Secondary indexes never point to physical `(page_id, slot_idx)` coordinates, ensuring slot shifting, compaction, and leaf splits never invalidate index structures.

### 8. Dual First-Class Storage Engines: OPFS & IndexedDB (Unified `IVfsAdapter`)

Storage in WebDB is built around a pluggable, unified **`IVfsAdapter`** where **IndexedDB is treated as a co-equal first-class storage engine, NOT a mere fallback**:

```typescript
export interface IVfsAdapter {
  readonly name: 'memory' | 'opfs' | 'idb';
  readonly isSynchronous: boolean;

  // --- Main Database Storage (.db file / 'pages' store) ---
  /** Reads a 4KB page from storage into a designated memory slot */
  readPage(pageId: number): Promise<Uint8Array | null>;

  /** Writes a 4KB page from a memory slot to persistent storage */
  writePage(pageId: number, data: Uint8Array): Promise<void>;

  /** Atomically commits a batch of dirty pages */
  writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void>;

  /** Flushes all in-flight main DB writes durably to persistent storage */
  flush(): Promise<void>;

  /** Truncates the main storage file/store to the specified page count */
  truncate(pageCount: number): Promise<void>;

  // --- Write-Ahead Log Storage (.wal file / 'wal_frames' store) ---
  /** Reads the 32-byte WAL file header */
  readWalHeader(): Promise<Uint8Array | null>;

  /** Writes or overwrites the 32-byte WAL file header */
  writeWalHeader(header: Uint8Array): Promise<void>;

  /** Reads a single 4,128-byte WAL frame by 0-based frame index */
  readWalFrame(frameIndex: number): Promise<Uint8Array | null>;

  /** Reads a batch of consecutive 4,128-byte WAL frames starting from frameIndex */
  readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]>;

  /** Appends one or more 4,128-byte WAL frames to the end of the log */
  appendWalFrames(frames: Uint8Array[]): Promise<void>;

  /** Flushes WAL writes durably to persistent storage */
  flushWal(): Promise<void>;

  /** Truncates the WAL to the specified frame count (0 resets the log) */
  truncateWal(frameIndex: number): Promise<void>;

  /** Returns the current number of frames in the WAL */
  getWalFrameCount(): Promise<number>;

  // --- Lifecycle ---
  /** Closes and cleans up storage handles */
  close(): Promise<void>;
}
```

#### Why IndexedDB is a First-Class Citizen (Co-Equal to OPFS):
1. **Universal Context Availability:**
   - Runs seamlessly on the **Main Thread**, **Dedicated Web Workers**, **SharedWorkers**, **ServiceWorkers**, and inside mobile WebViews (iOS `WKWebView`, Android WebView) where OPFS `createSyncAccessHandle` is unsupported or restricted.
   - Allows lightweight, zero-configuration usage without mandating Web Worker thread isolation for simple applications or serverless SSR runtimes.
2. **Zero Isolation / Header Requirements:**
   - Does not require Cross-Origin Isolation (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`) headers, making it embeddable in third-party iframes, widgets, and standard web hosting.
3. **Optimized Block-Level Key-Value Persistence:**
   - In the IndexedDB adapter, the database file is represented as an Object Store (`pages`) keyed by numeric `page_id` (4-byte unsigned integer), mapping to a 4KB `Uint8Array` value payload.
   - The WAL log is represented as a secondary Object Store (`wal`) keyed by monotonic `frame_id`.
   - **Batched Atomic Commits:** `writePages()` executes in a single `readwrite` IndexedDB transaction across all dirty slots in one event-loop tick, providing high write throughput.
4. **First-Class Storage Configuration:**
   - Developers explicitly configure their desired backend:
     ```typescript
     // Explicit first-class IndexedDB backend:
     const db = await WebDB.open({ storage: 'idb', name: 'app_data' });

     // Explicit bare-metal OPFS backend (requires Web Worker context):
     const db = await WebDB.open({ storage: 'opfs', name: 'app_data' });

     // Intelligent automatic capability detection (OPFS if available, else IDB):
     const db = await WebDB.open({ storage: 'auto', name: 'app_data' });
     ```

---

## Phase 2: Component Architecture & V1 Scope Boundary

### 1. Explicit V1 Query Scope
To ensure a rock-solid, focused initial release:
* **Connection & Config:** `WebDB.open({ storage: 'opfs'|'idb'|'auto', cacheSize?: '2MB'|'4MB'|'8MB', maxQueryMemory?: string })`
* **DDL:** `createTable(name, columns)`, `dropTable(name)`, `createIndex(table, column)`
* **DML:** `insert(table, row)`, `update(table, values).where(...)`, `delete(table).where(...)`
* **Queries:** `select(cols).from(table).where(col, op, val).whereNull(col).whereNotNull(col).limit(n).offset(n).orderBy(col, 'asc'|'desc')`
* **Joins:** Single-table queries + simple 2-table nested loop joins (advanced hash joins deferred to V1.1).
* **Transactions:** Full ACID `db.transaction(async (tx) => { ... })` with atomic rollback.
* **UDFs:** `db.registerFunction(name, fn)` for RegExp, Date formatting, and custom math.

### 2. Orchestration Boundary Matrix

All system orchestration, async I/O, and transaction lifecycles remain in **JavaScript**, while the **Engine Core** remains a pure, synchronous byte-manipulation step machine:

| Component Name                     | Role Layer     | Implementation (V1) | Implementation (V2) | Functional Responsibility                                                                                                                  |
| ---------------------------------- | -------------- | ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema Registry                    | Host (JS)      | TypeScript / JS     | TypeScript / JS     | Encodes and decodes the Binary Master Table on Page 1; maps table/column names to numeric IDs.                                             |
| Fluent Query Builder               | Host (JS)      | TypeScript / JS     | TypeScript / JS     | Converts user queries (`db.from('users').where(...)`) into optimized execution chains with numeric IDs.                                    |
| Async Query Queue                  | Host (JS)      | TypeScript / JS     | TypeScript / JS     | Serializes query execution through the single active `VmContext`, providing non-blocking `Promise` resolution to the application.          |
| Binary Compiler                    | Host (JS)      | TypeScript / JS     | TypeScript / JS     | Packs execution chains into compressed `Uint8Array` bytecode streams (e.g., `OP_INDEX_SEEK`, `OP_SCAN`).                                   |
| VFS Orchestrator                   | Host (JS)      | TypeScript / JS     | TypeScript / JS     | Handles all asynchronous block reads, writes, and `.flush()` transactions natively against OPFS or IndexedDB via the unified `IVfsAdapter`. |
| Cache Controller & Eviction Engine | Host (JS)      | TypeScript / JS     | TypeScript / JS     | Tracks which Page IDs reside in which slots using LRU/Clock; enforces the **Pinning Invariant** (skips active `cursor.slot_idx` slots); checks `dirty_mask` before evictions. |
| **Transaction Coordinator (ACID)** | **Host (JS)**  | **TypeScript / JS** | **TypeScript / JS** | Manages `BEGIN`, `COMMIT`, and `ROLLBACK`; coordinates WAL logging, shadow caching, and dirty page flushes.                               |
| Crash Recovery (WAL)               | Host (JS)      | TypeScript / JS     | TypeScript / JS     | Appends modified cache slots into `.wal` log before updating the main database file. Replays on boot.                                      |
| **VM Execution Loop**              | **Engine Core**| **Strict C-Style JS**| **C / Wasm**        | A lean, synchronous step-machine driven by `VmContext`. Loops through bytecode and executes relational operations.                        |
| **UDF Dispatcher**                 | **Engine / Host** | **Strict C-Style JS**| **C / Wasm $\to$ JS**| Invokes registered JS functions synchronously via `OP_CALL_UDF` for RegExp, Date, Intl, and custom math.                                  |
| **B-Tree Index Traverser**         | **Engine Core**| **Strict C-Style JS**| **C / Wasm**        | Traverses child nodes on index pages using raw pointer arithmetic and an iterative cursor stack to find row IDs in microseconds.           |
| **Join & Aggregate Router**        | **Engine Core**| **Strict C-Style JS**| **C / Wasm**        | Executes nested loop/index joins and populates a dynamically resizable open-addressing hash table (with $O(1)$ stream aggregation on indexed columns) backed by the query arena. |
| **Result Marshaller**              | **Engine Core**| **Strict C-Style JS**| **C / Wasm**        | Packs filtered fields into a chunked output buffer; yields `STATUS_BUFFER_FULL` if capacity is reached to allow streaming hydration.      |

---

## Phase 3: Execution Engine — Bytecode VM (VDBE) vs. Volcano Iterator

A critical architectural decision is using a **Bytecode Virtual Machine (similar to SQLite's VDBE)** rather than a traditional **Volcano Iterator Tree (used by PostgreSQL)**.

### Why Classic Volcano Fails in WebAssembly
In a standard Volcano iterator model, operators are organized in a tree (`Project -> Filter -> Join -> Scan`), where each node exposes `open()`, `next() -> Tuple*`, and `close()`:
```
       [Project.next()]
              │
        [Filter.next()]
              │
       [HashJoin.next()]
              │
       [TableScan.next()]  <-- Hits Page Fault (Disk miss)!
```
* **The Call-Stack Trap:** When `TableScan.next()` encounters a missing 4KB page, it must yield back to JavaScript to perform an asynchronous disk fetch from OPFS or IndexedDB.
* **Stack Unwinding:** Because the engine is 4–5 C functions deep on the call stack, returning to JS unwinds the entire C call stack. Without heavy runtime tools like Emscripten's `Asyncify` (which bloats binary size and degrades performance), all local variables, loop counters, and join states are permanently lost.

### Why the Bytecode VM Solves This (The SQLite Approach)
Instead of a tree of polymorphic objects calling each other recursively, the JS Binary Compiler converts the query into a **flat, linear array of numeric bytecode instructions**:

```asm
0: OP_OPEN_CURSOR  cursor_0, table_root_page (users)
1: OP_REWIND       cursor_0, eof_label
2: loop_start:
3: OP_NEXT_ROW     cursor_0, eof_label
4: OP_COLUMN_INT   cursor_0, col_age, reg_1
5: OP_LE           reg_1, 21, loop_start      # Filter: WHERE age > 21
6: OP_EMIT_ROW     cursor_0                   # Stream row into output buffer
7: OP_JUMP         loop_start
8: eof_label:
9: OP_HALT
```

### Key Architectural Benefits
1. **Flat, Non-Recursive Call Stack (1 Level Deep):**
   The execution engine in C/JS is simply a single flat `while` loop running a `switch(opcode)`. The call stack is never more than 1 function deep (`vm_step()`).
2. **Instant Pause & Resume (Zero Stack Saving):**
   All execution state lives in the flat `VmContext` struct (`pc`, `status`, `Cursor cursors[16]`, and `Register registers[16]`). When a page fault occurs, C simply sets `ctx->status = STATUS_PAGE_FAULT`, records the missing Page ID, and exits. When JS loads the 4KB page into a slot, it calls `vm_step()` again—resuming execution at `pc` with zero state loss.
3. **Dedicated 16-Register File (`Register registers[16]`):**
   A pre-allocated array of 16 tagged union structs (16 bytes each, 256 bytes total) lives inline inside `VmContext`. Numbers reside directly in CPU registers without heap allocations (`val.i32`, `val.i64`, `val.f64`), while TEXT/BLOB registers hold zero-copy slice pointers (`str_offset` and `len`) pointing directly into page slots or arena buffers. `NULL` is marked via `type = 0`, enabling instant 3VL short-circuit evaluation.
4. **It IS a Chunked Pull Iterator:**
   The Bytecode VM retains all pipelined advantages of Volcano: it does **not** materialize full datasets in memory. Instead, `OP_EMIT_ROW` streams rows into a fixed output buffer. When the buffer reaches capacity, the VM yields `STATUS_BUFFER_FULL`. JavaScript pulls and hydrates that batch, resets the buffer, and calls `vm_step()` to pull the next chunk.
5. **Minimal Binary Footprint:**
   Eliminates polymorphic class hierarchies, dynamic operator allocations, and virtual function dispatch tables (`vtable`), keeping the engine well under the target footprint.
6. **Dynamically Resizable Aggregations (Transient Query Arena):**
   Hash tables for `GROUP BY` start small (1,024 40-byte `AggBucket` entries) and automatically double capacity when reaching a 70% load factor, managed via `OP_AGG_INIT`, `OP_AGG_STEP`, `OP_AGG_NEXT`, and `OP_AGG_FINAL`.
   - **Supported Aggregate Functions:** `COUNT(*)`, `COUNT(col)`, `SUM(col)`, `AVG(col)`, `MIN(col)`, `MAX(col)`, plus `HAVING` post-aggregation filtering.
   - **Hard 8-Column Grouping Ceiling:** Grouping clauses accept at most 8 columns (`num_keys <= 8`); queries exceeding 8 columns throw `TooManyGroupByColumnsError` at compile time.
   - **Stream Aggregation Optimization:** If grouping by an indexed column (or after sorting), the engine emits an $O(1)$ constant memory stream aggregation loop without allocating a hash table.
   - **Fail-Fast OOM Handling:** If an unindexed `GROUP BY` with huge cardinality exceeds the configured arena ceiling (default 16 MB, configurable via `maxQueryMemory` up to 2 GB in Wasm32), the engine halts and yields `STATUS_ERR_ARENA_EXHAUSTED`. The JS Host resets `arena_offset = 0` and throws an explicit `QueryArenaExhaustedError`. **Silent truncation or incomplete aggregate tallies are strictly prohibited.**
   - When a query completes, resetting `arena_offset = 0` reclaims all transient memory in $O(1)$ time with zero fragmentation.
7. **Multi-Column In-Arena Sorter (`ORDER BY`):**
   Unindexed sort clauses accumulate row pointers and extracted sort keys as 16-byte `SorterEntry` records inside the Transient Query Arena via `OP_SORTER_OPEN`, `OP_SORTER_INSERT`, `OP_SORTER_SORT`, and `OP_SORTER_NEXT`. Sorts execute in-place Introsort with SQLite 3VL NULL handling (`NULLS FIRST` / `NULLS LAST`).
   - **Hard 8-Column Ceiling:** Multi-column sorting supports up to **8 columns maximum**; queries requesting $> 8$ sort keys throw `TooManyOrderByColumnsError` at compile time.
   - **Index Reverse Scan:** Queries sorting on an indexed column `DESC` emit `OP_LAST (0x08)` and `OP_PREV_ROW (0x09)`, walking the B+Tree leaves in reverse with $O(1)$ memory without allocating sorter buffers.
8. **DML Mutation Engine (`INSERT`, `UPDATE`, `DELETE`):**
   Executes mutations directly in the VDBE loop via dedicated opcodes: `OP_INSERT_ROW (0x52)`, `OP_UPDATE_FIELD (0x51)`, and `OP_DELETE_ROW (0x50)`.
   - **Slotted-Page Compaction & Recycling:** Deletions compact slot directories via `memmove` and reclaim empty pages back to `free_page_head`. Updates execute 3-scenario in-place, compaction, or page migration logic.
   - **Secondary Index Synchronization:** Mutations automatically maintain `(indexed_value, rowid)` cells in secondary B+Trees (`0x0A`).
   - **Result Reporting:** Tracks affected rows via `ctx->rows_affected` (embedded at byte offset 472 in `VmContext`), returning `{ rowsAffected }` upon `OP_HALT`.

---

## Phase 4: Transaction Lifecycle & ACID Rollback (JS Orchestrated)

Transaction boundaries (`BEGIN`, `COMMIT`, `ROLLBACK`) are managed by the JS Host to maintain clean error handling across async boundaries:

```typescript
await db.transaction(async (tx) => {
  await tx.insert('users', { id: 1, name: 'Alice' });
  await tx.insert('users', { id: 2, name: 'Bob' });
  // If an error throws here, JS automatically triggers ROLLBACK
});
```

### Exclusive Transaction Lease (Preventing Mid-Transaction Interleaving)
Because multi-statement async transactions yield control to the JS event loop between statements (`await tx.insert(...)`), the JS Async Queue enforces an **Exclusive Transaction Lease**:
* When `db.transaction()` begins, the transaction acquires an exclusive lock on the queue.
* While the transaction is active (`in_transaction = true`), the queue **strictly dispatches only operations belonging to this active `tx` handle**.
* All non-transaction queries, idle timers, and `checkpoint()` requests are blocked from interleaving and must wait in the FIFO queue until the active transaction executes `COMMIT` or `ROLLBACK`.

### Physical WAL Binary Format & Frame Layout
The `.wal` log file uses rigid 8-byte aligned structs:
* **File Header (32 Bytes, Offset `0..31`):** Magic bytes `"WEBWAL"`, WAL version (`1`), page size (`4096`), checkpoint sequence counter, 64-bit random salt, and CRC32 checksum.
* **Frame Header (32 Bytes) + 4096-Byte Payload (Total Stride: 4,128 Bytes):**
  - Offset for frame $i$: $\text{offset} = 32 + (i \times 4128)$.
  - **`WalFrameHeader` (32 Bytes):** Magic `0x57414C46 ("WALF")`, `frame_type` (`1=PAGE_DATA`, `2=TX_COMMIT`, `3=TX_UNCOMMITTED`), `flags`, `tx_id`, `page_id`, `db_size_pages`, `frame_seq`, and `checksum` (CRC32 IEEE 802.3 over 24-byte header prefix + entire 4096-byte page payload).
* **Truncated Tail Scanner:** During startup crash recovery, any trailing bytes $< 4128$ or failing the CRC32 check are identified as an interrupted write from a prior crash; scanning halts cleanly and discards the torn tail.

### How Rollback & Commit Work in Shared Memory:

1. **`BEGIN`:**
   - JS acquires the Exclusive Transaction Lease, snapshots the current `dirty_mask`, and records the initial WAL file length.
2. **Mutations during Transaction:**
   - The engine modifies 4KB slots in memory and sets the corresponding bits in `dirty_mask`.
   - If an uncommitted dirty slot must be evicted due to cache pressure, JS writes the dirty slot to the `.wal` file (marked with `frame_type = FRAME_TX_UNCOMMITTED`).
3. **`COMMIT`:**
   - JS appends all remaining modified slots (`dirty_mask` bits) to the `.wal` file as `FRAME_PAGE_DATA` frames.
   - JS writes a synchronous `FRAME_TX_COMMIT` record to the WAL and calls `syncHandle.flush()`.
   - The transaction is now durably committed. JS releases the Exclusive Transaction Lease.
4. **`ROLLBACK` (On Error or User Abort):**
   - JS discards all in-memory changes by invalidating the dirty slots (clearing their bits in `dirty_mask` and resetting `slot_to_page`).
   - If uncommitted pages were spilled to the WAL, JS truncates the WAL back to the snapshot offset.
   - JS releases the Exclusive Transaction Lease.
   - **Result:** Complete atomic isolation. Zero corrupted or partial data ever touches the main database.

### 5. Checkpoint Specification (Bounded WAL & Persistence)

Without checkpointing, the `.wal` log file would grow indefinitely. The JS Host coordinates a bounded checkpoint lifecycle to ensure the WAL stays compact and the main `.db` file remains up-to-date:

#### Strict Checkpoint Precondition (All Triggers):
> **Invariant:** A checkpoint **CANNOT** run while a transaction is in-flight (`in_transaction === true`). Because checkpointing only runs when no transaction is active, all resident dirty slots in `wasmMemory` (`dirty_mask`) are **guaranteed to be committed**. Uncommitted dirty data can never leak into the main `.db` file.

#### Trigger Conditions:
* **Automatic Size Threshold (Passive):** Triggered strictly at the end of a `COMMIT` (after the transaction lease is released) whenever the `.wal` file exceeds **256 pages (1 MB)** or **100 write transactions**.
* **Idle Trigger:** Fired after 5 seconds of write inactivity. The timer is paused/inhibited whenever a transaction is open.
* **Database Close (`db.close()`):** Awaits in-flight transactions to complete (or triggers rollback) before executing the final shutdown checkpoint.
* **Explicit Manual Call (`await db.checkpoint()`):** Enqueues as a task in the JS Async Queue. Because the active transaction holds an exclusive lease, the checkpoint task waits in the queue until the transaction commits or rolls back before running.

#### Checkpoint Execution Algorithm (Deduplicated, Monotonic Apply):
To prevent older WAL frames from overwriting newer in-memory pages (or stale frames overwriting newer frames of the same page):

1. **Build Checkpoint Target Map (`page_to_latest_source`):**
   - JS scans all committed WAL frames in chronological order and records the latest WAL offset for each unique `page_id`: `wal_index.set(page_id, frame_offset)`.
   - For any currently resident dirty slot in `wasmMemory` (`dirty_mask`), the in-memory buffer is guaranteed to be $\ge$ the WAL version (and guaranteed committed per the invariant): JS marks these pages in `memory_override.set(page_id, slot_idx)`.
2. **Apply Deduplicated Pages to Main `.db` File:**
   - Iterate over the union of all unique `page_id`s in `wal_index` and `memory_override`:
     - **If present in `memory_override`:** Write the 4KB block directly from the memory slot to `fileOffset = page_id * 4096`, and clear its bit in `dirty_mask`.
     - **Else:** Read the 4KB block from the recorded `wal_index` frame offset and write it to `fileOffset = page_id * 4096`.
   - *Guarantee:* Every page is written to the `.db` file exactly **once** with its newest committed bytes. Stale WAL frames and uncommitted spills are never written to disk.
3. **Flush Main DB File:** Calls `dbSyncHandle.flush()` to guarantee all written pages are durably persisted to disk.
4. **Truncate WAL File:** Calls `walSyncHandle.truncate(0)` and resets the WAL sequence counter to 0. The WAL resets to 0 bytes.

### 6. Master Page (Page 1) Crash Resilience & Failover Analysis

WebDB eliminates the need for separate dual master pages or shadow copies by treating Page 1 **uniformly as a regular 4KB page (`page_id = 1`) under the WAL write-ahead protocol**:
* **Write Isolation:** DDL operations (`CREATE TABLE`, `DROP TABLE`) and page count adjustments mutate Page 1 in memory and append to `.wal` first. The master page in `.db` is never modified during active transactions.
* **Two-Phase Flush Invariant:** Checkpoint writes all committed pages (including Page 1) to `.db`, then flushes via `dbSyncHandle.flush()`. The `.wal` file is truncated **only after** `dbSyncHandle.flush()` successfully returns.
* **Startup Replay Priority:** On database startup, `WebDB.open()` scans and replays the `.wal` before reading Page 1 from `.db`, automatically healing any torn writes.

#### Failure Analysis Matrix: Crash at Any Point

| Crash Point | State of `.db` | State of `.wal` | Recovery on Startup |
| :--- | :--- | :--- | :--- |
| **Mid-transaction (before commit)** | Untouched (valid previous state) | Incomplete frame (no `TX_COMMIT` marker) | Recovery scanner detects missing `TX_COMMIT`; discards incomplete frames. Page 1 and data pages in `.db` remain 100% clean and valid. |
| **After commit, before checkpoint** | Older committed state | Contains committed frames (with Page 1 and `TX_COMMIT`) | Recovery replays committed WAL frames into `.db`, calls `dbSyncHandle.flush()`, and truncates the WAL cleanly. |
| **Mid-checkpoint (torn write to Page 1 or data in `.db`)** | **Torn / Corrupted** (detected by CRC32 mismatch) | **Intact committed frames** (WAL not yet truncated) | Recovery runs *before* trusting `.db`. CRC32 verifies intact WAL frames and replays Page 1 and data pages cleanly into `.db`, healing the torn page. |
| **After checkpoint `flush()`, during WAL truncate** | **Valid & Durably Synced** | Partially truncated or empty | Since `flush()` already succeeded, `.db` contains the latest valid data. Startup cleanly resets any trailing WAL bytes and opens immediately. |
| **After full checkpoint completion** | Valid & Durably Synced | Truncated (0 bytes) | Fast-path startup: WAL is clean, DB opens directly from `.db`. |

---

## Phase 5: JavaScript UDF Support (Synchronous Function Extensibility)

To take full advantage of the browser's rich native APIs (V8-optimized RegExp, `Intl` dates/collations, `Math`, string transformations) without bloating the C binary with heavy third-party C libraries (like PCRE or ICU), the engine supports **synchronous JavaScript User-Defined Functions (UDFs)**.

### 1. Host UDF Registration
Functions are registered on the host database instance:
```typescript
// Regex evaluation using V8 native engine:
db.registerFunction('regexp', (pattern: string, val: string): boolean => {
  return new RegExp(pattern).test(val);
});

// Intl date formatting:
db.registerFunction('format_date', (epochMs: number, locale: string): string => {
  return new Intl.DateTimeFormat(locale).format(new Date(epochMs));
});
```

### 2. The Bytecode Instruction (`OP_CALL_UDF`)
When a query contains a UDF filter or projection, the JS compiler emits:
```asm
OP_CALL_UDF  udf_id: 1, arg_reg: 2, out_reg: 3
```
* **Query-Level Compilation:** Literal `RegExp` instances are compiled **once** at query compile time, avoiding re-compilation per row.
* **Synchronous Execution:** Because native JS UDFs are synchronous, they execute inline within the VM loop without triggering an interrupt or page-fault yield.

### 3. V1 (JS Engine) vs. V2 (Wasm FFI) Invocation
* **In V1 (JS):** The engine indexes into `udfRegistry[udf_id]`, reads the argument bytes from `ArrayBuffer`, runs the function, and writes the scalar/boolean result back to the register.
* **In V2 (Wasm):** WebAssembly imports the dispatcher synchronously via `importObject.env.js_call_udf(...)`:
  ```c
  extern int32_t js_call_udf(uint16_t udf_id, uint32_t arg_offset, uint32_t arg_len);
  ```
  Calling an imported JS function from Wasm takes only ~10–15 ns, ensuring scans over 10,000 rows complete in ~1–2 ms.

---

## Phase 6: The Strict C-Style Rules for the JS Engine (V1)

When coding the **Engine Core** in JS/TS for V1, we follow these strict rules to ensure a 1:1 future port to C:

1. **Zero Dynamic JS Objects:**
   - No `new Map()`, `new Set()`, `class`, or object literals (`{ id: 1 }`) inside the engine execution loops.
   - All internal tables, cursors, and state live exclusively inside the pre-allocated `ArrayBuffer`.
2. **Numeric FFI Function Signatures:**
   - Engine entry points accept and return **only primitive numbers** (pointers, offsets, status codes), identical to WebAssembly exports:
     ```typescript
     function vm_step(ctxOffset: number): number;
     function vm_init(cacheBaseOffset: number, slotCount: number, scratchBaseOffset: number): void;
     ```
3. **Manual Byte Layouts & Static Offsets:**
   - Struct access is performed via explicit byte offsets using `DataView` or typed arrays (little-endian):
     ```typescript
     // V1 (JavaScript with C semantics):
     function page_get_cell_offset(view: DataView, pageOffset: number, cellIdx: number): number {
       return view.getUint16(pageOffset + 4 + (cellIdx * 2), true);
     }
     ```
4. **Iterative Only (No Call-Stack Recursion):**
   - B-Tree traversal and multi-table joins use an explicit, flat `Cursor` array inside `VmContext`.

---

## Phase 7: The Query Execution Cycle (The Lifecycle Loop)

Execution runs as an explicit, interruptible **State Machine**:

```
[JS Host Builder] -> Compiles Query to Bytecode -> Initializes VmContext -> Calls vm_step()
│
├──> [Engine Yields: STATUS_PAGE_FAULT (missing Page ID)]
│     │
│     ├──> JS Host reads active cursors[0..15].slot_idx in VmContext to pin live slots
│     ├──> JS Host selects LRU eviction candidate among unpinned slots
│     ├──> If selected eviction slot is dirty in dirty_mask, flushes slot to WAL
│     ├──> JS Host async fetches missing 4KB page from OPFS/IndexedDB
│     ├──> JS Host writes 4KB into designated slot & updates slot_to_page[slot]
│     └──> JS Host re-invokes vm_step() (Engine resumes without state loss via VmContext)
│
├──> [Engine Yields: STATUS_BUFFER_FULL (Output buffer full)]
│     │
│     ├──> JS Host reads and hydrates current chunk of rows into JS objects
│     ├──> JS Host resets output buffer offset
│     └──> JS Host re-invokes vm_step() to continue producing remaining rows
│
├──> [Engine Yields: STATUS_ERR_ARENA_EXHAUSTED (OOM ceiling reached)]
│     │
│     ├──> JS Host resets arena_offset = 0 to reclaim memory
│     └──> Rejects query Promise with QueryArenaExhaustedError
│
└──> [Engine Yields: STATUS_DONE]
      │
      └──> JS Host hydrates final batch of rows -> Resolves query promise to user
```

### Resumability Contract (`VmContext`)

All execution state is stored at a fixed byte offset in shared memory:

```c
typedef struct {
    uint32_t page_id;
    uint16_t slot_idx;
    uint16_t cell_offset;
    uint8_t  depth;
} Cursor;

typedef struct {
    uint32_t pc;               // Current bytecode instruction pointer
    uint32_t status;           // STATUS_DONE, STATUS_PAGE_FAULT, STATUS_BUFFER_FULL
    uint32_t fault_page_id;    // Missing page needed by engine
    uint32_t result_count;     // Rows packed in current chunk
    uint32_t result_offset;    // Byte offset in result buffer
    Cursor   cursors[16];      // Up to 16 cursors for multi-table joins, secondary indexes, and subqueries
} VmContext;
```

### Concurrency Model: Serialized Execution via JS Async Queue

To maintain deterministic memory isolation and eliminate concurrency bugs, **query execution is strictly serialized through a single active `VmContext` using a JavaScript async FIFO queue**:

```
[App: query A] ──┐
[App: query B] ──┼──► [JS Async FIFO Queue] ──(Dispatches 1-by-1)──► [Single VmContext]
[App: query C] ──┘
```

1. **Seamless Promise Concurrency for Applications:**
   - Application code can fire concurrent queries freely (e.g., `await Promise.all([q1, q2, q3])`).
   - The JS Host queues pending queries and processes them sequentially on the event loop. Because queries complete in 0.2 ms to 2 ms, throughput exceeds thousands of queries/sec with imperceptible latency.
2. **Deterministic Memory Isolation:**
   - The **Transient Query Arena** and **Output Result Buffer** belong exclusively to the running query.
   - When a query finishes, resetting `arena_offset = 0` and `result_offset = 0` cleans memory instantly in $O(1)$ time for the next queued query.
3. **Guaranteed Pinning Safety:**
   - Only the active query’s cursors (at most 16) pin slots in the cache. There is zero risk of competing queries exhausting all 64 slots or deadlocking the cache.
4. **Zero-Lock Transaction Isolation:**
   - Transactions execute without inter-query race conditions or dirty-page overwrites.

### Multi-Tab & Multi-Worker Coordination Architecture (SharedWorker & Web Locks Leader Election)

A fundamental challenge in browser-based databases is coordinating multiple open tabs or Web Workers accessing the same database:

#### The Dual Multi-Tab Challenge:
1. **OPFS Exclusivity Invariant:** Calling `createSyncAccessHandle()` locks the underlying file exclusively to a single Web Worker. If Tab A and Tab B both attempt to open the same OPFS file, the browser immediately throws `NoModificationAllowedError`.
2. **Cache Incoherence & Split-Brain Memory:** Each browser tab and worker has an entirely separate JavaScript heap and `WebAssembly.Memory`. If two tabs were to open the same database independently (even under IndexedDB), Tab A's in-memory 4MB page cache would have zero visibility into Tab B's uncommitted or newly committed pages, causing catastrophic data corruption.

#### The Architecture: Single Active Engine Server + Thin Client Proxy
To guarantee absolute memory coherence and respect storage lock invariants, **exactly one active instance of the WebDB engine (holding the 4MB page cache, `WebAssembly.Memory`, and storage handles) runs per database origin**:

```
[Browser Tab 1] ──(WebDBClient Proxy)──┐
                                       ├──► [RPC / MessagePort] ──► [Single Active WebDBServer]
[Browser Tab 2] ──(WebDBClient Proxy)──┤                             ├── 4MB Shared Page Cache
                                       │                             ├── Single JS Async FIFO Queue
[Dedicated Web Worker] ────────────────┘                             └── Exclusive IVfsAdapter (OPFS / IDB)
```

WebDB coordinates this transparently using a **Two-Tier Architecture**:

```
                              ┌─────────────────────────────────────────┐
                              │           WebDB.open(options)           │
                              └────────────────────┬────────────────────┘
                                                   │
                                    Does runtime support SharedWorker?
                                                   │
                              ┌────────────────────┴────────────────────┐
                             YES                                       NO
                              │                                         │
                 ┌────────────▼────────────┐              ┌─────────────▼────────────┐
                 │   Tier 1: SharedWorker  │              │    Tier 2: Web Locks     │
                 │       Coordinator       │              │     Leader Election      │
                 └─────────────────────────┘              └──────────────────────────┘
```

#### Tier 1 (Preferred / Evergreen Browsers): `SharedWorker` Coordinator
* In desktop Chrome, Firefox, Safari (macOS 16+), and Edge, `WebDB.open()` connects to a background `SharedWorker`:
  ```typescript
  const worker = new SharedWorker(new URL('./webdb-worker.js', import.meta.url), { name: `webdb_${dbName}` });
  const client = new WebDBClient(worker.port);
  ```
* **Unified State:** The `SharedWorker` hosts the sole `WebAssembly.Memory` pool, 4MB page cache, async FIFO queue, and OPFS `FileSystemSyncAccessHandle` (or IDB connection).
* **Zero Contention:** All open tabs share the worker. Query bytecode streams and hydrated row batches are exchanged over `MessagePort` with zero lock contention.
* **Automatic Lifecycle:** The worker stays alive as long as at least one tab or worker is connected to it, and is cleanly reaped by the browser when the last tab closes.

#### Tier 2 (Universal Tab Coordination): `navigator.locks` Leader Election
For environments where `SharedWorker` is unsupported or restricted (e.g. Safari on iOS, Android Chrome, third-party iframes, or non-worker main threads), WebDB uses **Web Locks API Leader Election**:

1. **Leader Lock Acquisition:**
   When `WebDB.open({ name: 'app_db' })` is invoked in any tab, the client requests an exclusive Web Lock:
   ```typescript
   navigator.locks.request(`webdb_leader_${dbName}`, async (lock) => {
     // This tab is elected LEADER!
     const server = new WebDBServer(dbName, options);
     await server.start(); // Opens OPFS / IDB, mounts 4MB cache & VM
     await server.listenOnBroadcastChannel(`webdb_rpc_${dbName}`);
     await server.keepAlive(); // Holds lock until tab closes or unloads
   });
   ```
2. **Follower Tabs (Client RPC):**
   - If another tab already holds the leader lock, follower tabs connect to the active Leader via `BroadcastChannel` (`webdb_rpc_${dbName}`) or an ephemeral `MessageChannel`.
   - Follower tabs expose the identical `db.from(...).where(...)` Fluent API, serializing query definitions to the Leader and awaiting results.
3. **Instant, Zero-Downtime Failover (< 5ms):**
   - If the user closes, refreshes, or crashes the Leader tab, the browser runtime automatically releases the exclusive Web Lock in under 5 milliseconds.
   - The next queued follower tab in `navigator.locks.request` is instantly promoted to **Leader**.
   - The new Leader tab initializes the engine, verifies/replays the `.wal` log to ensure crash consistency, binds the RPC channel, and resumes servicing queued queries with zero lost data or unhandled exceptions.

#### Cross-Tab Transaction Guarantees:
* When a tab executes `await db.transaction(async (tx) => { ... })`, the transaction request is processed by the Leader / SharedWorker's Async FIFO Queue.
* The coordinator assigns the **Exclusive Transaction Lease** to that transaction channel.
* All queries from other tabs wait non-blocking in the FIFO queue until the transaction issues `COMMIT` or `ROLLBACK`.
* This delivers **Global ACID Serializability** across all browser tabs and workers simultaneously.

---

## Phase 8: Future V2 Drop-In Swap & Build Pipeline

When ready to upgrade to V2:

1. **The Host Adapter Swap:**
   ```typescript
   // V1: Direct import of C-style JS module
   import { vm_step } from './engine/js_engine.js';

   // V2: Swap to WebAssembly instance exports (0 changes to host orchestration)
   const wasm = await WebAssembly.instantiateStreaming(fetch('db.wasm'), importObject);
   const { vm_step } = wasm.instance.exports;
   ```

2. **C Compilation Flags (Target: ~150 KB max, ~40 KB gzipped):**
   ```bash
   clang --target=wasm32 -O3 -flto -nostdlib \
     -Wl,--no-entry \
     -Wl,--export-all \
     -Wl,--import-memory \
     -Wl,--strip-all \
     -Wl,--lto-O3 \
     -o build/db.wasm src/engine/engine.c
   ```

---

## Phase 9: Quality Assurance, Verification & Testing Architecture

To guarantee bulletproof database reliability across both the V1 (JS Reference Engine) and V2 (C/Wasm Engine), the testing strategy uses **Differential Testing**, **Native C Sanitizer Testing**, and **Real-Browser E2E Testing**.

### 1. The Core Philosophy: Differential Testing (V1 JS $\leftrightarrow$ V2 C/Wasm)
Because both V1 and V2 adhere to the exact same shared-memory contract and binary layout:
* Every test case runs against **both** the V1 JavaScript engine and the compiled V2 WebAssembly engine.
* The test runner asserts that:
  1. Serialized 4KB slotted pages are bit-for-bit identical.
  2. B-Tree node split boundaries and root pages match.
  3. Output result buffers and row counts match exactly.
  4. Yield statuses (`STATUS_PAGE_FAULT`, `STATUS_BUFFER_FULL`, `STATUS_DONE`) trigger at the identical instruction points.

---

### 2. C Engine Unit Testing: Framework & Tooling

* **Framework:** **Unity** ([ThrowTheSwitch/Unity](https://github.com/ThrowTheSwitch/Unity)), the industry standard zero-dependency, single-header unit testing framework for embedded/freestanding C.
* **Native Execution with Sanitizers:** C test suites compile and run natively on the host (macOS/Linux) using Clang with **AddressSanitizer (ASan)** and **UndefinedBehaviorSanitizer (UBSan)**:
  ```bash
  clang -fsanitize=address,undefined -g tests/c/test_btree.c src/engine/engine.c \
    -Isrc/engine -o build/c_test_runner && ./build/c_test_runner
  ```
  *(ASan and UBSan catch buffer overruns, unaligned memory access, and integer overflows instantly during test execution).*

---

### 3. Exhaustive C Engine Edge Cases Checklist

#### A. Slotted Page & Row Format
* [ ] **Exact 2048-Byte Boundary:** Inserting a row of exactly 2048 bytes succeeds; inserting 2049 bytes immediately throws `RowSizeLimitExceededError`.
* [ ] **Zero-Byte Page Saturation:** Inserting rows until free space between slot directory and row data reaches exactly 0 bytes remaining.
* [ ] **Slot Defragmentation / Compaction:** Deleting alternating rows to fragment page space; inserting a new row that fits only after compacting the page.
* [ ] **Dynamic Null-Bitmap Scaling:** Verify bitwise null-checking for tables with 1, 8, 9, and 16 columns (rejecting > 16 with `TooManyColumnsError`) without offset drift.
* [ ] **Corrupted Slot Directory:** Rejecting corrupt slot offsets pointing outside page boundaries.

#### B. B+Tree Structure & Splitting
* [ ] **Sequential Ascending Insertions:** Insert keys `1..1000` (stresses right-leaning B-tree splits).
* [ ] **Sequential Descending Insertions:** Insert keys `1000..1` (stresses left-leaning B-tree splits).
* [ ] **Random/Hashed Keys:** Insert 5,000 pseudo-random keys (stresses balanced median page splits).
* [ ] **Root Page Splitting:** Verify root page split increments B-tree height (level 1 to 2, 2 to 3) and updates `TableMeta.root_page_id`.
* [ ] **Key Deletion & Underflow:** Deleting keys causing page underflow; verify sibling key borrowing and page merging.
* [ ] **Deep Cursor Traversal:** Iterative cursor descending 4 levels and traversing forward and backward across leaf sibling pointers.

#### C. State Machine & Resumability (Page Faults & Chunking)
* [ ] **Interrupted Index Seek:** Trigger `STATUS_PAGE_FAULT` midway through traversing child pages; save `VmContext`; inject page into slot; verify `vm_step()` resumes at exact position without restarting the seek.
* [ ] **Interrupted Nested Loop Join:** Trigger `STATUS_PAGE_FAULT` during inner table scan; verify outer loop cursor maintains row position upon resume.
* [ ] **Result Buffer Chunking:** Emit 5,000 rows through a 64KB buffer; verify `STATUS_BUFFER_FULL` yields cleanly, JS drains chunk, resets buffer offset, and resume produces remaining rows with zero duplicates.

#### D. Transient Query Arena & Growable Hash Table
* [ ] **Dynamic Hash Table Doubling:** Insert unique group keys past the 70% load factor threshold; verify table cleanly doubles capacity and re-hashes without corrupting existing entries.
* [ ] **Arena OOM Ceiling (Fail-Fast):** Pathological `GROUP BY` exceeding the 16 MB arena ceiling cleanly halts and yields `STATUS_ERR_ARENA_EXHAUSTED` (zero silent truncation).
* [ ] **Zero-Leak Arena Reset:** Assert `arena_offset = 0` reclaims 100% of transient allocations under ASan.

#### E. Datatypes & SQLite-Compatible NULL Semantics
* [ ] **Standard Comparisons Yield Unknown:** Verify `SELECT WHERE col = NULL` and `WHERE col != NULL` match 0 rows under 3VL logic.
* [ ] **`NULL = NULL` Inequality in Filters & Joins:** Assert joining or filtering on `a.col = b.col` skips rows where both values are `NULL`.
* [ ] **`IS NULL` and `IS NOT NULL` Selectivity:** Verify `OP_IS_NULL` and `OP_IS_NOT_NULL` accurately filter nullable rows based on the Page Null-Bitmap.
* [ ] **SQLite `IS` Distinctness Match:** Assert `a IS b` evaluates to true when both values are `NULL`, and false when only one is `NULL`.
* [ ] **B-Tree NULL Ordering Precedence:** Verify index traversal and `ORDER BY col ASC` returns `NULL` keys before all numeric, text, and blob values (`ORDER BY col DESC` returns `NULL`s last).
* [ ] **Multiple NULLs in UNIQUE Indexes:** Insert multiple records with `NULL` in a unique column; assert all succeed without uniqueness violations.
* [ ] **`NOT NULL` Constraint Violation:** Attempt to insert `NULL` into a column flagged with `0x02` (`NOT NULL`); assert immediate fail-fast `NotNullConstraintError`.
* [ ] **Aggregate NULL Elimination:** Verify `COUNT(*)` counts all rows while `COUNT(col)` excludes nulls; verify `SUM(col)` on an all-null group returns `NULL`.
* [ ] **Zero-Payload NULL Storage Verification:** Inspect raw page byte slices to confirm null columns occupy zero bytes in the data section.

---

### 4. JavaScript Host & Integration Testing (`Vitest`)

* **Framework:** **Vitest** for blazing-fast TypeScript unit and integration testing.
* **Coverage Targets:**
  * **Fluent Builder $\to$ Bytecode Compiler:** Compiling `.where()`, `.limit()`, and `.orderBy()` into exact opcode bytes and registers.
  * **Binary Master Table:** Verify JS encodes and decodes `TableMeta` and `ColumnMeta` structs onto Page 1 via `DataView`.
  * **Unified `IVfsAdapter` Contract Suite:** Identical verification test harness executed against both the OPFS adapter and the IndexedDB adapter (using `fake-indexeddb`): page reads, block writes, batched atomic commits, and truncation.
  * **Cache Controller & Pinning Invariant:** Fill all 1,024 slots; pin 16 slots with active cursors; trigger 500 page evictions; assert **none of the 16 pinned slots are ever evicted**.
  * **Deduplicated Checkpoint Verification:** Verify that resident in-memory dirty slots always supersede older WAL frames during checkpointing.
  * **Synchronous UDFs:** Test native RegExp, `Intl.DateTimeFormat`, and custom JavaScript math functions.

---

### 5. End-to-End (E2E) Browser Testing (`Playwright`)

* **Framework:** **Playwright** running automated tests across real browser engines (**Chromium**, **Firefox**, and **WebKit / Safari**).
* **Critical E2E Test Suites:**
  1. **OPFS Worker Persistence Test:**
     - Initialize database in a dedicated Web Worker using `FileSystemSyncAccessHandle`.
     - Insert 10,000 rows, commit transaction, and close database.
     - Terminate worker; spawn a brand-new worker; reopen database; assert all 10,000 rows and B-tree indexes are intact.
  2. **IndexedDB First-Class Engine Test Suite:**
     - Run database directly in main-thread, Web Worker, and mobile WebView environments using the IndexedDB adapter (`storage: 'idb'`).
     - Verify full transactional parity: 10,000-row inserts, multi-statement transaction rollback, batched atomic page writes, and WAL compaction directly against IndexedDB Object Stores.
  3. **Multi-Tab Coordination & Leader Failover E2E Suite:**
     - Launch 3 concurrent browser tabs (`tab1`, `tab2`, `tab3`) connecting to the same database simultaneously.
     - Verify both Tier 1 (`SharedWorker`) and Tier 2 (`navigator.locks` Leader Election) modes coordinate cleanly without throwing `NoModificationAllowedError`.
     - Fire interleaved concurrent writes and transactions from all 3 tabs; assert zero split-brain corruption and 100% cache coherence.
     - **Chaos Failover:** Abruptly close the Leader tab (`await tab1.close()`) mid-write; assert `tab2` is elected Leader within 5 ms, replays WAL consistency, and completes `tab3`'s pending queries seamlessly.
  4. **High-Throughput Concurrency Stress Test:**
     - Dispatch `Promise.all([ ...500 concurrent read/write queries... ])`.
     - Verify the JS Async FIFO Queue serializes execution without deadlocks, cache exhaustion, or memory corruption.
  5. **Dirty Termination & WAL Crash Recovery Test:**
     - Begin transaction, modify pages, and intentionally terminate the Web Worker / refresh the tab before `COMMIT`.
     - Reopen database; verify WAL rollback cleanly discards uncommitted frames and leaves the main `.db` file 100% consistent.
