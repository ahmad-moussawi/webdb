# Phase 3 Technical Specification: Bytecode Virtual Machine (VDBE) Engine

## 1. Executive Summary & Why VDBE Over Volcano

Traditional relational databases (PostgreSQL, MySQL) execute queries using a **Volcano Iterator Model** (`Project -> Filter -> Join -> Scan`), where operators form an object tree calling `next() -> Tuple*` recursively.

In WebAssembly and browser runtimes, the Volcano model fails catastrophically when hitting an asynchronous disk miss:
- An engine nested 4–5 C functions deep cannot pause and await an asynchronous OPFS or IndexedDB block read without unwinding the entire C call stack.
- Runtime solutions like Emscripten's `Asyncify` inject heavy instrumentation, inflating binary size by 40–80 KB and degrading CPU performance by up to 50%.

### The Solution: Bytecode Virtual Machine (The SQLite VDBE Approach)
WebDB uses a **Bytecode Virtual Machine (VDBE)**:
1. Queries compile into a flat, linear array of numeric bytecode instructions (`Uint8Array`).
2. The engine loop (`vm_step()`) is a flat `while` loop running a `switch (opcode)`. The call stack is never more than 1 function deep.
3. When a page fault occurs, the VM sets `status = STATUS_PAGE_FAULT`, records `fault_page_id`, and exits cleanly. All execution state lives in the pre-allocated `VmContext` struct in shared memory.
4. When JS loads the page into a slot, it calls `vm_step()` again—resuming execution at instruction `pc` with zero lost state.

---

## 2. Complete Opcode Binary Instruction Set

All opcodes are encoded as packed binary bytes in shared memory. Numerical parameters follow Little-Endian byte ordering:

| Range | Opcode Name | Byte (`uint8`) | Operands | Description & Behavior |
| :--- | :--- | :---: | :--- | :--- |
| **Cursor / Scan** | **`OP_HALT`** | `0x00` | None | Terminates `vm_step()`; sets status to `STATUS_DONE`. |
| | **`OP_OPEN_CURSOR`** | `0x01` | `cursor: uint8`, `root_page: uint32` | Binds cursor slot to root Page ID; resets cell index to 0. |
| | **`OP_REWIND`** | `0x02` | `cursor: uint8`, `jump_target: uint16` | Positions cursor at first cell; jumps to `jump_target` if empty. |
| | **`OP_NEXT_ROW`** | `0x03` | `cursor: uint8`, `jump_target: uint16` | Advances cell; follows `next_page_id`; jumps on EOF. |
| | **`OP_COLUMN_INT`** | `0x04` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 32-bit/64-bit int into `r[reg]`; sets NULL if null. |
| | **`OP_COLUMN_FLOAT`** | `0x05` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 64-bit float into `r[reg]`; sets NULL if null. |
| | **`OP_COLUMN_TEXT`** | `0x06` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads string pointer & length from row into `r[reg]`. |
| | **`OP_COLUMN_BLOB`** | `0x07` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads byte slice & length from row into `r[reg]`. |
| | **`OP_LAST`** | `0x08` | `cursor: uint8`, `jump_target: uint16` | Positions cursor at rightmost leaf cell for reverse scan. |
| | **`OP_PREV_ROW`** | `0x09` | `cursor: uint8`, `jump_target: uint16` | Decrements cell; follows `prev_page_id`; jumps on BOF. |
| **Logic / Control** | **`OP_IS_NULL`** | `0x10` | `cursor: uint8`, `col: uint8`, `jump_target: uint16` | Tests Null-Bitmap bit; jumps if set (`NULL`). |
| | **`OP_IS_NOT_NULL`** | `0x11` | `cursor: uint8`, `col: uint8`, `jump_target: uint16` | Tests Null-Bitmap bit; jumps if clear (not null). |
| | **`OP_EQ`** | `0x12` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL equality: jumps if `r[A] == r[B]` (both non-null). |
| | **`OP_NE`** | `0x13` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL inequality: jumps if `r[A] != r[B]` (both non-null). |
| | **`OP_GT`** | `0x14` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] > r[B]`. |
| | **`OP_GE`** | `0x15` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] >= r[B]`. |
| | **`OP_LT`** | `0x16` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] < r[B]`. |
| | **`OP_LE`** | `0x17` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] <= r[B]`. |
| | **`OP_JUMP`** | `0x18` | `jump_target: uint16` | Unconditional jump to bytecode target. |
| **Data / Output** | **`OP_LOAD_INT`** | `0x20` | `reg: uint8`, `val: int32` | Loads literal signed 32-bit int into `r[reg]`. |
| | **`OP_LOAD_FLOAT`** | `0x21` | `reg: uint8`, `val: float64` | Loads literal 64-bit float into `r[reg]`. |
| | **`OP_LOAD_TEXT`** | `0x22` | `reg: uint8`, `len: uint16`, `bytes: [len]` | Loads literal UTF-8 string into `r[reg]`. |
| | **`OP_LOAD_NULL`** | `0x23` | `reg: uint8` | Sets `r[reg] = NULL` (`type = 0`). |
| | **`OP_EMIT_ROW`** | `0x24` | `cursor: uint8` | Streams row into 64KB Result Buffer; yields `STATUS_BUFFER_FULL`. |
| | **`OP_CALL_UDF`** | `0x28` | `udf_id: uint16`, `arg_reg: uint8`, `out_reg: uint8` | Dispatches registered JS UDF function synchronously. |
| **Sorter (ORDER BY)** | **`OP_SORTER_OPEN`** | `0x30` | `sorter_id: uint8`, `key_info_idx: uint8` | Initializes Sorter in Transient Query Arena with `KeyInfo`. |
| | **`OP_SORTER_INSERT`** | `0x31` | `sorter_id: uint8`, `start_reg: uint8`, `num_keys: uint8`, `cursor: uint8` | Appends `SorterEntry` (16B) and sort keys in arena. |
| | **`OP_SORTER_SORT`** | `0x32` | `sorter_id: uint8` | Executes in-place Introsort on `SorterEntry[]`. |
| | **`OP_SORTER_NEXT`** | `0x33` | `sorter_id: uint8`, `jump_target: uint16` | Yields next sorted row; jumps to emit loop; falls through on EOF. |
| **Agg (GROUP BY)** | **`OP_AGG_INIT`** | `0x40` | `agg_id: uint8`, `start_key_reg: uint8`, `num_keys: uint8`, `mode: uint8` | Initializes Hash Table in arena (`0x00`) or Stream Aggregation (`0x01`). |
| | **`OP_AGG_STEP`** | `0x41` | `agg_id: uint8`, `start_key_reg: uint8`, `num_keys: uint8`, `val_reg: uint8`, `func_id: uint8` | Updates `AggBucket` accumulators (`COUNT`, `SUM`, `MIN`, `MAX`). |
| | **`OP_AGG_NEXT`** | `0x42` | `agg_id: uint8`, `out_key_reg: uint8`, `out_acc_reg: uint8`, `jump_target: uint16` | Iterates next group bucket into registers; jumps to emit loop. |
| | **`OP_AGG_FINAL`** | `0x43` | `sum_reg: uint8`, `count_reg: uint8`, `out_reg: uint8`, `func_id: uint8` | Finalizes aggregate expressions (e.g. `sum / count` for `AVG`). |
| **DML Mutation** | **`OP_DELETE_ROW`** | `0x50` | `cursor: uint8` | Deletes row via slot directory `memmove` compaction; removes index keys; increments `rows_affected`. |
| | **`OP_UPDATE_FIELD`** | `0x51` | `cursor: uint8`, `col_idx: uint8`, `val_reg: uint8` | Executes 3-scenario update; updates secondary index; increments `rows_affected`. |
| | **`OP_INSERT_ROW`** | `0x52` | `cursor: uint8`, `start_reg: uint8`, `num_cols: uint8` | Serializes registers to binary row; inserts into leaf; updates indexes; increments `rows_affected`. |

### 2.1 The Register File & Tagged Union Architecture

Every register operation (`r[reg]`, `regA`, `regB`, `out_reg`) reads and writes to a pre-allocated array of **16 registers** located inline within `VmContext` at byte offsets `216..471`:

```c
typedef struct {
    uint8_t  type;        // 0=NULL, 1=INT32, 2=INT64, 3=FLOAT64, 4=TEXT, 5=BLOB
    uint8_t  flags;       // Reserved flags (0x1 = CONSTANT/LITERAL)
    uint16_t len;         // Byte length for TEXT and BLOB payloads
    uint32_t str_offset;  // Byte offset in shared memory (page or arena) for text/blob
    union {
        int32_t  i32;     // 32-bit signed integer
        int64_t  i64;     // 64-bit signed integer
        double   f64;     // 64-bit IEEE 754 float
    } val;                // 8 bytes (8-byte aligned)
} Register;               // Exact size: 16 bytes
```

#### Register Characteristics:
1. **Zero-Heap Numeric Storage:** Numbers reside directly in the `val` union (`val.i32`, `val.i64`, `val.f64`). Numeric comparisons execute in pure CPU registers without heap allocations or JS wrapper objects.
2. **Zero-Copy TEXT/BLOB References:** For variable-length data, `type = 4 (TEXT)` or `5 (BLOB)` records the string byte length in `len` and points `str_offset` directly to the raw UTF-8 bytes residing inside the slotted page cache slot or query arena. String comparisons read directly from shared memory without copying string bytes into registers.
3. **Register Range & Bounds Check:** The VM enforces $0 \le \text{reg\_idx} < 16$. The binary bytecode compiler validates register indices at compile time, rejecting $\ge 16$. At runtime, `vm_step()` guards against out-of-bounds register access.
4. **Lifecycle & Reset:** When a query begins or a cursor rewinds, registers are initialized to `type = 0 (NULL)`. Between yielded execution chunks (`STATUS_PAGE_FAULT`, `STATUS_BUFFER_FULL`), register state is permanently preserved in `wasmMemory` with zero stack-saving overhead.

---

## 3. SQLite-Compatible Three-Valued Logic (3VL) in Register Evaluations

In SQL and WebDB, `NULL` represents missing or unknown data. Register comparison opcodes (`OP_EQ`, `OP_NE`, `OP_GT`, `OP_GE`, `OP_LT`, `OP_LE`) strictly adhere to **Three-Valued Logic**:

### 3.1 Truth Table for Register Comparisons:
| Register A (`r[A]`) | Register B (`r[B]`) | Comparison (`=`, `!=`, `<`, `>`) | 3VL Result | Jump Behavior |
| :---: | :---: | :---: | :---: | :--- |
| `10` | `20` | `r[A] < r[B]` | `TRUE` | **Jumps** to `jump_target` |
| `20` | `10` | `r[A] < r[B]` | `FALSE` | Falls through |
| `NULL` | `20` | Any operator | **`UNKNOWN`** | **Falls through** (does NOT jump) |
| `20` | `NULL` | Any operator | **`UNKNOWN`** | **Falls through** (does NOT jump) |
| `NULL` | `NULL` | `=` or `!=` | **`UNKNOWN`** | **Falls through** (does NOT jump) |

### 3.2 Distinctness (`IS` vs `=`)
- For `IS NULL` and `IS NOT NULL`, the compiler emits dedicated opcodes `OP_IS_NULL` and `OP_IS_NOT_NULL` that test the row's binary Null-Bitmap directly without register comparison traps.
- SQLite `a IS b` distinctness comparison treats two `NULL` values as matching (`TRUE`).

---

## 4. Chunked Pull Iterator (Result Buffer Streaming)

The Bytecode VM does not materialize whole result sets in memory. Instead, it operates as a high-performance **Chunked Pull Stream**:

```
[VM executes bytecode] ──► OP_EMIT_ROW copies row into 64KB Result Buffer
                                      │
               Has Result Buffer reached 64KB capacity?
                                     / \
                                   YES  NO
                                   /     \
    VM yields: STATUS_BUFFER_FULL         Continue next row loop
                 │
  Host JS drains 64KB chunk -> JS objects
  Host JS resets result_offset = 0
  Host JS calls vm_step() to pull next batch
```

- **Guaranteed Bounded Memory:** Regardless of whether a table has 100 rows or 10,000,000 rows, memory consumption for the result pipeline remains strictly bounded at **64 KB**.

---

## 5. Transient Query Arena, Aggregations & Sorter Architecture

The Transient Query Arena (`0x420000..Ceiling`, default 16 MB, configurable via `maxQueryMemory` up to 2 GB) provides ultra-fast bump-allocated scratch memory for aggregations (`GROUP BY`) and sorting (`ORDER BY`).

### 5.1 Hash Aggregations (`GROUP BY` without Index)

When grouping by unindexed expressions or arbitrary column subsets, WebDB accumulates group buckets in an **Open-Addressing Hash Table** allocated directly inside the Transient Query Arena.

#### A. AggBucket Layout (40 Bytes, 8-Byte Aligned)
Each distinct group occupies a contiguous 40-byte bucket:
```c
typedef struct {
    uint32_t hash;          // FNV-1a 32-bit hash of grouping keys (0 = EMPTY bucket marker)
    uint32_t key_offset;    // Arena byte offset to packed group key Registers
    int64_t  count;         // COUNT accumulator (rows in this group)
    double   sum;           // SUM accumulator (also used as numerator for AVG)
    double   min_val;       // MIN accumulator (numeric/date)
    double   max_val;       // MAX accumulator (numeric/date)
    uint8_t  has_val;       // 0x01 if at least one non-null value has been accumulated
    uint8_t  reserved[7];   // Alignment padding to 40 bytes
} AggBucket;                // Exact size: 40 bytes
```

#### B. Hash Table Lifecycle & Dynamic Resizing
1. **`OP_AGG_INIT (0x40)`:**
   - Allocates an initial array of **1,024 `AggBucket`s** ($1024 \times 40\text{ B} = 40.96\text{ KB}$) at `ctx->arena_offset`.
   - Clears bucket hashes to `0` (`EMPTY`).
2. **`OP_AGG_STEP (0x41)`:**
   - Computes FNV-1a hash over `num_keys` registers (`start_key_reg .. start_key_reg + num_keys - 1`). If the resulting hash is `0`, sets it to `1` (reserving `0` as empty sentinel).
   - Probes the table using **Linear Probing**:
     $$\text{slot} = (\text{hash} + i) \pmod{\text{capacity}}$$
   - **Matching Key:** If `bucket->hash == hash` and keys match lexicographically, updates accumulators:
     - `COUNT(*)`: `bucket->count++`.
     - `COUNT(col)`: increments only if `r[val_reg]` is not NULL.
     - `SUM(col)` / `AVG(col)`: if `r[val_reg]` is not NULL, `bucket->sum += val`, `bucket->has_val = 1`.
     - `MIN(col)` / `MAX(col)`: updates extremes if `r[val_reg]` is not NULL.
   - **Empty Slot:** Copies grouping key registers to arena memory, initializes accumulators, and marks bucket occupied.
   - **Dynamic Doubling at 70% Load Factor:**
     When occupied buckets exceed $70\%$ capacity ($> 716$ of 1,024), the table doubles capacity ($1024 \to 2048 \to 4096 \dots$). All active buckets are re-hashed into the expanded slice directly within the Transient Query Arena.
3. **Hard 16 MB Arena Ceiling (Fail-Fast OOM):**
   If table doubling or high cardinality pushes `arena_offset > 16 MB`:
   - The VM immediately halts and yields `STATUS_ERR_ARENA_EXHAUSTED`.
   - Host JS resets `arena_offset = 0` and rejects the query Promise with `QueryArenaExhaustedError`. **Silent truncation, dropped groups, or partial sums are strictly prohibited.**
4. **`OP_AGG_NEXT (0x42)` & `OP_AGG_FINAL (0x43)`:**
   - `OP_AGG_NEXT` iterates over occupied buckets, loading group keys and raw accumulators into output registers.
   - `OP_AGG_FINAL` finalizes calculations: for `AVG`, computes `sum / count` (yielding `NULL` if `count == 0` or `has_val == 0`); for `SUM`, yields `NULL` if `has_val == 0`.
   - Emits rows into the 64KB Result Buffer and jumps to the emission loop until all buckets are emitted.

#### C. SQLite-Compatible Grouping & NULL Semantics
* **`NULL` Group Keys:** SQL treats `NULL` values in grouping columns as distinct from non-nulls, but identical to each other. All rows with `NULL` group keys collapse into a single group bucket.
* **Max Grouping Columns:** Grouping supports at most **8 columns** per query. Exceeding 8 columns throws `TooManyGroupByColumnsError`.

### 5.2 Stream Aggregation Optimization ($O(1)$ Memory)

When grouping by an indexed column (or after data has been sorted via `OP_SORTER_SORT`), the compiler emits a **Stream Aggregation loop** in place of a hash table:
1. Emits `OP_AGG_INIT` in stream mode (`mode = 0x01`), bypassing hash table allocation entirely.
2. The VM maintains only a single group's accumulator registers in memory.
3. As the cursor scans ordered rows:
   - If `r[curr_key] == r[prev_key]`: update running accumulators in registers.
   - If `r[curr_key] != r[prev_key]`: emit the completed group row to the result buffer, reset accumulators, and store `r[prev_key] = r[curr_key]`.
4. **Zero-Arena Guarantee:** Processes an unlimited number of rows with strictly $O(1)$ constant memory and zero risk of arena exhaustion.

### 5.3 Multi-Column In-Arena Sorter Pipeline (`ORDER BY`)

When a query contains an `ORDER BY` clause that cannot be satisfied by an existing B+Tree index, WebDB executes a full in-memory Introsort inside the Transient Query Arena.

#### A. KeyInfo Descriptor & Hard 8-Column Sort Ceiling
Sorting supports multiple columns with independent directions and SQLite NULL collations:
```c
typedef struct {
    uint8_t num_keys;        // Number of sort keys: 1..8 (STRICT MAXIMUM: 8 columns)
    uint8_t directions[8];   // 0x00 = ASC, 0x01 = DESC
    uint8_t null_orders[8];  // 0x00 = NULLS_FIRST, 0x01 = NULLS_LAST (SQLite default: NULLS_FIRST for ASC, NULLS_LAST for DESC)
} KeyInfo;
```

> [!IMPORTANT]
> **Hard Limit: Maximum 8 Sort Columns:**
> WebDB enforces a compile-time ceiling of **at most 8 sort columns** per query (e.g. `orderBy(['col1', 'col2', ...])`).
> Compiling a query with $> 8$ sort keys throws `TooManyOrderByColumnsError`. This guarantees that `KeyInfo` fits in a compact 18-byte fixed struct and multi-key comparison loops remain unrolled and SIMD/cache-friendly.

#### B. SorterEntry Layout (16 Bytes)
Each row passing query filters is packed into the arena as a 16-byte `SorterEntry`, followed by its extracted key registers:
```c
typedef struct {
    uint32_t keys_offset;    // Arena byte offset to Register keys[num_keys]
    uint32_t row_offset;     // Byte offset of serialized row (in page cache or arena)
    uint16_t row_len;        // Serialized row length in bytes
    uint16_t flags;          // Reserved alignment padding
} SorterEntry;               // Exact size: 16 bytes
```

#### C. Sorter Execution Lifecycle
1. **`OP_SORTER_OPEN (0x30)`:** Allocates a contiguous dynamic array of `SorterEntry` at `ctx->arena_offset`.
2. **`OP_SORTER_INSERT (0x31)`:**
   - Reads `num_keys` values from registers `start_reg .. start_reg + num_keys - 1`.
   - Copies variable-length string/blob payloads into arena memory if referenced from temporary page slots.
   - Appends `SorterEntry` into `arena_offset`. If `arena_offset + alloc_size > 16 MB`, halts with `STATUS_ERR_ARENA_EXHAUSTED`.
3. **`OP_SORTER_SORT (0x32)`:**
   - Runs an in-place **Introsort** (quicksort switching to heapsort on deep recursion) directly on `SorterEntry[]`.
   - Compares elements using lexicographical multi-key evaluation:
     - Iterates through key $k = 0 \dots (\text{num\_keys}-1)$.
     - Handles `NULL`s according to `null_orders[k]`.
     - Compares types: numbers compare numerically, text compares via raw UTF-8 byte comparison (`memcmp`).
     - If keys are equal, continues to key $k+1$.
     - Inverts comparison sign if `directions[k] == 0x01 (DESC)`.
4. **`OP_SORTER_NEXT (0x33)`:**
   - Yields the next sorted row into the 64KB Result Buffer.
   - If buffer is full, yields `STATUS_BUFFER_FULL` and resumes on next step call.
   - Jumps to loop target until all sorted entries are emitted.
5. **Instant Arena Reset:** On `OP_HALT`, resetting `arena_offset = 0` reclaims all sorter memory in $O(1)$ time.

### 5.4 Index-Driven Reverse Walk (`ORDER BY col DESC`)

When sorting on a single indexed column in descending order (`orderBy(indexed_col, 'desc')`), the compiler avoids allocating sorter buffers entirely:
1. Emits **`OP_LAST (0x08)`** on the secondary index cursor, positioning the cursor directly at the rightmost leaf cell of the B+Tree.
2. Emits **`OP_PREV_ROW (0x09)`** in place of `OP_NEXT_ROW`, walking leftward across leaf pages via page sibling pointers (`prev_page_id`).
3. Streams rows in reverse in $O(1)$ memory without touching the Transient Query Arena.

### 5.5 DML Mutation Engine Pipeline (`INSERT`, `UPDATE`, `DELETE`)

WebDB executes all data modification operations through the VDBE step loop using dedicated mutation opcodes:

#### A. Tracking Affected Rows (`ctx->rows_affected`)
- `VmContext` embeds `uint32_t rows_affected` at byte offset `472`.
- Initialized to `0` at query execution start.
- Incremented every time a row is modified or deleted.
- When `OP_HALT` is reached, the host retrieves `{ rowsAffected: ctx->rows_affected }`.

#### B. `OP_DELETE_ROW (0x50)` Execution
1. **Physical Deletion & Compaction:** Invokes slotted-page cell deletion on the active cell pointed to by `cursor` using the contiguous slot directory `memmove` compaction defined in `01_storage_memory_arch.md` §4.2.
2. **Secondary Index Cleanup:** If the table has secondary indexes, extracts the indexed values from the target row and deletes the corresponding `(indexed_value, rowid)` leaf cells from the index B+Tree (`0x0A`).
3. **Dirty Page Tracking:** Sets the dirty bit for the current cache slot in `dirty_mask`.
4. **Empty Page Reclamation:** If `cell_count` drops to 0, unlinks the leaf page from the sibling chain and prepends it to `free_page_head` for zero-waste page recycling.
5. **Counter:** Increments `ctx->rows_affected++`.

#### C. `OP_UPDATE_FIELD (0x51)` Execution
1. **Target Inspection:** Reads `cursor`, `col_idx`, and updated value from `r[val_reg]`.
2. **Index Maintenance:** If `col_idx` is indexed, removes the old `(old_val, rowid)` entry from the secondary index B+Tree and inserts `(new_val, rowid)`.
3. **3-Scenario Slotted Page Update:**
   - **Scenario 1 (Fixed-Width):** Direct in-place byte overwrite (`memcpy`) into the fixed data slice.
   - **Scenario 2 (Variable-Width Fitting in Page):** Shrinks or expands var-payload; shifts cell directory and payloads via `memmove` compaction.
   - **Scenario 3 (Variable-Width Exceeding Page Free Space):** Deletes cell from current page and re-inserts expanded record into a new page via B+Tree leaf split.
4. **Dirty Page Tracking:** Sets dirty bit in `dirty_mask`.
5. **Counter:** Increments `ctx->rows_affected++`.

#### D. `OP_INSERT_ROW (0x52)` Execution
1. **Record Serialization:** Packs `num_cols` registers (`start_reg .. start_reg + num_cols - 1`) into a binary row record with dynamic Null-Bitmap and var-offset table.
2. **Row Size Guard:** Enforces the 2,048-byte hard ceiling (`RowSizeLimitExceededError`).
3. **Slotted Page Insertion:** Inserts record into the table B+Tree leaf under `cursor`. If free space is insufficient, triggers B+Tree leaf split (`0x0D`), creating a new page and updating parent interior nodes (`0x05`).
4. **Secondary Index Insertion:** For every indexed column, writes `(indexed_value, new_rowid)` to the corresponding index B+Tree (`0x0A`).
5. **Dirty Page Tracking:** Marks the modified cache slot(s) dirty in `dirty_mask`.
6. **Counter:** Increments `ctx->rows_affected++`.

---

## 6. Exhaustive Edge Cases & Failure Modes

* [ ] **Infinite Loop Guard:** Malformed bytecode loops jumping backward indefinitely must be trapped by a maximum instruction cycle counter (e.g. 10,000,000 cycles per step call) yielding `STATUS_TIMEOUT`.
* [ ] **Invalid Jump Offset:** Any jump target pointing outside the `[0, bytecode.byteLength]` range must halt with `STATUS_ERR_INVALID_BYTECODE`.
* [ ] **Register Index Out-of-Bounds:** Register index $\ge 16$ must be rejected at compile time.
* [ ] **Sort Column Ceiling Exceeded:** Queries with $> 8$ sort keys must throw `TooManyOrderByColumnsError` at compile time.
* [ ] **Group By Column Ceiling Exceeded:** Queries with $> 8$ grouping keys must throw `TooManyGroupByColumnsError` at compile time.
* [ ] **Zero-Length Text/Blob Emission:** Emitting empty strings `""` or 0-byte BLOBs must encode length 0 without corrupting buffer framing.

---

## 7. Verification & Test Suite (`tests/vdbe_engine.test.ts`)

1. **3VL Register Comparisons:** Assert `NULL = NULL` and `NULL != NULL` do not trigger jump targets.
2. **Result Buffer Chunking:** Insert 2,000 rows; assert `STATUS_BUFFER_FULL` yields across multiple chunks and hydrates all 2,000 rows without loss or duplication.
3. **Page Fault Yield & Resume:** Simulate disk page miss midway through scan; inject page into cache; resume `vm_step()`; assert scan continues without missing rows.
4. **Arena Exhaustion:** Simulate pathological cardinality exceeding 16 MB; assert clean `QueryArenaExhaustedError` and $O(1)$ memory recovery.
