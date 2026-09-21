# Phase 1 Technical Specification: Storage & Memory Architecture

## 1. Executive Summary & Purpose

This document defines the comprehensive, low-level technical specification for **Phase 1: Storage & Memory Architecture** of WebDB. It governs the binary layouts on disk, shared memory allocation within WebAssembly (`ArrayBuffer`), slotted 4KB page formats, dynamic row serialization, memory protection boundaries, and exhaustive verification suites.

The primary objective is to guarantee **absolute memory safety, deterministic execution, and zero data corruption** while maintaining an ultra-lean footprint (~150 KB Wasm / ~40 KB gzipped) and strict parity between:
- **V1 (JavaScript/TypeScript Reference Engine):** Implemented using direct `ArrayBuffer` pointer arithmetic and `DataView` with strict C-semantics.
- **V2 (C/WebAssembly Drop-In Engine):** Compiled with `clang --target=wasm32 -nostdlib` sharing the exact same byte structures and host JS orchestration.

---

## 2. Global Shared Memory Architecture (`WebAssembly.Memory`)

### 2.1 Allocation & Sizing Matrix
The engine operates entirely within a single flat `ArrayBuffer` provided by a `WebAssembly.Memory` instance. Memory is allocated once by the JavaScript Host upon database initialization:

```typescript
const memory = new WebAssembly.Memory({
  initial: 70,  // ~4.48 MB (for default 4 MB page cache)
  maximum: 320, // ~20.48 MB (ceiling including 16 MB max query arena)
});
```

#### Cache Size Configurations:
| Parameter | 2 MB Cache Option | 4 MB Cache (Default) | 8 MB Cache Option |
| :--- | :---: | :---: | :---: |
| **Slot Count (`slot_count`)** | 512 slots | 1,024 slots | 2,048 slots |
| **Page Slots Memory** | 2,097,152 bytes | 4,194,304 bytes | 8,388,608 bytes |
| **Initial Wasm Pages** | 38 Wasm pages (~2.4 MB) | 70 Wasm pages (~4.5 MB) | 134 Wasm pages (~8.6 MB) |
| **Max Wasm Pages** | 294 Wasm pages (~18.8 MB) | 320 Wasm pages (~20.5 MB) | 390 Wasm pages (~25.0 MB) |
| **Slot-to-Page Map Size** | 2,048 bytes (512 $\times$ 4B) | 4,096 bytes (1,024 $\times$ 4B) | 8,192 bytes (2,048 $\times$ 4B) |
| **Dirty Bitmask Size** | 64 bytes (512 / 8) | 128 bytes (1,024 / 8) | 256 bytes (2,048 / 8) |

---

### 2.2 Shared Memory Map (Default 4 MB Configuration)

```
Offset (Hex)          Size        Region Name                  Purpose
─────────────────────────────────────────────────────────────────────────────────────────────
0x000000 - 0x3FFFFF   4,194,304 B Slotted Page Cache Slots     1,024 rigid slots x 4096 bytes
0x400000 - 0x400FFF       4,096 B Slot-to-Page Map             uint32_t slot_to_page[1024]
0x401000 - 0x40107F         128 B Dirty Bitmask (`dirty_mask`) Dynamic bitmask (1 bit per slot)
0x401080 - 0x40127F         512 B `VmContext` Struct & Cursors Execution state + cursors[16]
0x401280 - 0x41127F      65,536 B Output Result Buffer         Chunked streaming row output (64KB)
0x411280 - 0x41927F      32,768 B Bytecode Scratchpad          Compiled query bytecode buffer (32KB)
0x419280 - 0x41FFFF      28,032 B Reserved Alignment Padding   Zero-filled alignment cushion
─────────────────────────────────────────────────────────────────────────────────────────────
0x420000 - 0x141FFFF  Up to 16 MB Transient Query Arena        Growable bump allocator for GROUP BY
                                                               hash tables and sort buffers
```

---

### 2.3 Memory Region Specifications

#### 1. Slotted Page Cache Slots (`0x000000..0x3FFFFF`)
- Divided into rigid 4096-byte blocks indexed from `0` to `slot_count - 1`.
- Slot $i$ starts at byte offset: $\text{slot\_offset} = i \times 4096$.
- Serves as the L1 in-memory cache for database pages loaded from persistent storage.

#### 2. Slot-to-Page Lookup Table (`0x400000..0x400FFF`)
- A flat array of `uint32_t` integers of length `slot_count`.
- `slot_to_page[i]`:
  - `0`: Slot $i$ is currently free/unallocated.
  - `> 0`: Contains the database `page_id` currently resident in slot $i$.
- Provides instant $O(1)$ bidirectional mapping between disk pages and memory slots.

#### 3. Dynamic Dirty Bitmask (`0x401000..0x40107F`)
- Sized to $\lceil\text{slot\_count} / 8\rceil$ bytes (128 bytes for 1,024 slots).
- **Bit Invariant:** When any engine write operation modifies bytes in slot $i$, bit $i$ is set:
  $$\text{byte\_idx} = i \gg 3, \quad \text{mask} = 1 \ll (i \ \& \ 7)$$
- Checked by the JS Cache Controller prior to LRU eviction to force WAL flushing.
- Cleared monotonically during checkpoint execution when pages are durably written to the main `.db` file.

#### 4. Execution State Struct (`VmContext`, `0x401080..0x40127F`)
- Fixed-offset C struct representing the single active query state machine:
```c
typedef struct {
    uint32_t page_id;      // Database Page ID currently focused
    uint16_t slot_idx;     // Cache slot index (0..1023) holding this page
    uint16_t cell_idx;     // Current slot directory index within the page
    uint16_t cell_offset;  // Byte offset of the active row payload within the page
    uint8_t  depth;        // B-tree traversal depth (0 = root/leaf)
    uint8_t  flags;        // Cursor status flags (0x1 = EOF, 0x2 = PINNED)
} Cursor;

typedef struct {
    uint32_t pc;            // Bytecode program counter
    uint32_t status;        // 0=RUNNING, 1=DONE, 2=PAGE_FAULT, 3=BUFFER_FULL, 4=ERROR
    uint32_t fault_page_id; // Missing page requested during PAGE_FAULT
    uint32_t result_count;  // Number of rows packed in current output chunk
    uint32_t result_offset; // Current write offset in Output Result Buffer
    uint32_t arena_offset;  // Current allocation offset in Transient Query Arena
    Cursor   cursors[16];   // Active cursors for multi-table joins & subqueries
} VmContext;
```

#### 5. Output Result Buffer (`0x401280..0x41127F`, 64 KB)
- Pipelined streaming buffer for query results.
- **Record Framing Format:**
  - `[uint16_t record_length]` (2 bytes)
  - `[uint8_t record_bytes[record_length]]`
- **Yield Invariant:** If adding a row requires $\text{result\_offset} + 2 + \text{row\_len} > 65,536$, the VM halts and yields `STATUS_BUFFER_FULL`. The JS Host hydrates the chunk into JS objects, resets $\text{result\_offset} = 0$, and resumes the VM.

#### 6. Transient Query Arena (`0x420000..Ceiling`, Up to 16 MB)
- Sized initially at 256 KB and grown dynamically in 64KB increments via `memory.grow()` up to the configurable ceiling (default 16 MB).
- Uses a pure **Bump Allocator** ($\text{arena\_offset} \mathrel{+}= \text{alloc\_size}$) for:
  - `GROUP BY` open-addressing hash tables.
  - Sort accumulation buffers for `ORDER BY`.
- **Fail-Fast OOM Invariant:** If $\text{arena\_offset} + \text{size} > \text{max\_query\_memory}$, the engine immediately yields `STATUS_ERR_ARENA_EXHAUSTED`. The JS Host throws `QueryArenaExhaustedError`. **Silent truncation or dropped aggregation buckets are strictly prohibited.**
- **Instant $O(1)$ Cleanup:** When a query completes or errors, resetting $\text{arena\_offset} = 0$ reclaims 100% of transient memory in 1 CPU instruction with zero memory fragmentation.

---

## 3. Buffer Pinning Invariant & Eviction Safety

To ensure that an asynchronous disk fetch never evicts a page currently needed by an active query:

### 3.1 The Pinning Invariant
> **Invariant:** A cache slot $S$ is **STRICTLY PINNED (immune to LRU/Clock eviction)** if:
> $$\exists \ c \in \text{VmContext.cursors}[0..15] \quad \text{such that} \quad c.\text{slot\_idx} == S \ \land \ c.\text{page\_id} \ne 0$$

### 3.2 Mathematical Guarantee of Eviction Headroom
- **Maximum Active Cursors:** 16 cursors.
- **Minimum Cache Slots:** 512 slots (2 MB cache).
- **Guaranteed Unpinned Slots:**
  $$\text{Available Eviction Slots} \ge \text{slot\_count} - 16 \ge 512 - 16 = 496 \text{ slots}$$
- **Zero-Deadlock Invariant:** The cache can **never deadlock or run out of eviction candidates**, because at least 496 slots are permanently unpinned and available for replacement.

### 3.3 Eviction Algorithm Flow
```
                     [Page Fault Triggered: Missing Page P]
                                       │
                                       ▼
                       Scan unpinned slots via LRU/Clock
                 (Skip any slot where slot == cursor[i].slot_idx)
                                       │
                                       ▼
                         Selected Candidate Slot: S
                                       │
                    Is dirty_mask bit S set (Slot S dirty)?
                                 /          \
                               YES          NO
                               /              \
             Flush Slot S to WAL               Discard clean slot
             Clear dirty_mask bit S
                               \              /
                                ▼            ▼
                   Async fetch Page P into Slot S from IVfsAdapter
                   Update slot_to_page[S] = P
                   Resume VmContext via vm_step()
```

---

## 4. Slotted Page Format (The 4096-Byte Invariant)

Every database page (Leaf Data, Internal B-Tree, Overflow) is strictly **4096 bytes**.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Page Header (12 Bytes):                                                │
│   [0]      uint8_t  page_type (0x0D = Leaf Data, 0x0A = Index Page)    │
│   [1]      uint8_t  reserved (0x00)                                    │
│   [2..3]   uint16_t cell_count (Number of active rows in page)         │
│   [4..5]   uint16_t cell_content_offset (Byte offset of lowest record) │
│   [6..9]   uint32_t next_page_id (Sequential scan link, or 0)          │
│   [10..11] uint16_t free_bytes (Fragmented uncompacted hole bytes)     │
├────────────────────────────────────────────────────────────────────────┤
│ Slot Directory (grows downward from offset 12):                        │
│   cell_offsets[0]: uint16_t                                            │
│   cell_offsets[1]: uint16_t                                            │
│   ...                                                                  │
│   cell_offsets[cell_count - 1]: uint16_t                               │
├────────────────────────────────────────────────────────────────────────┤
│                      <--- Free Space Area --->                         │
├────────────────────────────────────────────────────────────────────────┤
│ Cell Payloads (grows upward from byte 4096):                           │
│   Row N-1 ... Row 1 ... Row 0                                          │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Header Offsets & Field Definitions
- **`page_type` (1 byte, offset 0):** `0x0D` for Leaf Data Page, `0x0A` for Secondary Index Node, `0x00` for Free Page.
- **`reserved` (1 byte, offset 1):** Alignment padding.
- **`cell_count` (2 bytes, offset 2, Little-Endian):** Total number of row records stored on this page.
- **`cell_content_offset` (2 bytes, offset 4, Little-Endian):** Offset of the lowest row payload byte. On an empty page, this equals `4096`.
- **`next_page_id` (4 bytes, offset 6, Little-Endian):** Pointer to the next sequential leaf data page (enables linear scans without tree re-traversal).
- **`free_bytes` (2 bytes, offset 10, Little-Endian):** Tracks non-contiguous fragmented bytes left by deleted or updated rows.

### 4.2 Free Space & Insertion Rules
1. **Contiguous Free Space:**
   $$\text{contiguous\_free} = \text{cell\_content\_offset} - (12 + \text{cell\_count} \times 2)$$
2. **Total Free Space:**
   $$\text{total\_free} = \text{contiguous\_free} + \text{free\_bytes}$$
3. **Insertion Condition:** To insert a record of length $L$, the page must have:
   $$\text{contiguous\_free} \ge L + 2$$
4. **Defragmentation Trigger (On-Demand Page Compaction):**
   - If $\text{contiguous\_free} < L + 2$, but $\text{total\_free} \ge L + 2$:
   - The engine triggers an in-place **Page Compaction**:
     1. Allocates an ephemeral 4KB scratch buffer.
     2. Copies active row records contiguously to the bottom of the scratch page.
     3. Rewrites the slot directory offsets.
     4. Sets $\text{cell\_content\_offset} = 4096 - \sum L_i$ and $\text{free\_bytes} = 0$.
     5. Copies scratch bytes back to the target page.
   - The record is then inserted without requiring a page split.

---

## 5. Binary Row Format, Dynamic Null-Bitmap & Encodings

```
┌────────────┬──────────────────────────┬─────────────────────────┬─────────────────────────┬──────────────────────────┐
│ Flags (1B) │ Null-Bitmap (ceil(N/8)B) │ Fixed Slice (4B / 8B)   │ Var-Offset Table (4B/ea)│ Var Payloads (UTF-8/Blob)│
└────────────┴──────────────────────────┴─────────────────────────┴─────────────────────────┴──────────────────────────┘
```

### 5.1 Field Breakdown
1. **Row Header Flags (1 byte):**
   - `0x01`: Active Record.
   - `0x00`: Tombstone (Deleted Record).
2. **Dynamic Null-Bitmap ($\lceil\text{column\_count} / 8\rceil$ bytes):**
   - Sized dynamically based on table definition: `(col_count + 7) >> 3` bytes.
   - Bit $i$ set to `1` indicates column $i$ is `NULL`.
   - **Zero-Payload Storage Optimization:** If bit $i$ is `1`, **zero bytes** are reserved in the fixed-width slice, and variable-length offset table entries are set to length 0.
3. **Fixed-Width Column Slice:**
   - Predictable struct offsets determined at `CREATE TABLE` time:
     - `INT32`: 4 bytes (`int32_t`, Little-Endian).
     - `INT64`: 8 bytes (`int64_t`, Little-Endian).
     - `FLOAT64`: 8 bytes (`double`, IEEE 754 Little-Endian).
4. **Variable-Length Offset Table (4 bytes per TEXT/BLOB column):**
   - `uint16_t rel_offset`: Byte offset relative to row start.
   - `uint16_t length`: Byte length of payload.
5. **Variable Payloads:**
   - Raw UTF-8 string bytes (no null terminator needed; length-prefixed) or binary bytes.

---

### 5.2 Strict Overflow Protection: The 2048-Byte Boundary
- **Maximum Single Row Size:** **2048 bytes (2 KB)**.
- **Fail-Fast Error:** Any `INSERT` or `UPDATE` operation with serialized byte size $> 2048$ bytes **MUST throw an immediate explicit error**:
  ```typescript
  throw new RowSizeLimitExceededError(size, 2048);
  ```
- **Rationale:** Prevents rows from spanning multiple pages in V1, eliminating complex overflow chain pointer arithmetic while keeping B-tree balance code ultra-lean. **Silent truncation of user data is strictly prohibited.**

---

## 6. Page 1: File Header & Binary Master Table (Schema Catalog)

Page 1 is completely self-contained, allowing any database to be opened and inspected without external metadata files.

```
0x0000 - 0x0063 (Bytes 0..99):   Database File Header
0x0064 - 0x0FFF (Bytes 100..4095): Binary Master Table (Schema Catalog)
```

### 6.1 Database File Header (Bytes 0..99)
| Byte Offset | Field Name | Type | Description |
| :---: | :--- | :---: | :--- |
| `0..5` | `magic` | `char[6]` | Magic ASCII bytes: `"WEBDB\0"` (`0x57 0x45 0x42 0x44 0x42 0x00`) |
| `6..7` | `page_size` | `uint16_t` | Rigid page size: `4096` |
| `8..11` | `total_pages` | `uint32_t` | Total allocated pages in database file |
| `12..15` | `free_page_head` | `uint32_t` | First page ID in recycled free-page linked list (or 0) |
| `16..19` | `schema_version` | `uint32_t` | Incremented on every DDL change |
| `20..23` | `change_counter` | `uint32_t` | Incremented on every committed write transaction |
| `24..99` | `reserved` | `uint8_t[76]` | Zero-filled reserved space for future WAL checkpoints |

### 6.2 Binary Master Table Layout (Bytes 100..4095)
Supports up to 10 tables, each with up to 16 columns:
```c
typedef struct {
    uint8_t  type;          // 1=INT32, 2=INT64, 3=FLOAT64, 4=TEXT, 5=BLOB
    uint8_t  flags;         // 0x1=PRIMARY KEY, 0x2=NOT NULL, 0x4=INDEXED
    uint16_t col_offset;    // Column offset inside fixed data slice
    char     name[16];      // Column name (null-padded UTF-8)
} ColumnMeta;               // Size: 20 bytes

typedef struct {
    uint16_t table_id;      // Numeric table identifier (1..65535)
    uint16_t column_count;  // Number of columns in this table (1..16)
    uint32_t root_page_id;  // Table B+Tree root Page ID
    char     name[16];      // Table name (null-padded UTF-8)
    ColumnMeta columns[16]; // Fixed array of columns (16 * 20B = 320B)
} TableMeta;                // Size: 24 + 320 = 344 bytes
```
- **$O(1)$ Schema Dereference:** C reads schemas via direct struct pointer casting:
  ```c
  const TableMeta *tbl = (const TableMeta*)(page1_ptr + 100 + (table_idx * 344));
  ```
- Eliminates the need for SQL DDL parsers or JSON catalog files.

---

## 7. Dual First-Class Storage Engines: OPFS & IndexedDB (`IVfsAdapter`)

WebDB uses a unified abstraction layer where **both OPFS and IndexedDB are first-class engines**:

```typescript
export interface IVfsAdapter {
  readonly name: 'memory' | 'opfs' | 'idb';
  readonly isSynchronous: boolean;

  readPage(pageId: number): Promise<Uint8Array | null>;
  writePage(pageId: number, data: Uint8Array): Promise<void>;
  writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void>;
  flush(): Promise<void>;
  truncate(pageCount: number): Promise<void>;
  close(): Promise<void>;
}
```

### 7.1 Backend Characteristics:
1. **OPFS (`FileSystemSyncAccessHandle`):**
   - High-throughput direct block I/O.
   - Synchronous read/write access in Web Workers.
   - Requires exclusive lock per file origin.
2. **IndexedDB (`IndexedDbVfsAdapter`):**
   - Universal context compatibility: runs on Main Thread, Dedicated Workers, SharedWorkers, ServiceWorkers, and mobile WebViews.
   - No cross-origin isolation (COOP / COEP) requirement.
   - 4KB pages stored in an Object Store (`pages`) keyed by numeric `pageId`.
   - `writePages()` commits all dirty slots in a single `readwrite` transaction.

---

## 8. Exhaustive Edge Cases & Memory Safety Checklist

### A. Memory Bounds & Pointer Arithmetic
* [ ] **Unchecked ArrayBuffer OOB:** Every memory access must validate that `offset + size <= buffer.byteLength`.
* [ ] **Unaligned Byte Access:** All multi-byte values (`uint16_t`, `uint32_t`, `double`) must specify `true` for Little-Endian.
* [ ] **Zero-Slot Eviction Headroom:** Cache controller must guarantee that at least 16 slots are pinned, leaving $\ge 496$ unpinned eviction slots.
* [ ] **Double Free / Double Eviction:** Once a dirty slot is marked for eviction, its dirty bit must be cleared atomically upon WAL flush before slot reuse.

### B. Slotted Page Integrity
* [ ] **Slot Directory Colliding with Payload:** `cell_content_offset` cannot decrement below `12 + (cell_count * 2)`. Attempting to insert into a full page must return `-1` and trigger page allocation.
* [ ] **Corrupted Slot Pointer:** Any slot directory pointer pointing to $< 12$ or $> 4096$ must trigger an immediate `CorruptPageError`.
* [ ] **Defragmentation Free Space Calculation:** Assert that `free_bytes` accurately tracks deleted hole space and compaction reclaims 100% of contiguous free space.

### C. Row Record & Constraint Fail-Fasts
* [ ] **Exact 2048-Byte Boundary:** Inserting a row of exactly 2048 bytes succeeds; inserting 2049 bytes throws `RowSizeLimitExceededError`.
* [ ] **`NOT NULL` Constraint Violation:** Inserting `null` or `undefined` into a `NOT NULL` column immediately throws `NotNullConstraintError`.
* [ ] **Dynamic Null-Bitmap Alignment:** Verify bitwise null-checking for tables with 1, 8, 9, 16, 17, and 32 columns without offset drift.

### D. Transient Query Arena Protection
* [ ] **Arena Ceiling Exhaustion:** Verify that pathological `GROUP BY` operations reaching the 16 MB ceiling yield `STATUS_ERR_ARENA_EXHAUSTED` and throw `QueryArenaExhaustedError`.
* [ ] **Zero-Leak Reset:** Verify that `arena_offset = 0` reclaims 100% of allocated memory without heap retention.

---

## 9. Comprehensive Test Suite Specification

The test suite in `tests/` must enforce 100% pass coverage on these critical memory behaviors:

### Test Suite 1: Slotted Page & Memory Geometry (`tests/page_geometry.test.ts`)
1. **Empty Page Initialization:** Page 1 header bytes, leaf data page headers, cell count 0, content offset 4096.
2. **Sequential Fill & Split Trigger:** Insert rows until page free space reaches $< \text{record\_size} + 2$; assert return `-1`.
3. **Defragmentation & In-Place Compaction:**
   - Insert 5 rows of 400 bytes each (2000 bytes).
   - Delete row 1 and row 3 (creating 800 bytes of non-contiguous holes).
   - Insert a new row of 600 bytes.
   - Assert compaction runs, defragments the page, and inserts the row without error.
4. **Boundary Limit (2048 Bytes):** Assert exactly 2048 bytes passes; 2049 bytes throws `RowSizeLimitExceededError`.

### Test Suite 2: Schema Catalog & Page 1 Binary Structs (`tests/catalog_binary.test.ts`)
1. **Magic Bytes Validation:** Corrupt byte 0; assert file open throws `InvalidDatabaseError`.
2. **Schema Persistence:** Add 5 tables with varying column types; close and reopen database; assert exact bit-level struct reconstruction.
3. **Schema Version Increment:** Assert every table creation increments `schema_version` on Page 1.

### Test Suite 3: Buffer Pinning & LRU Eviction Simulation (`tests/cache_pinning.test.ts`)
1. **Pinning Immunity:** Fill all cache slots; pin slots `[0, 5, 12]` with active cursors; simulate 500 page-fault evictions; assert pinned slots are never evicted.
2. **Dirty Mask Synchronization:** Mutate slot $i$; assert bit $i$ in `dirty_mask` is set; flush slot; assert bit $i$ is cleared.

### Test Suite 4: SQLite 3VL NULL & Data Type Serialization (`tests/nulls_encoding.test.ts`)
1. **Zero-Byte NULL Storage:** Measure raw byte sizes of records; assert rows with `NULL` columns occupy strictly fewer bytes than non-null rows.
2. **Type Range Safety:** Test min/max boundaries for `INT32` ($-2^{31}$ to $2^{31}-1$), `INT64`, and `FLOAT64`.
3. **Empty vs. NULL Text:** Verify empty string `""` (length 0, non-null) is distinguished from `NULL`.
