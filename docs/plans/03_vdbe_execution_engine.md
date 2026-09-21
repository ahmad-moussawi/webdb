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

| Opcode Name | Byte (`uint8`) | Operands | Description & Behavior |
| :--- | :---: | :--- | :--- |
| **`OP_HALT`** | `0x00` | None | Sets `ctx->status = STATUS_DONE` and terminates `vm_step()`. |
| **`OP_OPEN_CURSOR`** | `0x01` | `cursor: uint8`, `root_page: uint32` | Binds cursor slot to root Page ID; resets cell index to 0. |
| **`OP_REWIND`** | `0x02` | `cursor: uint8`, `jump_target: uint16` | Positions cursor at first row of page; if page is empty, jumps to `jump_target`. |
| **`OP_NEXT_ROW`** | `0x03` | `cursor: uint8`, `jump_target: uint16` | Advances `cell_idx`; if end of page, follows `next_page_id`; if EOF, jumps to `jump_target`. |
| **`OP_COLUMN_INT`** | `0x04` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 32-bit/64-bit integer from current row into `r[reg]`; if null, marks `r[reg] = NULL`. |
| **`OP_COLUMN_FLOAT`** | `0x05` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads 64-bit float from current row into `r[reg]`; if null, marks `r[reg] = NULL`. |
| **`OP_COLUMN_TEXT`** | `0x06` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads string pointer & length from var-table into `r[reg]`. |
| **`OP_COLUMN_BLOB`** | `0x07` | `cursor: uint8`, `col: uint8`, `reg: uint8` | Reads byte slice & length from var-table into `r[reg]`. |
| **`OP_IS_NULL`** | `0x10` | `cursor: uint8`, `col: uint8`, `jump_target: uint16` | Inspects Null-Bitmap bit; jumps to `jump_target` if set. |
| **`OP_IS_NOT_NULL`** | `0x11` | `cursor: uint8`, `col: uint8`, `jump_target: uint16` | Inspects Null-Bitmap bit; jumps to `jump_target` if clear. |
| **`OP_EQ`** | `0x12` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | If `r[A] == r[B]` (both non-null), jumps to `jump_target`. |
| **`OP_NE`** | `0x13` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | If `r[A] != r[B]` (both non-null), jumps to `jump_target`. |
| **`OP_GT`** | `0x14` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | If `r[A] > r[B]` (both non-null), jumps to `jump_target`. |
| **`OP_GE`** | `0x15` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | If `r[A] >= r[B]` (both non-null), jumps to `jump_target`. |
| **`OP_LT`** | `0x16` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | If `r[A] < r[B]` (both non-null), jumps to `jump_target`. |
| **`OP_LE`** | `0x17` | `regA: uint8`, `regB: uint8`, `jump_target: uint16` | If `r[A] <= r[B]` (both non-null), jumps to `jump_target`. |
| **`OP_JUMP`** | `0x19` | `jump_target: uint16` | Unconditional jump to bytecode address `jump_target`. |
| **`OP_LOAD_INT`** | `0x1F` | `reg: uint8`, `val: int32` | Loads literal 32-bit signed integer into `r[reg]`. |
| **`OP_LOAD_FLOAT`** | `0x20` | `reg: uint8`, `val: float64` | Loads literal 64-bit IEEE 754 float into `r[reg]`. |
| **`OP_LOAD_TEXT`** | `0x21` | `reg: uint8`, `len: uint16`, `bytes: [len]` | Loads literal UTF-8 string into `r[reg]`. |
| **`OP_LOAD_NULL`** | `0x22` | `reg: uint8` | Sets `r[reg] = NULL`. |
| **`OP_EMIT_ROW`** | `0x14` | `cursor: uint8` | Copies row bytes into Output Result Buffer; yields `STATUS_BUFFER_FULL` if capacity exceeded. |
| **`OP_CALL_UDF`** | `0x28` | `udf_id: uint16`, `arg_reg: uint8`, `out_reg: uint8` | Dispatches registered JS function synchronously. |

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

## 5. Transient Query Arena & Growable Hash Tables

For complex queries requiring aggregations (`GROUP BY`) or sorting:
1. **Initial Allocation:** 256 KB.
2. **Open-Addressing Hash Table:** Hash tables start at 1,024 buckets and automatically double capacity when reaching a **70% load factor**.
3. **Hard Ceiling (Fail-Fast OOM):** Capped at 16 MB. If an unindexed `GROUP BY` with high cardinality exceeds 16 MB:
   - Engine halts immediately and yields `STATUS_ERR_ARENA_EXHAUSTED`.
   - Host JS resets `arena_offset = 0` and rejects the query Promise with `QueryArenaExhaustedError`.
4. **Stream Aggregation Optimization:** If grouping by an indexed column, the compiler emits a streaming loop, processing unlimited rows in $O(1)$ memory without allocating a hash table.

---

## 6. Exhaustive Edge Cases & Failure Modes

* [ ] **Infinite Loop Guard:** Malformed bytecode loops jumping backward indefinitely must be trapped by a maximum instruction cycle counter (e.g. 10,000,000 cycles per step call) yielding `STATUS_TIMEOUT`.
* [ ] **Invalid Jump Offset:** Any jump target pointing outside the `[0, bytecode.byteLength]` range must halt with `STATUS_ERR_INVALID_BYTECODE`.
* [ ] **Register Index Out-of-Bounds:** Register index $\ge 16$ must be rejected at compile time.
* [ ] **Zero-Length Text/Blob Emission:** Emitting empty strings `""` or 0-byte BLOBs must encode length 0 without corrupting buffer framing.

---

## 7. Verification & Test Suite (`tests/vdbe_engine.test.ts`)

1. **3VL Register Comparisons:** Assert `NULL = NULL` and `NULL != NULL` do not trigger jump targets.
2. **Result Buffer Chunking:** Insert 2,000 rows; assert `STATUS_BUFFER_FULL` yields across multiple chunks and hydrates all 2,000 rows without loss or duplication.
3. **Page Fault Yield & Resume:** Simulate disk page miss midway through scan; inject page into cache; resume `vm_step()`; assert scan continues without missing rows.
4. **Arena Exhaustion:** Simulate pathological cardinality exceeding 16 MB; assert clean `QueryArenaExhaustedError` and $O(1)$ memory recovery.
