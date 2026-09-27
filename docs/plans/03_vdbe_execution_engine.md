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

### 1.1 The Pure State Machine Architecture (Core ⟷ Host Communication)

#### The Fundamental Problem
In browser runtimes, disk I/O (Origin Private File System, IndexedDB) is **inherently asynchronous** (`await fileHandle.read(...)`).

However, **WebAssembly / compiled C is strictly synchronous**. C code does not have `await`. A C function cannot block a thread to wait for disk I/O without completely locking the browser tab's UI event loop.

#### The Solution: "Pause by Returning"
Instead of blocking or attempting stack-saving tricks, **C pauses by simply executing a standard function `return` statement**.

To "pause" execution on a cache miss:
1. **C records its state in shared linear memory (`wasmMemory`):**
   - It leaves the instruction pointer (`ctx->pc`) pointing directly at the current instruction (e.g. instruction index `14`).
   - It writes the missing page identifier to `ctx->fault_page_id` (e.g. `42`).
   - It sets `ctx->status = STATUS_PAGE_FAULT`.
2. **C executes `return STATUS_PAGE_FAULT;`**:
   The C function call stack unwinds completely to depth 0. Control returns immediately to JavaScript. JavaScript is now completely unblocked and can perform asynchronous disk reads with standard `await`.

#### The Shared Memory Notebook (`VmContext`)
Both JavaScript and C inspect the exact same WebAssembly linear memory (`ArrayBuffer`). The execution state is stored at fixed offset `VM_CONTEXT_OFFSET` (`0x405080`):

```c
// Stored at 0x405080 in shared linear memory
typedef struct {
    uint32_t pc;            // Program counter (current bytecode byte offset)
    uint32_t status;        // 0=RUNNING, 1=DONE, 2=PAGE_FAULT, 3=BUFFER_FULL, 4=ERROR...
    uint32_t fault_page_id; // Missing Page ID requested from disk
    uint32_t result_count;  // Count of emitted rows in current chunk
    uint32_t result_offset; // Write offset inside the 64KB Result Buffer
    uint32_t arena_offset;  // Allocation offset in Transient Query Arena
    uint32_t rows_affected; // Counter for mutated rows (DML)
    uint32_t reserved;      // Reserved flags
    Cursor   cursors[16];   // 16 table & index cursors (192 bytes)
    Register registers[64]; // 64 evaluation registers (1024 bytes)
    uint8_t  _padding[32];  // Aligns frame to exactly 1,280 bytes
} VmFrame;

typedef struct {
    uint8_t  depth;         // Active nesting level (0=root, 1..7=subquery)
    uint8_t  _pad[7];       // 8-byte alignment
    VmFrame  frames[8];     // 8-frame nesting stack (10,240 bytes)
} VmContext;                // Total: 10,248 bytes (within 12,288 byte window)
```

#### Code Walkthrough: How Core (C) Pauses
```c
// src/core/c/vm.c (Conceptual C Implementation)

int vm_step(VmContext* ctx, const uint8_t* bytecode, uint32_t bytecode_len) {
    VmFrame* frame = &ctx->frames[ctx->depth];

    while (frame->pc < bytecode_len) {
        uint8_t opcode = bytecode[frame->pc];

        switch (opcode) {
            case OP_NEXT_ROW: {
                uint8_t  cursor_idx  = bytecode[frame->pc + 1];
                uint16_t jump_target = *(uint16_t*)(&bytecode[frame->pc + 2]);
                Cursor*  cur         = &frame->cursors[cursor_idx];

                // If traversing to next page:
                uint32_t target_page = cur->page_id;

                // 1. Probe Page Table in shared memory: Is target_page resident in cache?
                int slot = buf_pool_get_resident_slot(target_page);

                if (slot == -1) {
                    // CACHE MISS! The page is on disk, not in RAM.
                    // DO NOT advance frame->pc! It remains pointing at OP_NEXT_ROW.
                    frame->fault_page_id = target_page;
                    frame->status        = STATUS_PAGE_FAULT;

                    // Pause by standard C return:
                    return STATUS_PAGE_FAULT;
                }

                // CACHE HIT: Bind slot and continue scanning
                cur->slot_idx = (uint16_t)slot;
                frame->pc += 4;
                break;
            }

            case OP_HALT:
                frame->status = STATUS_DONE;
                return STATUS_DONE;
        }
    }
    return STATUS_DONE;
}
```

#### Code Walkthrough: How Host (JavaScript) Resumes Execution
```typescript
// src/host/driver/io_driver.ts (Host Driver State Machine Orchestrator)

async function stepVmUntilDone(ctx: VmContext, bytecode: Uint8Array): Promise<void> {
  while (true) {
    // 1. Invoke synchronous C engine step
    const status = vm_step(ctxOffset);

    // 2. Query completed successfully
    if (status === VmStatus.DONE) {
      break;
    }

    // 3. Handle Page Fault: missing page must be loaded from VFS
    if (status === VmStatus.PAGE_FAULT) {
      const missingPageId = read_u32(view, activeFrameOffset + OFFSET_FAULT_PAGE_ID);

      // Asynchronous disk block read (OPFS / IndexedDB)
      const pageBytes = await vfs.readPage(missingPageId);

      // Select victim cache slot via Clock Sweep, evicting/flushing if dirty
      const slot = await ioDriver.acquirePage(missingPageId);

      // Buffer pool and page table now map missingPageId -> slot.
      // Re-invoking vm_step() resumes AT THE EXACT SAME INSTRUCTION (pc was not advanced)!
      continue;
    }

    // 4. Handle Result Buffer Full: 64KB chunk must be drained
    if (status === VmStatus.BUFFER_FULL) {
      await hostApi.drainResultBuffer();
      // Reset result write offset to 0 and continue pulling rows
      write_u32(view, activeFrameOffset + OFFSET_RESULT_OFFSET, 0);
      continue;
    }

    if (status >= VmStatus.ERROR) {
      throw new Error(`VM execution failed with status code ${status}`);
    }
  }
}
```

#### State Machine Sequence Diagram
```
    JavaScript (Host Layer)                           C / Wasm (Core Layer)
    -----------------------                           ---------------------
               │                                                │
    1. Calls vm_step(ctxOffset) ───────────────────────────────►│ Starts bytecode loop
               │                                                │
               │                                                │ Evaluates OP_NEXT_ROW
               │                                                │ Needs Page 42...
               │                                                │ Probes Page Table -> MISS!
               │                                                │ Writes: fault_page_id = 42
               │                                                │ Writes: status = PAGE_FAULT
               │                                                │ (Leaves pc unchanged)
               │                                                │
    2. Receives return value ◄──────────────────────────────────┘ return STATUS_PAGE_FAULT
               │
    3. Async Disk Read:
       pageData = await vfs.readPage(42)
       Allocates slot 5 in shared memory
       Updates Page Table: 42 -> Slot 5
               │
    4. Calls vm_step(ctxOffset) again ─────────────────────────►│ Re-reads saved pc
                                                                │ Evaluates OP_NEXT_ROW again
                                                                │ Probes Page Table -> HIT in Slot 5!
                                                                │ Advances pc += 4
                                                                │ Continues next instruction...
```

---

## 2. Complete Opcode Binary Instruction Set

All opcodes are encoded as packed binary bytes in shared memory. Numerical parameters follow Little-Endian byte ordering:

| Range | Opcode Name | Byte (`uint8`) | Operands | Description & Behavior |
| :--- | :--- | :---: | :--- | :--- |
| **Cursor / Scan** | **`OP_HALT`** | `0x00` | None | Terminates `vm_step()`; sets status to `STATUS_DONE`. |
| | **`OP_OPEN_CURSOR`** | `0x01` | `cursor: uint8`, `root_page: uint32` | Binds cursor slot to root Page ID; checks cache residency; resets cell index to 0. |
| | **`OP_REWIND`** | `0x02` | `cursor: uint8`, `jump_target: uint16` | Positions cursor at first cell; jumps to `jump_target` if page has 0 cells. |
| | **`OP_NEXT_ROW`** | `0x03` | `cursor: uint8`, `jump_target: uint16` | Advances cell; follows `next_page_id`; yields `STATUS_PAGE_FAULT` on cache miss; jumps on EOF. |
| | **`OP_COLUMN_INT`** | `0x04` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 32-bit/64-bit int from row into `r[reg]`; sets NULL if null. |
| | **`OP_COLUMN_FLOAT`** | `0x05` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 64-bit IEEE float from row into `r[reg]`; sets NULL if null. |
| | **`OP_COLUMN_TEXT`** | `0x06` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads string byte offset & length from row into `r[reg]`. |
| | **`OP_COLUMN_BLOB`** | `0x07` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads binary byte slice & length from row into `r[reg]`. |
| | **`OP_COLUMN_UUID`** | `0x0A` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 16-byte raw UUID binary payload into `r[reg]` (`type = 6`). |
| | **`OP_COLUMN_ULID`** | `0x0B` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 16-byte raw ULID binary payload into `r[reg]` (`type = 7`). |
| | **`OP_LAST`** | `0x08` | `cursor: uint8`, `jump_target: uint16` | Positions cursor at rightmost leaf cell for reverse B-tree scan. |
| | **`OP_PREV_ROW`** | `0x09` | `cursor: uint8`, `jump_target: uint16` | Decrements cell; follows `prev_page_id`; yields `STATUS_PAGE_FAULT` on miss; jumps on BOF. |
| **Logic / Control** | **`OP_IS_NULL`** | `0x10` | `cursor: uint8`, `col: uint8`, `jump_target: uint16` | Tests row's Null-Bitmap bit; jumps if set (`NULL`). |
| | **`OP_IS_NOT_NULL`** | `0x11` | `cursor: uint8`, `col: uint8`, `jump_target: uint16` | Tests row's Null-Bitmap bit; jumps if clear (not null). |
| | **`OP_EQ`** | `0x12` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL equality: jumps if `r[A] == r[B]` (both non-null). |
| | **`OP_NE`** | `0x13` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL inequality: jumps if `r[A] != r[B]` (both non-null). |
| | **`OP_GT`** | `0x14` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] > r[B]`. |
| | **`OP_GE`** | `0x15` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] >= r[B]`. |
| | **`OP_LT`** | `0x16` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] < r[B]`. |
| | **`OP_LE`** | `0x17` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] <= r[B]`. |
| | **`OP_JUMP`** | `0x18` | `jump_target: uint16` | Unconditional jump to bytecode target address. |
| **Data / Output** | **`OP_LOAD_INT`** | `0x20` | `reg: uint8`, `val: int32` | Loads literal signed 32-bit int into `r[reg]`. |
| | **`OP_LOAD_FLOAT`** | `0x21` | `reg: uint8`, `val: float64` | Loads literal 64-bit float into `r[reg]`. |
| | **`OP_LOAD_TEXT`** | `0x22` | `reg: uint8`, `len: uint16`, `bytes: [len]` | Loads literal UTF-8 string into `r[reg]`. |
| | **`OP_LOAD_NULL`** | `0x23` | `reg: uint8` | Sets `r[reg] = NULL` (`type = 0`). |
| | **`OP_EMIT_ROW`** | `0x24` | `cursor: uint8` | Streams raw serialized row from cursor into 64KB Result Buffer; yields `STATUS_BUFFER_FULL` if full. |
| | **`OP_RESULT_ROW`** | `0x25` | `start_reg: uint8`, `num_cols: uint8` | Serializes projected registers into binary row in 64KB Result Buffer; yields `STATUS_BUFFER_FULL` if full. |
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

Every register operation (`r[reg]`, `regA`, `regB`, `out_reg`) reads and writes to a pre-allocated array of **64 registers** located inline within the **active `VmFrame`** at byte offsets `224..1247`. The active frame is always `ctx->frames[ctx->depth]`:

```c
typedef struct {
    uint8_t  type;        // 0=NULL, 1=INT32, 2=INT64, 3=FLOAT64, 4=TEXT, 5=BLOB, 6=UUID, 7=ULID
    uint8_t  flags;       // Reserved flags (0x1 = CONSTANT/LITERAL)
    uint16_t len;         // Byte length for TEXT, BLOB, UUID, and ULID payloads (fixed 16 for UUID/ULID)
    uint32_t str_offset;  // Byte offset in shared memory (page or arena) for text/blob/uuid/ulid
    union {
        int32_t  i32;     // 32-bit signed integer
        int64_t  i64;     // 64-bit signed integer
        double   f64;     // 64-bit IEEE 754 float
        uint8_t  raw16[8];// Inline direct slice for compact fixed representations
    } val;                // 8 bytes (8-byte aligned)
} Register;               // Exact size: 16 bytes
```

#### Register Characteristics & Supported Types:
1. **Zero-Heap Numeric Storage:** Numbers reside directly in the `val` union (`val.i32`, `val.i64`, `val.f64`). Numeric comparisons execute in pure CPU registers without heap allocations or JS wrapper objects.
2. **Zero-Copy TEXT & BLOB References:** For variable-length data, `type = 4 (TEXT)` or `5 (BLOB)` records the byte length in `len` and points `str_offset` directly to the raw UTF-8 / binary bytes residing inside the slotted page cache slot or query arena. String comparisons read directly from shared memory via `memcmp` without copying string bytes into registers.
3. **Fixed-Length Binary UUID & ULID Types:** `type = 6 (UUID)` and `type = 7 (ULID)` represent binary 16-byte identifiers (`len = 16`). `str_offset` points directly to the 16 bytes in page storage or literal arena memory. Lexicographical comparisons operate directly via 16-byte `memcmp`.
4. **Register Range & Bounds Check:** The VM enforces $0 \le \text{reg\_idx} < 64$. The binary bytecode compiler validates register indices at compile time, rejecting $\ge 64$. At runtime, `vm_step()` guards against out-of-bounds register access.
5. **Per-Frame Isolation:** Each `VmFrame` has its own independent 64-register file. Pushing a correlated subquery (`ctx->depth++`) gives the inner query a completely fresh register namespace without disturbing the outer query's live registers.
6. **Lifecycle & Reset:** When a query begins, a frame is pushed, or a cursor rewinds, registers in the active frame are initialized to `type = 0 (NULL)`. Between yielded execution chunks (`STATUS_PAGE_FAULT`, `STATUS_BUFFER_FULL`), register state is permanently preserved in `wasmMemory` with zero stack-saving overhead.

### 2.2 Cursor Layout & Buffer Pool Slot Resolution

Each `VmFrame` embeds an array of **16 cursors** (`cursors[0..15]`, total 192 bytes at frame offset `32..223`). A cursor maintains the operational navigation state across B+Tree tables and indexes:

```c
typedef struct {
    uint32_t page_id;      // Database Page ID currently focused (0 = uninitialized, 0xFFFFFFFF = arena)
    uint16_t slot_idx;     // Buffer pool cache slot index (0..slot_count - 1) holding this page
    uint16_t cell_idx;     // Slot directory index within the page (0..cell_count - 1)
    uint16_t cell_offset;  // Byte offset of the active cell payload within the page
    uint8_t  btree_depth;  // B-Tree traversal depth (0 = leaf)
    uint8_t  flags;        // 0x01 = EOF, 0x02 = PINNED, 0x04 = ARENA_CURSOR
} Cursor;                  // Exact size: 12 bytes
```

#### Slot Resolution Invariant:
Whenever an instruction navigates to a `page_id` (`OP_OPEN_CURSOR`, `OP_NEXT_ROW`, `OP_PREV_ROW`):
1. The VM probes the hash table using `buf_pool_get_resident_slot(page_id)`.
2. **Hit:** `slot_idx` is updated in the cursor, and cell access proceeds immediately at `slot_idx * PAGE_SIZE`.
3. **Miss:** The VM sets `frame->fault_page_id = page_id`, sets `frame->status = STATUS_PAGE_FAULT`, and immediately returns without advancing `pc`.

### 2.3 Virtual Machine Status Codes

The status field in each `VmFrame` communicates execution state between Core and Host:

| Code (`uint32`) | Identifier | Meaning | Host Action Required |
| :---: | :--- | :--- | :--- |
| `0` | **`STATUS_RUNNING`** | VM instruction execution is currently in progress. | Internal VM state. |
| `1` | **`STATUS_DONE`** | Query completed successfully. | Read rows/mutations, release locks. |
| `2` | **`STATUS_PAGE_FAULT`** | Missing page encountered during scan/seek. | Read `fault_page_id`, load from VFS into cache slot, re-invoke `vm_step()`. |
| `3` | **`STATUS_BUFFER_FULL`** | 64KB Result Buffer is full of serialized rows. | Drain rows to JS objects, reset `result_offset = 0`, re-invoke `vm_step()`. |
| `4` | **`STATUS_ERROR`** | Internal engine execution error occurred. | Inspect error code, reject query Promise. |
| `5` | **`STATUS_TIMEOUT`** | Instruction cycle limit (10,000,000 cycles) exceeded. | Abort query with `QueryTimeoutError`. |
| `6` | **`STATUS_ERR_ARENA_EXHAUSTED`** | Transient Query Arena exceeded `maxQueryMemory` (16MB). | Reject query with `QueryArenaExhaustedError`. |
| `7` | **`STATUS_ERR_INVALID_BYTECODE`** | Corrupt opcode or jump target out-of-bounds. | Abort query with `InvalidBytecodeError`. |

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
[VM executes bytecode] ──► OP_EMIT_ROW / OP_RESULT_ROW writes row into 64KB Result Buffer
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

### 4.1 Record Framing Format (`0x408080..0x41807F`, 64 KB)
Rows are packed contiguously into the Output Result Buffer using length-prefixed binary framing:
- `[record_length: uint16]` (2 bytes, Little-Endian)
- `[record_bytes: uint8[record_length]]` (raw serialized binary row payload)

### 4.2 Emission Opcodes
1. **`OP_EMIT_ROW (0x24, cursor: uint8)`**:
   Copies the raw serialized record currently focused under `cursor` directly from its page cache slot into the Result Buffer.
2. **`OP_RESULT_ROW (0x25, start_reg: uint8, num_cols: uint8)`**:
   Serializes `num_cols` projected registers (`start_reg .. start_reg + num_cols - 1`) into a dynamic binary row with Null-Bitmap and variable-offset table directly into the Result Buffer.

### 4.3 Buffer Full Invariant
If adding the next row requires `result_offset + 2 + record_len > 65,536` bytes:
- The VM leaves `frame->pc` positioned at the emission instruction (or current loop cycle).
- The VM sets `frame->status = STATUS_BUFFER_FULL`.
- `vm_step()` returns `STATUS_BUFFER_FULL`.
- The Host JS drains all complete records, resets `result_offset = 0` and `result_count = 0`, and re-invokes `vm_step()`.

- **Guaranteed Bounded Memory:** Regardless of whether a table has 100 rows or 10,000,000 rows, memory consumption for the result pipeline remains strictly bounded at **64 KB**.

---

## 5. Transient Query Arena, Aggregations & Sorter Architecture

The Transient Query Arena (`0x430000..Ceiling`, default 16 MB, configurable via `maxQueryMemory` up to 2 GB) provides ultra-fast bump-allocated scratch memory for aggregations (`GROUP BY`) and sorting (`ORDER BY`).

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

#### A. Tracking Affected Rows (`ctx->frames[ctx->depth].rows_affected`)
- Each `VmFrame` embeds `uint32_t rows_affected` at byte offset `24..27` within the frame (absolute address `0x4050A0` for root frame 0: `0x405080 + 8 + 24`).
- Initialized to `0` at query execution start.
- Incremented every time a row is modified or deleted: `ctx->frames[ctx->depth].rows_affected++`.
- When `OP_HALT` is reached, the host retrieves `{ rowsAffected: ctx->frames[ctx->depth].rows_affected }`.

#### B. `OP_DELETE_ROW (0x50)` Execution
1. **Physical Deletion & Compaction:** Invokes slotted-page cell deletion on the active cell pointed to by `cursor` using the contiguous slot directory `memmove` compaction defined in `01_storage_memory_arch.md` §4.2.
2. **Secondary Index Cleanup:** If the table has secondary indexes, extracts the indexed values from the target row and deletes the corresponding `(indexed_value, rowid)` leaf cells from the index B+Tree (`0x0A`).
3. **Dirty Page Tracking:** Sets the dirty bit for the current cache slot in `dirty_mask`.
4. **Empty Page Reclamation:** If `cell_count` drops to 0, unlinks the leaf page from the sibling chain and prepends it to `free_page_head` for zero-waste page recycling.
5. **Counter:** Increments `ctx->frames[ctx->depth].rows_affected++`.

#### C. `OP_UPDATE_FIELD (0x51)` Execution
1. **Target Inspection:** Reads `cursor`, `col_idx`, and updated value from `r[val_reg]`.
2. **Index Maintenance:** If `col_idx` is indexed, removes the old `(old_val, rowid)` entry from the secondary index B+Tree and inserts `(new_val, rowid)`.
3. **3-Scenario Slotted Page Update:**
   - **Scenario 1 (Fixed-Width):** Direct in-place byte overwrite (`memcpy`) into the fixed data slice.
   - **Scenario 2 (Variable-Width Fitting in Page):** Shrinks or expands var-payload; shifts cell directory and payloads via `memmove` compaction.
   - **Scenario 3 (Variable-Width Exceeding Page Free Space):** Deletes cell from current page and re-inserts expanded record into a new page via B+Tree leaf split.
4. **Dirty Page Tracking:** Sets dirty bit in `dirty_mask`.
5. **Counter:** Increments `ctx->frames[ctx->depth].rows_affected++`.

#### D. `OP_INSERT_ROW (0x52)` Execution
1. **Record Serialization:** Packs `num_cols` registers (`start_reg .. start_reg + num_cols - 1`) into a binary row record with dynamic Null-Bitmap and var-offset table.
2. **Row Size Guard:** Enforces the 2,048-byte hard ceiling (`RowSizeLimitExceededError`).
3. **Slotted Page Insertion:** Inserts record into the table B+Tree leaf under `cursor`. If free space is insufficient, triggers B+Tree leaf split (`0x0D`), creating a new page and updating parent interior nodes (`0x05`).
4. **Secondary Index Insertion:** For every indexed column, writes `(indexed_value, new_rowid)` to the corresponding index B+Tree (`0x0A`).
5. **Dirty Page Tracking:** Marks the modified cache slot(s) dirty in `dirty_mask`.
6. **Counter:** Increments `ctx->frames[ctx->depth].rows_affected++`.

---

## 6. Exhaustive Edge Cases & Failure Modes

* [ ] **Infinite Loop Guard:** Malformed bytecode loops jumping backward indefinitely must be trapped by a maximum instruction cycle counter (e.g. 10,000,000 cycles per step call) yielding `STATUS_TIMEOUT`.
* [ ] **Invalid Jump Offset:** Any jump target pointing outside the `[0, bytecode.byteLength]` range must halt with `STATUS_ERR_INVALID_BYTECODE`.
* [ ] **Register Index Out-of-Bounds:** Register index $\ge 64$ must be rejected at compile time with `TooManyRegistersError`.
* [ ] **Sort Column Ceiling Exceeded:** Queries with $> 8$ sort keys must throw `TooManyOrderByColumnsError` at compile time.
* [ ] **Group By Column Ceiling Exceeded:** Queries with $> 8$ grouping keys must throw `TooManyGroupByColumnsError` at compile time.
* [ ] **Cursor Slot Exhaustion:** Opening more than 16 cursors in a single frame must throw `TooManyCursorsError` at compile time.
* [ ] **Subquery Nesting Overflow:** Correlated subquery nesting deeper than 7 levels (`ctx->depth` attempting to exceed 7) must throw `SubqueryNestingTooDeepError` at compile time.
* [ ] **Frame Depth Underflow:** `ctx->depth--` when already at 0 must halt with `STATUS_ERR_INVALID_BYTECODE` (guard against malformed subquery pop opcodes).
* [ ] **Zero-Length Text/Blob Emission:** Emitting empty strings `""` or 0-byte BLOBs must encode length 0 without corrupting buffer framing.

---

## 7. Verification & Test Suite (`tests/vdbe_engine.test.ts`)

1. **3VL Register Comparisons:** Assert `NULL = NULL` and `NULL != NULL` do not trigger jump targets.
2. **Result Buffer Chunking:** Insert 2,000 rows; assert `STATUS_BUFFER_FULL` yields across multiple chunks and hydrates all 2,000 rows without loss or duplication.
3. **Page Fault Yield & Resume:** Simulate disk page miss midway through scan; inject page into cache; resume `vm_step()`; assert scan continues without missing rows.
4. **Arena Exhaustion:** Simulate pathological cardinality exceeding 16 MB; assert clean `QueryArenaExhaustedError` and $O(1)$ memory recovery.
