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
| | **`OP_LAST`** | `0x08` | `cursor: uint8`, `jump_target: uint16` | Positions cursor at rightmost leaf cell for reverse B-tree scan. |
| | **`OP_PREV_ROW`** | `0x09` | `cursor: uint8`, `jump_target: uint16` | Decrements cell; follows `prev_page_id`; yields `STATUS_PAGE_FAULT` on miss; jumps on BOF. |
| | **`OP_COLUMN_UUID`** | `0x0A` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 16-byte raw UUID binary payload into `r[reg]` (`type = 6`). |
| | **`OP_COLUMN_ULID`** | `0x0B` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 16-byte raw ULID binary payload into `r[reg]` (`type = 7`). |
| | **`OP_OPEN_EPHEMERAL`** | `0x0C` | `cursor: uint8`, `num_cols: uint8` | Initializes transient in-memory B-Tree cursor for subquery materialization. |
| **Logic / Control** | **`OP_IS_NULL`** | `0x10` | `cursor: uint8`, `col: uint8`, `jump_target: uint16` | Tests row's Null-Bitmap bit; jumps if set (`NULL`). |
| | **`OP_IS_NOT_NULL`** | `0x11` | `cursor: uint8`, `col: uint8`, `jump_target: uint16` | Tests row's Null-Bitmap bit; jumps if clear (not null). |
| | **`OP_EQ`** | `0x12` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL equality: jumps if `r[A] == r[B]` (both non-null). |
| | **`OP_NE`** | `0x13` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL inequality: jumps if `r[A] != r[B]` (both non-null). |
| | **`OP_GT`** | `0x14` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] > r[B]`. |
| | **`OP_GE`** | `0x15` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] >= r[B]`. |
| | **`OP_LT`** | `0x16` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] < r[B]`. |
| | **`OP_LE`** | `0x17` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | 3VL comparison: jumps if `r[A] <= r[B]`. |
| | **`OP_JUMP`** | `0x18` | `jump_target: uint16` | Unconditional jump to bytecode target address. |
| | **`OP_STR_LIKE`** | `0x19` | `regStr: uint8`, `regPat: uint8`, `jump_target: uint16` | 3VL SQL `LIKE`: jumps if `r[Str] LIKE r[Pat]` (`%` and `_` wildcards). |
| | **`OP_STR_NOT_LIKE`** | `0x1A` | `regStr: uint8`, `regPat: uint8`, `jump_target: uint16` | 3VL SQL `NOT LIKE`: jumps if `r[Str] NOT LIKE r[Pat]`. |
| | **`OP_STR_CONTAINS`** | `0x1B` | `regStr: uint8`, `regSub: uint8`, `jump_target: uint16` | 3VL substring test: jumps if `r[Str]` contains `r[Sub]`. |
| | **`OP_STR_STARTS_WITH`** | `0x1C` | `regStr: uint8`, `regPfx: uint8`, `jump_target: uint16` | 3VL prefix test: jumps if `r[Str]` starts with `r[Pfx]`. |
| | **`OP_STR_ENDS_WITH`** | `0x1D` | `regStr: uint8`, `regSfx: uint8`, `jump_target: uint16` | 3VL suffix test: jumps if `r[Str]` ends with `r[Sfx]`. |
| **Data / Output** | **`OP_LOAD_INT`** | `0x20` | `reg: uint8`, `val: int32` | Loads literal signed 32-bit int into `r[reg]`. |
| | **`OP_LOAD_FLOAT`** | `0x21` | `reg: uint8`, `val: float64` | Loads literal 64-bit float into `r[reg]`. |
| | **`OP_LOAD_TEXT`** | `0x22` | `reg: uint8`, `len: uint16`, `bytes: [len]` | Loads literal UTF-8 string into `r[reg]`. |
| | **`OP_LOAD_NULL`** | `0x23` | `reg: uint8` | Sets `r[reg] = NULL` (`type = 0`). |
| | **`OP_EMIT_ROW`** | `0x24` | `cursor: uint8` | Streams raw serialized row from cursor into 64KB Result Buffer; yields `STATUS_BUFFER_FULL` if full. |
| | **`OP_RESULT_ROW`** | `0x25` | `start_reg: uint8`, `num_cols: uint8` | Serializes projected registers into binary row in 64KB Result Buffer; yields `STATUS_BUFFER_FULL` if full. |
| | **`OP_OFFSET`** | `0x26` | `count_reg: uint8`, `jump_target: uint16` | If `r[count_reg] > 0`, decrements counter and jumps to skip emission. |
| | **`OP_LIMIT`** | `0x27` | `count_reg: uint8`, `jump_target: uint16` | If `r[count_reg] == 0`, jumps to terminate query (`OP_HALT`); decrements counter. |
| | **`OP_CALL_UDF`** | `0x28` | `udf_id: uint16`, `start_arg_reg: uint8`, `num_args: uint8`, `out_reg: uint8` | Dispatches registered JS UDF function synchronously via Host bridge. |
| | **`OP_STR_LOWER`** | `0x29` | `src_reg: uint8`, `dest_reg: uint8` | Converts string in `r[src]` to lowercase into `r[dest]`. |
| | **`OP_STR_UPPER`** | `0x2A` | `src_reg: uint8`, `dest_reg: uint8` | Converts string in `r[src]` to uppercase into `r[dest]`. |
| | **`OP_STR_LENGTH`** | `0x2B` | `src_reg: uint8`, `dest_reg: uint8` | Computes UTF-8 string character/byte length into `r[dest]` (int32). |
| | **`OP_STR_SUBSTR`** | `0x2C` | `src_reg: uint8`, `start_reg: uint8`, `len_reg: uint8`, `dest_reg: uint8` | Extracts 1-indexed substring into `r[dest]`. |
| | **`OP_STR_TRIM`** | `0x2D` | `src_reg: uint8`, `dest_reg: uint8` | Strips leading and trailing ASCII whitespace into `r[dest]`. |
| | **`OP_MATH_ABS`** | `0x2E` | `src_reg: uint8`, `dest_reg: uint8` | Computes absolute value `\|x\|` into `r[dest]`. |
| | **`OP_MATH_ROUND`** | `0x2F` | `src_reg: uint8`, `dest_reg: uint8` | Rounds float in `r[src]` to nearest integer in `r[dest]`. |
| **Sorter / Math** | **`OP_SORTER_OPEN`** | `0x30` | `sorter_id: uint8`, `key_info_idx: uint8` | Initializes Sorter in Transient Query Arena with `KeyInfo`. |
| | **`OP_SORTER_INSERT`** | `0x31` | `sorter_id: uint8`, `start_reg: uint8`, `num_keys: uint8`, `cursor: uint8` | Appends `SorterEntry` (16B) and sort keys in arena. |
| | **`OP_SORTER_SORT`** | `0x32` | `sorter_id: uint8` | Executes in-place Introsort on `SorterEntry[]`. |
| | **`OP_SORTER_NEXT`** | `0x33` | `sorter_id: uint8`, `jump_target: uint16` | Yields next sorted row; jumps to emit loop; falls through on EOF. |
| | **`OP_MATH_FLOOR`** | `0x34` | `src_reg: uint8`, `dest_reg: uint8` | Computes mathematical floor $\lfloor x \rfloor$ into `r[dest]`. |
| | **`OP_MATH_CEIL`** | `0x35` | `src_reg: uint8`, `dest_reg: uint8` | Computes mathematical ceiling $\lceil x \rceil$ into `r[dest]`. |
| | **`OP_ADD`** | `0x36` | `regA: uint8`, `regB: uint8`, `dest_reg: uint8` | 3VL numeric addition `r[dest] = r[A] + r[B]`. |
| | **`OP_SUB`** | `0x37` | `regA: uint8`, `regB: uint8`, `dest_reg: uint8` | 3VL numeric subtraction `r[dest] = r[A] - r[B]`. |
| | **`OP_MUL`** | `0x38` | `regA: uint8`, `regB: uint8`, `dest_reg: uint8` | 3VL numeric multiplication `r[dest] = r[A] * r[B]`. |
| | **`OP_DIV`** | `0x39` | `regA: uint8`, `regB: uint8`, `dest_reg: uint8` | 3VL numeric division `r[dest] = r[A] / r[B]` (NULL on zero). |
| | **`OP_MOD`** | `0x3A` | `regA: uint8`, `regB: uint8`, `dest_reg: uint8` | 3VL integer modulo `r[dest] = r[A] % r[B]`. |
| | **`OP_ENTER_SUBQUERY`**| `0x3B` | `frame_depth: uint8` | Increments `ctx->depth`, initializing fresh register frame. |
| | **`OP_RETURN_SUBQUERY`**| `0x3C` | `src_reg: uint8`, `parent_dest_reg: uint8` | Copies result register to parent frame and decrements `ctx->depth`. |
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

### 2.4 Native String Operations & Pattern Matching

To eliminate Wasm ⟷ JS context switches and prevent Garbage Collection churn during table scans, string filters and transformations execute directly in native C/Wasm with zero JS object allocations.

#### A. SQL `LIKE` Pattern Matching (`OP_STR_LIKE`, `OP_STR_NOT_LIKE`)
- **Wildcard Semantics:**
  - `%` matches any sequence of zero or more characters.
  - `_` matches exactly one character.
  - Standard ASCII case-insensitive matching matching SQLite defaults.
- **Algorithm:** An iterative $O(M + N)$ backtracking algorithm executes over raw byte slices without recursion or heap allocation.
- **3VL Invariant:** If either `r[regStr]` or `r[regPat]` is `NULL`, the result evaluates to `UNKNOWN` $\to$ falls through without jumping.

#### B. Substring & Prefix/Suffix Branching (`OP_STR_CONTAINS`, `OP_STR_STARTS_WITH`, `OP_STR_ENDS_WITH`)
- Operates directly over evaluation registers `r[regStr]` and `r[regArg]`.
- Jumps to `jump_target` on match; falls through on mismatch or when either operand is `NULL`.

#### C. Scalar String Transformations (`OP_STR_LOWER`, `OP_STR_UPPER`, `OP_STR_LENGTH`, `OP_STR_SUBSTR`)
- **`OP_STR_LOWER` / `OP_STR_UPPER`:** In-place or destination register case transformation.
- **`OP_STR_LENGTH`:** Computes UTF-8 character length into destination register as an `int32`.
- **`OP_STR_SUBSTR`:** Extracts a 1-indexed SQL substring `SUBSTR(str, start, length)` into `dest_reg`. If `r[str]` or `r[start]` is `NULL`, `dest_reg` is set to `NULL`.

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

## 6. Query Compilation & Execution Instruction Patterns

Every high-level SQL / QueryBuilder query compiles into a structured, linear stream of VDBE bytecode. This section details how query clauses are compiled and executed in the VM.

### 6.1 `SELECT` Projection & Table Scans

The engine distinguishes between two projection paths: **full row emission** and **columnar projection**:

```
Full Scan:       OP_OPEN_CURSOR -> OP_REWIND -> [Loop: OP_EMIT_ROW -> OP_NEXT_ROW] -> OP_HALT
Projected Cols:  OP_OPEN_CURSOR -> OP_REWIND -> [Loop: OP_COLUMN_xxx -> OP_RESULT_ROW -> OP_NEXT_ROW] -> OP_HALT
```

#### A. Full Table Scan (`SELECT *`)
When all columns are requested without transformation, the engine streams records directly from cache slots without unpacking fields into registers:
```
addr  opcode           p1  p2   p3   comment
0000  OP_OPEN_CURSOR   0   1    0    ; Open Cursor 0 on root page 1
0005  OP_REWIND        0   15   0    ; If table is empty, jump to HALT (addr 15)
0008  OP_EMIT_ROW      0   0    0    ; Copy raw binary record from Cursor 0 to Result Buffer
0010  OP_NEXT_ROW      0   8    0    ; Advance cell; if not EOF, jump to addr 8
0015  OP_HALT          0   0    0    ; Finish execution (STATUS_DONE)
```

#### B. Column Projection (`SELECT id, name`)
When specific columns are selected, the compiler extracts fields into contiguous registers and emits them via `OP_RESULT_ROW`:
```
addr  opcode           p1  p2   p3   comment
0000  OP_OPEN_CURSOR   0   1    0    ; Open Cursor 0 on table root page
0005  OP_REWIND        0   23   0    ; If empty, jump to HALT (addr 23)
0008  OP_COLUMN_INT    0   0    1    ; r[1] = col 0 (id)
0012  OP_COLUMN_TEXT   0   1    2    ; r[2] = col 1 (name)
0016  OP_RESULT_ROW    1   2    0    ; Emit 2 columns starting at r[1] (r[1]..r[2])
0019  OP_NEXT_ROW      0   8    0    ; Next row; loop to addr 8
0023  OP_HALT          0   0    0    ; Done
```

---

### 6.2 `WHERE` Clause Filter Execution (Boolean Logic & Short-Circuiting)

`WHERE` conditions compile into register load and comparison opcodes positioned immediately after cursor cell positioning, guarding the emission instruction.

#### A. Single Predicate (`WHERE age > 21`)
Non-matching rows jump directly to the loop advance (`OP_NEXT_ROW`), skipping projection:
```
addr  opcode           p1  p2   p3   comment
0008  OP_COLUMN_INT    0   2    1    ; r[1] = col 2 (age)
0012  OP_LOAD_INT      2   21   0    ; r[2] = 21
0017  OP_LE            1   2    22   ; If r[1] <= r[2], skip row -> jump to addr 22 (OP_NEXT_ROW)
0021  OP_EMIT_ROW      0   0    0    ; Row passed filter; emit
0022  OP_NEXT_ROW      0   8    0    ; Advance to next row
```

#### B. Compound Conditions (`AND`, `OR`, `NOT`) & Short-Circuit Evaluation

Boolean trees compile into deterministic jump graphs where branches evaluate with minimal instruction steps:

1. **`A AND B`**: Condition A checks first; on failure, jumps immediately to `OP_NEXT_ROW` (B is never evaluated).
2. **`A OR B`**: Condition A checks first; on success, jumps immediately to the emission block (B is never evaluated). If A fails, falls through to test B.
3. **`NOT (A OR B)` (De Morgan's Equivalent: `NOT A AND NOT B`)**: Evaluates branch A; if true, jumps to next row. Evaluates branch B; if true, jumps to next row. Falls through to emit only if neither matched.

```
       [ Read Column Values into Registers ]
                         │
                 Condition A True?
                    /         \
                 YES           NO (Jump to next row for AND / Test B for OR)
                  │             │
          Condition B True?   Condition B True? (OR branch)
             /        \          /         \
          YES          NO      YES          NO
           │            │       │            │
      [ Emit Row ]   [ Skip ] [ Emit Row ] [ Skip ]
```

---

### 6.3 `GROUP BY` & Aggregations Execution

Aggregation compiles into a two-phase state machine: **Accumulation Scan** followed by **Group Bucket Emission**:

```
Phase 1 (Scan):   OP_AGG_INIT -> [Scan: Extract Keys -> OP_AGG_STEP -> OP_NEXT_ROW]
                                                │ (EOF reached)
Phase 2 (Emit):   [Bucket Loop: OP_AGG_NEXT -> OP_AGG_FINAL -> OP_RESULT_ROW] -> OP_HALT
```

```
addr  opcode           p1  p2   p3   comment
0000  OP_AGG_INIT      0   1    1    ; Init Aggregator 0 in arena, 1 group key
0005  OP_OPEN_CURSOR   0   1    0    ; Open table cursor
0010  OP_REWIND        0   35   0    ; If empty, skip scan to emission
0013  OP_COLUMN_TEXT   0   3    1    ; r[1] = col 3 (dept, grouping key)
0017  OP_COLUMN_FLOAT  0   5    2    ; r[2] = col 5 (salary, aggregated value)
0021  OP_AGG_STEP      0   1    1    ; Agg 0: step with key r[1], value r[2] (SUM)
0027  OP_NEXT_ROW      0   13   0    ; Loop scan
; --- Phase 2: Emit aggregated groups ---
0035  OP_AGG_NEXT      0   3    4    ; Load next group key -> r[3], accumulators -> r[4..5]
0041  OP_AGG_FINAL     4   5    6    ; Finalize AVG: r[6] = sum(r[4]) / count(r[5])
0046  OP_RESULT_ROW    3   2    0    ; Emit group: [r[3] (dept), r[6] (avg_salary)]
0050  OP_JUMP          35  0    0    ; Loop to next aggregate bucket until EOF
0053  OP_HALT          0   0    0    ; Done
```

---

### 6.4 `ORDER BY` Sorting Pipeline & Top-K Optimization

When sorting cannot be satisfied by an existing B+Tree index, the engine executes an in-arena sort using `OP_SORTER_OPEN`, `OP_SORTER_INSERT`, `OP_SORTER_SORT`, and `OP_SORTER_NEXT`.

Depending on whether a `LIMIT` clause is present and within bounds, the engine automatically chooses between a **Full In-Arena Introsort** and a **Bounded Top-K Max-Heap**.

```
                           ORDER BY Execution Path
                                     │
                    Is LIMIT specified and within threshold?
                    requested_k = (offset ?? 0) + limit
                    0 < requested_k <= MAX_TOPK_HEAP_LIMIT (4096)
                                    / \
                                  YES  NO (No LIMIT or requested_k > 4096)
                                  /     \
                Bounded Top-K Max-Heap    Full In-Arena Sorter
                - Arena memory: O(K)       - Arena memory: O(N)
                - Sift-down: O(log K)      - Full collection: O(N)
                - Discards non-top in O(1) - Introsort: O(N log N)
```

#### A. Full In-Arena Sorter Pipeline (No LIMIT or Large Limits)
When sorting an unbounded result set or when `requested_k > MAX_TOPK_HEAP_LIMIT`:
```
Phase 1 (Collect): OP_SORTER_OPEN -> [Scan: Read Keys -> OP_SORTER_INSERT -> OP_NEXT_ROW]
                                                    │ (EOF reached)
Phase 2 (Sort):    OP_SORTER_SORT (In-place Introsort on SorterEntry array, O(N log N))
                                                    │
Phase 3 (Stream):  [Emit Loop: OP_SORTER_NEXT -> OP_RESULT_ROW / OP_EMIT_ROW] -> OP_HALT
```
- **Phase 1 (Collect):** Every row matching the query filters is copied into the Transient Query Arena as a `SorterEntry` with its sort keys.
- **Phase 2 (Sort):** When the table scan finishes, `OP_SORTER_SORT` runs an in-place Introsort (quicksort switching to heapsort on deep recursion) over all $N$ entries in $O(N \log N)$ time.
- **Phase 3 (Stream):** `OP_SORTER_NEXT` yields sorted rows sequentially into the 64KB Result Buffer.

---

#### B. Bounded Top-K Max-Heap Optimization (`ORDER BY ... LIMIT K`)

Sorting $1,000,000$ rows simply to return the top $10$ rows is an immense waste of CPU cycles and arena memory. When `ORDER BY` is paired with `LIMIT`, the engine activates a **Bounded Max-Heap** directly inside `OP_SORTER_INSERT`:

```
               [ Candidate Row Extracted ]
                            │
               Heap count < max_k ?
                  /            \
               YES              NO (Heap is at full capacity K)
                │                │
        Append to heap      Compare keys against Root (entries[0])
        Sift-up in O(log K)      │
                            Candidate is worse than Root? (cmp >= 0)
                               /            \
                            YES              NO (Candidate is strictly better!)
                             │                │
                      Discard row in O(1)    Replace Root with Candidate
                      Zero arena allocation  Sift-down in O(log K)
```

1. **Heap Initialization:**
   `KeyInfo` records the target capacity:
   $$\text{requested\_k} = (\text{offset} \mathbin{??} 0) + \text{limit}$$
   If $0 < \text{requested\_k} \le \text{MAX\_TOPK\_HEAP\_LIMIT}$, `max_k = requested_k`.

2. **The "Worst-Element" Root Invariant:**
   The heap is organized as a **Max-Heap** (relative to the desired sort order). The root element (`sorter.entries[0]`) always stores the **worst candidate currently qualifying for the top $K$**:
   - For an `ASC` query (`ORDER BY score ASC LIMIT 10`), the root is the *maximum* score among the current top 10.
   - For a `DESC` query (`ORDER BY score DESC LIMIT 10`), the root is the *minimum* score among the current top 10.

3. **$O(1)$ Early Discard:**
   Once $K$ rows have accumulated in the heap, any incoming candidate row is compared against the root (`entries[0]`):
   - **`cmp >= 0` (Worse or Equal):** The candidate cannot possibly qualify for the final top $K$. It is **instantly discarded** in $O(1)$ time with **zero memory allocation** and zero row-copying overhead.
   - **`cmp < 0` (Better than Root):** The candidate qualifies! It replaces the root at `entries[0]` and executes a `heap_sift_down` in $O(\log K)$ steps, maintaining the heap invariant.

4. **Fast Heapsort:**
   At scan completion, instead of sorting $N$ rows, `OP_SORTER_SORT` sorts only the $K$ elements in $O(K \log K)$ time.

---

#### C. The `MAX_TOPK_HEAP_LIMIT` Threshold (4,096 Rows)

WebDB enforces a strict ceiling on the maximum size of the bounded heap:

```typescript
export const MAX_TOPK_HEAP_LIMIT = 4096;
```

> [!IMPORTANT]
> **Why `MAX_TOPK_HEAP_LIMIT = 4096`?**
> 1. **Cache Locality vs Tree Depth:**
>    For $K \le 4096$, the binary heap tree has depth $\le 12$ ($\log_2(4096) = 12$). Every sift-down requires at most 12 comparisons, and the entire `SorterEntry` array ($4096 \times 16\text{ B} = 64\text{ KB}$) fits entirely within the CPU's **L1/L2 cache**.
> 2. **Branch Misprediction & Quicksort Crossover:**
>    When $K > 4096$ (e.g. `LIMIT 50000` or deep pagination like `OFFSET 100000 LIMIT 10`), the cost of repeated sift-downs over deep memory hierarchies exceeds the throughput of contiguous cache-line memory moves in Introsort.
> 3. **Automatic Fallback:**
>    If `(offset + limit) > 4096`, `max_k` is automatically set to `0`. `OP_SORTER_INSERT` falls back transparently to contiguous array collection, and `OP_SORTER_SORT` performs a full Introsort across all matching rows.

---

#### D. Bytecode Walkthrough: `ORDER BY salary DESC LIMIT 5`
```
addr  opcode           p1  p2   p3   comment
0000  OP_SORTER_OPEN   0   0    0    ; Open Sorter 0 with KeyInfo 0 (limit=5, max_k=5)
0005  OP_OPEN_CURSOR   0   1    0    ; Open employees table cursor
0010  OP_REWIND        0   30   0    ; If empty, jump to HALT
; --- Scan & Top-K Sorter Insert ---
0013  OP_COLUMN_FLOAT  0   4    1    ; r[1] = salary (sort key)
0017  OP_SORTER_INSERT 0   1    1    ; Insert into Sorter 0 with Top-K bound (max_k=5)
0022  OP_NEXT_ROW      0   13   0    ; Loop scan
; --- Phase 2: Sort top 5 elements ---
0030  OP_SORTER_SORT   0   0    0    ; Sorts only 5 elements in O(K log K)
; --- Phase 3: Emit Top-K rows ---
0035  OP_SORTER_NEXT   0   45   0    ; Yield next sorted entry; jump to addr 45 on EOF
0040  OP_EMIT_ROW      0   0    0    ; Emit row
0042  OP_JUMP          35  0    0    ; Loop to next sorted row
0045  OP_HALT          0   0    0    ; Done
```

---

### 6.5 `LIMIT` & `OFFSET` Pagination

Pagination uses hardware-style countdown registers initialized before the scan loop:
- **`OP_OFFSET (0x26, count_reg: uint8, jump_target: uint16)`**: If `r[count_reg] > 0`, decrements `r[count_reg]` and jumps to `jump_target` (bypassing `OP_RESULT_ROW` / `OP_EMIT_ROW`).
- **`OP_LIMIT (0x27, count_reg: uint8, jump_target: uint16)`**: Checks if `r[count_reg] == 0`. If 0, jumps to `jump_target` (which points to `OP_HALT`), terminating the query early. Otherwise decrements `r[count_reg]` and proceeds to emission.

```
       [ Row Evaluated & Filter Passed ]
                         │
                 r[offset] > 0 ?
                    /         \
                 YES           NO
                  │             │
          r[offset]--      r[limit] == 0 ?
          Jump to next row   /         \
                          YES           NO
                           │             │
                      OP_HALT        r[limit]--
                                     OP_RESULT_ROW
```

---

## 7. Function Calling Architecture (Built-In Scalars & UDFs)

To guarantee optimal performance and seamless composability across subqueries and clauses, function calls run directly within the VDBE register pipeline rather than through client-side JavaScript object wrappers.

### 7.1 Built-in Scalar Functions

The VM natively implements standard SQL functions over registers:

| Category | Function | Opcode | Operands | Register Transformation |
| :--- | :--- | :---: | :--- | :--- |
| **String** | `UPPER(s)` | `OP_STR_UPPER` (`0x2A`) | `src, dest` | `r[dest] = UPPER(r[src])` |
| | `LOWER(s)` | `OP_STR_LOWER` (`0x29`) | `src, dest` | `r[dest] = LOWER(r[src])` |
| | `LENGTH(s)` | `OP_STR_LENGTH` (`0x2B`) | `src, dest` | `r[dest] = character_length(r[src])` |
| | `SUBSTR(s, p, l)` | `OP_STR_SUBSTR` (`0x2C`) | `src, start, len, dest` | `r[dest] = substring(r[src], r[start], r[len])` |
| | `TRIM(s)` | `OP_STR_TRIM` (`0x2D`) | `src, dest` | `r[dest] = trim_whitespace(r[src])` |
| **Math** | `ABS(x)` | `OP_MATH_ABS` (`0x2E`) | `src, dest` | `r[dest] = \|r[src]\|` |
| | `ROUND(x)` | `OP_MATH_ROUND` (`0x2F`) | `src, dest` | `r[dest] = round(r[src])` |
| | `FLOOR(x)` | `OP_MATH_FLOOR` (`0x34`) | `src, dest` | `r[dest] = floor(r[src])` |
| | `CEIL(x)` | `OP_MATH_CEIL` (`0x35`) | `src, dest` | `r[dest] = ceil(r[src])` |
| **Arithmetic**| `+` | `OP_ADD` (`0x36`) | `regA, regB, dest` | `r[dest] = r[A] + r[B]` |
| | `-` | `OP_SUB` (`0x37`) | `regA, regB, dest` | `r[dest] = r[A] - r[B]` |
| | `*` | `OP_MUL` (`0x38`) | `regA, regB, dest` | `r[dest] = r[A] * r[B]` |
| | `/` | `OP_DIV` (`0x39`) | `regA, regB, dest` | `r[dest] = r[A] / r[B]` (NULL if `r[B] == 0`) |
| | `%` | `OP_MOD` (`0x3A`) | `regA, regB, dest` | `r[dest] = r[A] % r[B]` |

---

### 7.2 Function Invocation Across Different Clauses

Because scalar functions operate on generic register indices, the compiler can place them in any clause pipeline:

#### 1. In `SELECT` (Projections)
Computes output fields into result registers immediately prior to row emission:
```sql
SELECT upper(name), floor(score) FROM students;
```
Bytecode:
```
OP_COLUMN_TEXT  0  1  1       ; r[1] = students.name
OP_COLUMN_FLOAT 0  2  2       ; r[2] = students.score
OP_STR_UPPER    1  3  0       ; r[3] = upper(r[1])
OP_MATH_FLOOR   2  4  0       ; r[4] = floor(r[2])
OP_RESULT_ROW   3  2  0       ; Emit [r[3], r[4]]
```

#### 2. In `WHERE` (Filter Predicates)
Computes dynamic values before executing jump comparisons:
```sql
WHERE lower(email) = 'user@example.com' AND abs(balance) > 100
```
Bytecode:
```
OP_COLUMN_TEXT  0  2  1       ; r[1] = email
OP_STR_LOWER    1  2  0       ; r[2] = lower(r[1])
OP_LOAD_TEXT    3  "user@example.com"
OP_NE           2  3  skip    ; If lower(email) != 'user@example.com', skip row
OP_COLUMN_FLOAT 0  4  4       ; r[4] = balance
OP_MATH_ABS     4  5  0       ; r[5] = abs(r[4])
OP_LOAD_FLOAT   6  100.0      ; r[6] = 100.0
OP_LE           5  6  skip    ; If abs(balance) <= 100, skip row
```

#### 3. In `ORDER BY` (Sorting Expressions)
Computes sorting keys into temporary registers before inserting into the Sorter:
```sql
ORDER BY length(name) DESC, round(score) ASC
```
Bytecode:
```
OP_COLUMN_TEXT  0  1  1       ; r[1] = name
OP_STR_LENGTH   1  2  0       ; r[2] = length(name)  [Key 0]
OP_COLUMN_FLOAT 0  2  3       ; r[3] = score
OP_MATH_ROUND   3  4  0       ; r[4] = round(score)  [Key 1]
OP_SORTER_INSERT 0 2  2  0    ; Insert sorter entry with 2 keys starting at r[2]
```

#### 4. In `GROUP BY` (Grouping Expressions)
Groups rows by computed expressions instead of raw columns:
```sql
GROUP BY substr(created_at, 1, 7)  -- Group by Year-Month "YYYY-MM"
```
Bytecode:
```
OP_COLUMN_TEXT  0  3  1       ; r[1] = created_at
OP_LOAD_INT     2  1  0       ; r[2] = 1 (start)
OP_LOAD_INT     3  7  0       ; r[3] = 7 (length)
OP_STR_SUBSTR   1  2  3  4    ; r[4] = substr(r[1], 1, 7) [Group Key]
OP_AGG_STEP     0  4  1  ...  ; Accumulate bucket under key r[4]
```

#### 5. In `HAVING` (Post-Aggregation Filtering)
Evaluates expressions on finalized aggregate buckets before emitting:
```sql
HAVING count(*) * 10 > 500
```
Bytecode:
```
OP_AGG_NEXT     0  1  2  ...  ; r[2] = count(*)
OP_LOAD_INT     3  10 0       ; r[3] = 10
OP_MUL          2  3  4       ; r[4] = count(*) * 10
OP_LOAD_INT     5  500 0      ; r[5] = 500
OP_LE           4  5  skip_bucket ; If count * 10 <= 500, skip bucket
```

---

### 7.3 User-Defined Functions (UDFs) & Host-Core Dispatch

WebDB supports custom JavaScript and TypeScript functions via `OP_CALL_UDF (0x28)`.

#### A. Registration API
Applications register custom functions on the `WebDB` instance:
```typescript
db.registerFunction('hash_token', {
  deterministic: true,
  call: (val: string, row?: DbRow) => sha256(val),
});
```

#### B. Execution Bridge (`OP_CALL_UDF`)
```
Core (Wasm / C)                                   Host (JavaScript)
───────────────                                   ─────────────────
OP_CALL_UDF(udf_id, start_reg, num_args, out_reg)
       │
       ├── Marshal argument registers (r[start_reg..+num_args])
       └── Calls Host Bridge: host_dispatch_udf(udf_id, args) ────► Executes JS UDF
                                                                          │
       ┌── Receives return value and writes into r[out_reg] ◄──────────────┘
       ▼
Advances pc += 5 to next opcode
```

#### C. Determinism & Optimizations
- **Deterministic Functions (`deterministic: true`)**: If all arguments to a deterministic function are literals (e.g. `hash_token('static_salt')`), the query compiler evaluates the function once at **compile time** (constant folding) and emits `OP_LOAD_TEXT` instead of invoking `OP_CALL_UDF` on every row during table scan.
- **Non-Deterministic Functions (e.g. `random()`, `now()`)**: Must execute on every row iteration.

---

### 7.4 Query-Level Dynamic Computed Expressions Across Clauses

> [!NOTE]
> **V1 Scope Clarification:**
> **Schema-level generated columns** (`CREATE TABLE ... col AS (expr) STORED / VIRTUAL`) are **not supported in V1** and are documented in [`docs/plans/future_extensions_roadmap.md`](file:///Users/ahmad/h/webdb/docs/plans/future_extensions_roadmap.md#L467-L560) §10.
> In V1, all computed columns are **query-level dynamic expressions** evaluated on the fly in the VDBE register pipeline.

Query-level computed expressions allow queries to transform, combine, and project dynamic values (e.g., `score * 2 AS double_score`, `upper(name) AS upper_name`, `floor(price * 0.9) AS discounted_price`).

#### A. Expression Construction & Unified AST (`ExprNode`)
Expressions are authored in two equivalent, supported syntaxes (documented in [`docs/plans/query_builder_api_and_grammar.md`](file:///Users/ahmad/h/webdb/docs/plans/query_builder_api_and_grammar.md#L274-L364) §4.4):
1. **Standalone Helper Functions (Drizzle style)**: `fn.floor(col('score').mul(2).add(10)).as('adjusted_score')`
2. **SQL String Expressions**: `'floor(score * 2 + 10) as adjusted_score'` (parsed via Pratt micro-parser)

Both syntaxes compile into the same unified internal AST node (`ExprNode`):
```typescript
export type ExprNode =
  | { type: 'col'; name: string }
  | { type: 'literal'; value: number | string | boolean | null }
  | { type: 'binary'; op: '+' | '-' | '*' | '/' | '%'; left: ExprNode; right: ExprNode }
  | { type: 'fn'; name: string; args: ExprNode[] };
```

#### B. Expression Tree Compilation & Register Life Cycle
The VDBE compiler decomposes the `ExprNode` AST into a post-order sequence of binary and unary register opcodes:

```
Expression: floor(score * 2 + 10) AS adjusted_score
                      [ OP_MATH_FLOOR ] -> r[5] (Output Result)
                             │
                         [ OP_ADD ] -> r[4]
                        /        \
              [ OP_MUL ] -> r[3]  [ OP_LOAD_INT 10 ] -> r[2]
             /        \
  [ OP_COLUMN score ]  [ OP_LOAD_INT 2 ] -> r[1]
```

Bytecode emitted:
```
OP_COLUMN_FLOAT  0  2  0    ; r[0] = score
OP_LOAD_INT      1  2  0    ; r[1] = 2
OP_MUL           0  1  3    ; r[3] = score * 2
OP_LOAD_INT      2  10 0    ; r[2] = 10
OP_ADD           3  2  4    ; r[4] = (score * 2) + 10
OP_MATH_FLOOR    4  5  0    ; r[5] = floor((score * 2) + 10)  <- Final Result
```

#### B. Computed Expressions Across Different Clauses
Because the VDBE evaluates expressions in registers, dynamic computations compose seamlessly across all query clauses:

1. **In `SELECT` (Projections)**:
   The computed result register `r[5]` is mapped into the contiguous range `[start_reg .. start_reg + num_cols - 1]` passed to `OP_RESULT_ROW`.
2. **In `WHERE` (Filter Predicates)**:
   The expression evaluates into a temporary register `r[temp]` and is immediately checked by comparison opcodes (`OP_EQ`, `OP_GT`, etc.):
   ```sql
   WHERE floor(score * 2) >= 100
   ```
   If false, jumps to `OP_NEXT_ROW` without executing the projection block.
3. **In `ORDER BY` (Sorting on Expressions)**:
   Dynamic expressions are evaluated during the table scan and stored as sort keys in `SorterEntry.keys` via `OP_SORTER_INSERT`:
   ```sql
   ORDER BY score * 2 DESC
   ```
   The sorted order is determined by the computed value, not the raw column.
4. **In `GROUP BY` (Bucket Keys)**:
   Expressions are evaluated per row and passed as group keys to `OP_AGG_STEP`:
   ```sql
   GROUP BY floor(score / 10) * 10  -- Group into deciles: 0, 10, 20...
   ```
5. **In Derived Subqueries (`FROM (SELECT ...)`)**:
   When an inner query outputs a computed column `adjusted_score`, the outer query can reference it directly:
   ```sql
   SELECT adjusted_score * 1.05 FROM (
     SELECT floor(score * 2) AS adjusted_score FROM students
   ) WHERE adjusted_score > 50
   ```
   - If **flattened**, the expression is inlined: `(floor(score * 2)) * 1.05`.
   - If **materialized**, the computed value is stored in the ephemeral B-Tree cell and read by the outer query as a regular column.

---

## 8. Nested Queries, Ephemeral Materialization & Subquery Flattening

When a query selects from a subquery (`FROM (SELECT ...)`), WebDB uses two architectural strategies: **Subquery Flattening** (zero-overhead query rewrites) and **Ephemeral Table Materialization** (isolated multi-frame execution).

```
                            Nested Query in FROM
                                     │
                     Can subquery be flattened safely?
                     - No GROUP BY / Aggregates
                     - No LIMIT / OFFSET
                     - No DISTINCT / UNION
                                    / \
                                  YES  NO
                                  /     \
             Subquery Flattening        Ephemeral Materialization
          Inline expressions into outer       OP_OPEN_EPHEMERAL
          Single-pass scan; 0 temp tables    Inner query populates temp B-tree
                                              Outer query scans temp cursor
```

### 8.1 The Multi-Frame Subquery Stack (`VmContext.depth`)

The engine maintains an 8-frame execution stack (`ctx->frames[0..7]`, total 10,248 bytes in shared memory):
1. **Frame Push (`OP_ENTER_SUBQUERY`, `ctx->depth++`)**:
   - Activates a completely fresh 64-register namespace and 16 cursor slots.
   - Preserves all parent registers and cursors without risking register clobbering.
2. **Correlated Register Access**:
   - Inner queries can read outer query registers via negative depth indexing: `parent_frame = ctx->frames[ctx->depth - 1]`.
3. **Frame Pop (`OP_RETURN_SUBQUERY`, `ctx->depth--`)**:
   - Copies scalar subquery result from child `src_reg` into parent `parent_dest_reg`.
   - Decrements `ctx->depth`, resuming outer execution cleanly.

---

### 8.2 Subquery Materialization via Ephemeral Tables (`OP_OPEN_EPHEMERAL`)

When a subquery contains `GROUP BY`, `ORDER BY`, `LIMIT`, or aggregates, it cannot be flattened. The engine materializes the inner query into an **ephemeral B-Tree cursor**:

```sql
SELECT dept, total_payroll * 1.1 AS projected_cost
FROM (
  SELECT dept, sum(salary) AS total_payroll
  FROM employees
  GROUP BY dept
)
WHERE total_payroll > 100000;
```

#### Bytecode Execution Walkthrough:
```
; === Phase 1: Inner Subquery Materialization ===
0000  OP_OPEN_EPHEMERAL 1   2   0    ; Open Ephemeral Cursor 1 with 2 columns
0005  OP_AGG_INIT       0   1   1    ; Aggregate employees by dept...
0010  ... [Scan employees, execute OP_AGG_STEP] ...
0025  OP_AGG_NEXT       0   1   2    ; r[1] = dept, r[2] = sum(salary)
0030  OP_INSERT_ROW     1   1   2    ; Insert [r[1], r[2]] into Ephemeral Cursor 1
0035  ... [Loop until all group buckets inserted] ...

; === Phase 2: Outer Query Execution over Ephemeral Cursor ===
0040  OP_REWIND         1   70  0    ; Rewind Ephemeral Cursor 1 to beginning
0045  OP_COLUMN_FLOAT   1   1   3    ; r[3] = total_payroll
0049  OP_LOAD_FLOAT     4   100000.0 ; r[4] = 100000.0
0054  OP_LE             3   4   66   ; If total_payroll <= 100000, skip -> addr 66
0058  OP_LOAD_FLOAT     5   1.1      ; r[5] = 1.1
0063  OP_MUL            3   5   6    ; r[6] = total_payroll * 1.1 (projected_cost)
0067  OP_COLUMN_TEXT    1   0   7    ; r[7] = dept
0071  OP_RESULT_ROW     7   2   0    ; Emit [dept, projected_cost]
0075  OP_NEXT_ROW       1   45  0    ; Advance Ephemeral Cursor 1 -> loop to addr 45
0080  OP_HALT           0   0   0    ; Done
```

---

### 8.3 Subquery Flattening Optimization (View / Subquery Inlining)

Whenever a derived table contains only linear projections and filters, materializing an ephemeral table is an unnecessary $O(N)$ memory and CPU penalty.

The query planner automatically **inlines** inner expressions into the outer query:

#### Example Query:
```sql
SELECT name, score * 2
FROM (
  SELECT upper(name) AS name, floor(score) AS score
  FROM students
  WHERE active = 1
)
WHERE score >= 60;
```

#### Flattening Transformation Steps:
1. **Alias Substitution**: The outer query references to `name` and `score` are substituted with the inner query expressions:
   - Outer `name` $\to$ Inner `upper(name)`
   - Outer `score * 2` $\to$ Inner `floor(score) * 2`
2. **Predicate Merging**: Outer filter `score >= 60` merges with inner filter `active = 1`:
   - `WHERE active = 1 AND floor(score) >= 60`
3. **Optimized Unified Query**:
```sql
SELECT upper(name) AS name, floor(score) * 2 AS score
FROM students
WHERE active = 1 AND floor(score) >= 60;
```

#### Resulting Bytecode (Zero Ephemeral Tables, Single Streaming Pass):
```
addr  opcode           p1  p2   p3   comment
0000  OP_OPEN_CURSOR   0   1    0    ; Open students table cursor
0005  OP_REWIND        0   48   0    ; If empty, jump to HALT
; --- Merged WHERE Predicates ---
0008  OP_COLUMN_INT    0   3    1    ; r[1] = active
0012  OP_LOAD_INT      2   1    0    ; r[2] = 1
0016  OP_NE            1   2    44   ; If active != 1, skip row -> addr 44
0020  OP_COLUMN_FLOAT  0   2    3    ; r[3] = score
0024  OP_MATH_FLOOR    3   4    0    ; r[4] = floor(score)
0028  OP_LOAD_INT      5   60   0    ; r[5] = 60
0032  OP_LT            4   5    44   ; If floor(score) < 60, skip row -> addr 44
; --- Merged SELECT Expressions ---
0036  OP_COLUMN_TEXT   0   1    6    ; r[6] = name
0040  OP_STR_UPPER     6   7    0    ; r[7] = upper(name)
0044  OP_LOAD_INT      8   2    0    ; r[8] = 2
0048  OP_MUL           4   8    9    ; r[9] = floor(score) * 2
0052  OP_RESULT_ROW    7   2    0    ; Emit [r[7] (name), r[9] (score*2)]
0056  OP_NEXT_ROW      0   8    0    ; Loop scan
0060  OP_HALT          0   0    0    ; Done
```
**Benefits:**
- **Zero Temporary Memory:** Bypasses ephemeral B-Tree and Transient Arena allocations.
- **Single-Pass Stream:** Rows stream directly into the 64KB Result Buffer in $O(1)$ space.
- **Cache Friendly:** Evaluates directly inside registers without writing and re-reading memory pages.

---

## 9. Exhaustive Edge Cases & Failure Modes

* [ ] **Infinite Loop Guard:** Malformed bytecode loops jumping backward indefinitely must be trapped by a maximum instruction cycle counter (e.g. 10,000,000 cycles per step call) yielding `STATUS_TIMEOUT`.
* [ ] **Invalid Jump Offset:** Any jump target pointing outside the `[0, bytecode.byteLength]` range must halt with `STATUS_ERR_INVALID_BYTECODE`.
* [ ] **Register Index Out-of-Bounds:** Register index $\ge 64$ must be rejected at compile time with `TooManyRegistersError`.
* [ ] **Sort Column Ceiling Exceeded:** Queries with $> 8$ sort keys must throw `TooManyOrderByColumnsError` at compile time.
* [ ] **Group By Column Ceiling Exceeded:** Queries with $> 8$ grouping keys must throw `TooManyGroupByColumnsError` at compile time.
* [ ] **Cursor Slot Exhaustion:** Opening more than 16 cursors in a single frame must throw `TooManyCursorsError` at compile time.
* [ ] **Subquery Nesting Overflow:** Correlated subquery nesting deeper than 7 levels (`ctx->depth` attempting to exceed 7) must throw `SubqueryNestingTooDeepError` at compile time.
* [ ] **Frame Depth Underflow:** `ctx->depth--` when already at 0 must halt with `STATUS_ERR_INVALID_BYTECODE` (guard against malformed subquery pop opcodes).
* [ ] **Zero-Length Text/Blob Emission:** Emitting empty strings `""` or 0-byte BLOBs must encode length 0 without corrupting buffer framing.
* [ ] **Ephemeral Cursor ID Collisions:** Ephemeral cursors must occupy distinct cursor indices from base table cursors ($0 \le \text{cursor} < 16$).
* [ ] **Divide by Zero in Expression Opcode:** `OP_DIV` and `OP_MOD` with divisor 0 must produce `NULL` (`type = 0`) instead of crashing or generating IEEE `Infinity`/`NaN`.
* [ ] **UDF Exception Propagation:** Exceptions thrown inside JS UDF callbacks must be caught by the Host bridge, setting `ctx->status = STATUS_ERROR` and reporting the JavaScript error stack to the caller.

---

## 10. Verification & Test Suite (`tests/vdbe_engine.test.ts`)

1. **3VL Register Comparisons:** Assert `NULL = NULL` and `NULL != NULL` do not trigger jump targets.
2. **Result Buffer Chunking:** Insert 2,000 rows; assert `STATUS_BUFFER_FULL` yields across multiple chunks and hydrates all 2,000 rows without loss or duplication.
3. **Page Fault Yield & Resume:** Simulate disk page miss midway through scan; inject page into cache; resume `vm_step()`; assert scan continues without missing rows.
4. **Arena Exhaustion:** Simulate pathological cardinality exceeding 16 MB; assert clean `QueryArenaExhaustedError` and $O(1)$ memory recovery.
5. **Expression & Function Evaluation:** Verify native `OP_STR_UPPER`, `OP_STR_LOWER`, `OP_MATH_FLOOR`, `OP_MATH_CEIL`, `OP_ADD`, `OP_MUL` across projection, `WHERE` filtering, and `ORDER BY`.
6. **Subquery Flattening:** Verify compiler generates a single-cursor scan for inlinable derived tables without `OP_OPEN_EPHEMERAL`.
7. **Ephemeral Subquery Execution:** Verify derived tables with `GROUP BY` correctly populate ephemeral cursor and stream outer query results.
8. **UDF Dispatch:** Assert `OP_CALL_UDF` correctly executes registered JavaScript functions and preserves 3VL semantics when passing NULL registers.
