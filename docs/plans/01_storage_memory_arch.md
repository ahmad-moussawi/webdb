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
  maximum: 320, // ~20.48 MB (default ceiling: 4MB cache + 16MB arena; adapts dynamically to maxQueryMemory)
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
0x419280 - 0x41A27F       4,096 B Page Scratchpad (`page_scratchpad`) Dedicated 4KB staging buffer for page compaction & node splits
0x41A280 - 0x41FFFF      23,936 B Reserved Alignment Padding   Zero-filled alignment cushion
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

#### 4. Execution State Struct (`VmContext`, `0x401080..0x40127F`, 512 Bytes)
- Fixed-offset C struct representing the single active query state machine:
```c
typedef struct {
    uint8_t  type;        // 0=NULL, 1=INT32, 2=INT64, 3=FLOAT64, 4=TEXT, 5=BLOB, 6=UUID, 7=ULID
    uint8_t  flags;       // Reserved flags (e.g. 0x1 = CONSTANT/LITERAL)
    uint16_t len;         // Byte length for TEXT and BLOB payloads (16 for UUID/ULID)
    uint32_t str_offset;  // Byte offset in shared memory (page or arena) for text/blob/uuid/ulid
    union {
        int32_t  i32;     // 32-bit signed integer
        int64_t  i64;     // 64-bit signed integer
        double   f64;     // 64-bit IEEE 754 float
    } val;                // 8 bytes (8-byte aligned)
} Register;               // Exact size: 16 bytes

typedef struct {
    uint32_t page_id;      // Database Page ID currently focused
    uint16_t slot_idx;     // Cache slot index (0..1023) holding this page
    uint16_t cell_idx;     // Current slot directory index within the page
    uint16_t cell_offset;  // Byte offset of the active row payload within the page
    uint8_t  depth;        // B-tree traversal depth (0 = root/leaf)
    uint8_t  flags;        // Cursor status flags (0x1 = EOF, 0x2 = PINNED)
} Cursor;                  // Exact size: 12 bytes

typedef struct {
    uint32_t pc;            // Bytecode program counter (offset 0)
    uint32_t status;        // 0=RUNNING, 1=DONE, 2=PAGE_FAULT, 3=BUFFER_FULL, 4=ERROR (offset 4)
    uint32_t fault_page_id; // Missing page requested during PAGE_FAULT (offset 8)
    uint32_t result_count;  // Number of rows packed in current output chunk (offset 12)
    uint32_t result_offset; // Current write offset in Output Result Buffer (offset 16)
    uint32_t arena_offset;  // Current allocation offset in Transient Query Arena (offset 20)
    Cursor   cursors[16];   // Active cursors for multi-table joins & subqueries (offset 24..215, 192 bytes)
    Register registers[16]; // Scalar comparison and expression registers (offset 216..471, 256 bytes)
    uint32_t rows_affected; // Number of mutated/deleted rows for DML operations (offset 472..475)
    uint8_t  reserved[36];  // Alignment padding to 512 bytes (offset 476..511)
} VmContext;                // Exact size: 512 bytes
```

#### 5. Output Result Buffer (`0x401280..0x41127F`, 64 KB)
- Pipelined streaming buffer for query results.
- **Record Framing Format:**
  - `[uint16_t record_length]` (2 bytes)
  - `[uint8_t record_bytes[record_length]]`
- **Yield Invariant:** If adding a row requires $\text{result\_offset} + 2 + \text{row\_len} > 65,536$, the VM halts and yields `STATUS_BUFFER_FULL`. The JS Host hydrates the chunk into JS objects, resets $\text{result\_offset} = 0$, and resumes the VM.

#### 6. Bytecode Scratchpad (`0x411280..0x41927F`, 32 KB)
- Dedicated execution buffer where compiled binary query bytecode instructions are loaded by the Host Compiler before calling `vm_step()`.
- Maximum query bytecode program size is strictly capped at **32 KB**.

#### 7. Page Scratchpad (`0x419280..0x41A27F`, 4,096 Bytes)
- Pre-allocated 4KB staging buffer dedicated exclusively to the storage engine for **in-place page compaction/defragmentation** and **B+Tree internal/leaf node splitting**.
- **Zero-Allocation Invariant:** Guarantees that page restructuring never triggers dynamic heap allocations (`malloc`, `new Uint8Array(4096)`), upholding Rule 1 of `06_c_style_rules_v1.md`.
- **Isolation Guarantee:** Operates entirely outside the active Bytecode Scratchpad (`0x411280`), Result Buffer (`0x401280`), and Transient Query Arena (`0x420000`).

#### 8. Transient Query Arena (`0x420000..Ceiling`, Default 16 MB, Configurable)
- Sized initially at 256 KB and grown dynamically in 64KB increments via `memory.grow()` up to the configurable ceiling (default 16 MB, configurable via `maxQueryMemory` up to 2 GB in Wasm32).
- Uses a pure **Bump Allocator** ($\text{arena\_offset} \mathrel{+}= \text{alloc\_size}$) for:
  - `GROUP BY` open-addressing hash tables (`AggBucket[]` 40-byte buckets and packed grouping keys up to 8 columns maximum).
  - Sort accumulation buffers for unindexed multi-column `ORDER BY` (`SorterEntry[]` array and packed sort keys up to 8 columns maximum).
- **Fail-Fast OOM Invariant:** If $\text{arena\_offset} + \text{size} > \text{max\_query\_memory}$, the engine immediately yields `STATUS_ERR_ARENA_EXHAUSTED`. The JS Host throws `QueryArenaExhaustedError`. **Silent truncation or dropped aggregation buckets/sort rows are strictly prohibited.**
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
│ Page Header (16 Bytes):                                                │
│   [0]      uint8_t  page_type (0x0D = Leaf Data, 0x0A = Index Page)    │
│   [1]      uint8_t  reserved (0x00)                                    │
│   [2..3]   uint16_t cell_count (Number of active rows in page)         │
│   [4..5]   uint16_t cell_content_offset (Byte offset of lowest record) │
│   [6..9]   uint32_t next_page_id (Sequential scan link, or 0)          │
│   [10..11] uint16_t free_bytes (Fragmented uncompacted hole bytes)     │
│   [12..15] uint32_t checksum (CRC32 IEEE 802.3 of full 4KB page)       │
├────────────────────────────────────────────────────────────────────────┤
│ Slot Directory (grows downward from offset 16):                        │
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
- **`page_type` (1 byte, offset 0):**
  - `0x0D`: Table B+Tree Leaf Page (Row Data).
  - `0x05`: Table B+Tree Interior Page (Integer `rowid` Routing).
  - `0x0A`: Secondary Index B-Tree Leaf Page (Sorted Index Tuples).
  - `0x02`: Secondary Index B-Tree Interior Page (Index Routing).
  - `0x00`: Free / Recycled Page.
- **`reserved` (1 byte, offset 1):** Alignment padding (0x00).
- **`cell_count` (2 bytes, offset 2, Little-Endian):** Total number of row records or routing cells stored on this page.
- **`cell_content_offset` (2 bytes, offset 4, Little-Endian):** Byte offset of the lowest cell payload. On an empty page, this equals `4096`.
- **`next_page_id / right_child_page_id` (4 bytes, offset 6, Little-Endian):**
  - *For Leaf Pages (`0x0D`, `0x0A`):* `next_page_id` pointer to the next sequential leaf sibling (enables linear scans without tree re-traversal).
  - *For Interior Pages (`0x05`, `0x02`):* `right_child_page_id` pointer to the rightmost child subtree (where keys $>$ all keys on this page).
  - *For Free Pages (`0x00`):* `next_free_page_id` pointer to the next page in the recycled LIFO free list.
- **`free_bytes` (2 bytes, offset 10, Little-Endian):** Tracks non-contiguous fragmented bytes left by deleted or updated rows.
- **`checksum` (4 bytes, offset 12, Little-Endian):** CRC32 (IEEE 802.3 polynomial `0xEDB88320`) checksum of the entire 4096-byte page. Computed with bytes `12..15` zeroed out.

### 4.2 Free Space & Insertion Rules
1. **Contiguous Free Space:**
   $$\text{contiguous\_free} = \text{cell\_content\_offset} - (16 + \text{cell\_count} \times 2)$$
2. **Total Free Space:**
   $$\text{total\_free} = \text{contiguous\_free} + \text{free\_bytes}$$
3. **Insertion Condition:** To insert a record of length $L$, the page must have:
   $$\text{contiguous\_free} \ge L + 2$$
4. **Defragmentation Trigger (On-Demand Page Compaction):**
   - If $\text{contiguous\_free} < L + 2$, but $\text{total\_free} \ge L + 2$:
   - The engine triggers an in-place **Page Compaction**:
     1. Uses the pre-allocated 4KB **Page Scratchpad** (`0x419280..0x41A27F`) in shared memory (zero dynamic heap allocation).
     2. Copies active row records contiguously to the bottom of the scratchpad page.
     3. Rewrites the slot directory offsets starting at offset 16.
     4. Sets $\text{cell\_content\_offset} = 4096 - \sum L_i$ and $\text{free\_bytes} = 0$.
     5. Copies the compacted 4096 bytes back to the target page slot.
   - The record is then inserted without requiring a page split.

### 4.3 Page-Level CRC32 Checksum Lifecycle & Torn-Write Protection
Data integrity in browser storage engines (OPFS, IndexedDB) requires strict verification against torn writes, incomplete flushes, and storage bit rot.

* **Algorithm:** CRC32 IEEE 802.3 standard (`0xEDB88320` polynomial), calculated across the full 4096 bytes.
* **In-Memory Write Performance:** While pages reside in the in-memory cache and mutate during active transactions, checksums are **not computed on every row modification**. The page slot is simply flagged in `dirty_mask`.
* **Serialize / Flush Pipeline (On Disk Write):**
  1. The page header `checksum` field (`bytes 12..15`) is cleared to `0x00000000`.
  2. CRC32 is calculated across all 4096 bytes of the page.
  3. The resulting 32-bit unsigned integer is written to `bytes 12..15` in little-endian order.
  4. The serialized 4096-byte buffer is passed to `IVfsAdapter.writePage()` or WAL append.
* **Deserialize / Fetch Pipeline (On Disk Read):**
  1. The 4096-byte page is retrieved from `IVfsAdapter.readPage()`.
  2. The stored checksum at `bytes 12..15` is extracted.
  3. `bytes 12..15` are temporarily zeroed out in memory.
  4. CRC32 is computed across the 4096-byte buffer.
  5. If `computedChecksum !== storedChecksum`:
     - The engine immediately throws `CorruptPageError(pageId, storedChecksum, computedChecksum)`.
     - Eviction, query processing, and recovery halt immediately, preventing silent corruption propagation.

### 4.4 Row Deletion & Slot Directory Shift (`memmove`)
When a row at index `cell_idx` is deleted:
1. **Extract Row Geometry:** Read the target row's length $L$ from its row header and variable-length offset table.
2. **Shift Slot Directory:** Remove the 2-byte slot entry at offset `16 + (cell_idx * 2)` and shift all subsequent slot directory entries left by 2 bytes using an in-memory `memmove`:
   $$\text{src} = 16 + (\text{cell\_idx} + 1) \times 2, \quad \text{dst} = 16 + \text{cell\_idx} \times 2, \quad \text{length} = (\text{cell\_count} - 1 - \text{cell\_idx}) \times 2$$
3. **Update Header Counts:**
   - Decrement `cell_count--`.
   - Record the vacated payload bytes as an uncompacted fragmentation hole:
     $$\text{free\_bytes} \mathrel{+}= L$$
   - The 2 bytes freed in the slot directory immediately expand $\text{contiguous\_free}$.
4. **Physical Page WAL Isolation:** Because WebDB uses physical 4KB page logging, intra-page byte shifts are completely transparent to the WAL. On transaction commit, the entire 4KB page is written to `.wal` with its updated CRC32 checksum. No logical delta logging is required.
5. **Decoupled Foreign Keys & Secondary Indexes:**
   - Foreign keys reference logical Primary Keys (e.g. `user_id = 42`), **never** physical slot addresses.
   - Secondary indexes store `(indexed_column_value, primary_key)`.
   - Shifting slot directory entries leaves logical Primary Keys unchanged, preserving 100% foreign key and secondary index integrity.
6. **Active Cursor Invariant:** If an active query cursor deletes the row currently under focus (`DELETE WHERE CURRENT OF`), subsequent slot entries slide left into `cell_idx`. The cursor preserves its current `cell_idx` so the next call to `OP_NEXT_ROW` naturally evaluates the next row without skipping.

### 4.5 Row Update Lifecycle & Expansion Mechanics (3 Scenarios)
Updating an existing row from length $L_{\text{old}}$ to $L_{\text{new}}$ follows a deterministic 3-case taxonomy:

* **Scenario A: Same-Size or Shrinking Update ($L_{\text{new}} \le L_{\text{old}}$):**
  - The updated record is written directly into the existing byte offset.
  - If $L_{\text{new}} < L_{\text{old}}$, the remaining bytes are abandoned as a hole:
    $$\text{free\_bytes} \mathrel{+}= (L_{\text{old}} - L_{\text{new}})$$
* **Scenario B: Expanding Update Fitting on Current Page ($L_{\text{new}} > L_{\text{old}}$ and $\text{total\_free} \ge L_{\text{new}} - L_{\text{old}}$):**
  - The old record space is marked as a hole: $\text{free\_bytes} \mathrel{+}= L_{\text{old}}$.
  - If $\text{contiguous\_free} < L_{\text{new}}$, trigger an **In-Place Page Compaction** (Section 4.2), which reclaims all holes including the abandoned old record.
  - Allocate the new record from contiguous free space at $\text{cell\_content\_offset} - L_{\text{new}}$.
  - Update `cell_offsets[cell_idx]` to point to the new byte offset.
* **Scenario C: Expanding Update Exceeding Page Capacity ($\text{total\_free} < L_{\text{new}} - L_{\text{old}}$):**
  - Because no single row may exceed 2048 bytes (`RowSizeLimitExceededError`), the updated row is guaranteed to fit on a 4KB page.
  - **In B-Tree Tables (Phase 2):** Triggers an automatic **B-Tree Leaf Split**. The page splits into two 4KB sibling pages (half the rows move to a newly allocated or recycled page). The updated row is then inserted into its proper sorted location.
  - **In Sequential Tables (Prototype / V1):** The old row is deleted from the current page (triggering slot `memmove`), and the enlarged row is inserted onto another data page with sufficient free capacity.

### 4.6 Empty Page De-allocation & Recycling Protocol (`free_page_head`)
When all rows on a data page are deleted (`cell_count == 0`):

1. **Unlink from Sibling Chain:**
   - The preceding page's `next_page_id` is updated to point to the deleted page's `next_page_id`.
2. **Convert to Free Page (LIFO Free List Push):**
   - The page header is reformatted as a Free Page (see §4.7.5 for full binary layout):
     - `page_type = 0x00` (Free Page, byte offset 0).
     - `next_free_page_id = Page1.free_page_head` (stored at **byte offset 6..9**, chains the previous free list head).
     - `cell_count = 0` (bytes 2..3), `cell_content_offset = 0` (bytes 4..5), `free_bytes = 0` (bytes 10..11).
     - Bytes 16..4095 are zeroed out (or left discarded).
     - Computes CRC32 checksum across the 4096 bytes and writes to bytes 12..15.
   - Page 1 header is updated:
     - `Page1.free_page_head = page_id` (bytes 16..19).
     - `Page1.change_counter++` (bytes 24..27).
   - Both the reclaimed page and Page 1 are marked dirty in `dirty_mask`.
3. **Reclaim on Allocation (LIFO Free List Pop):**
   - When an `INSERT` or B-Tree split requires a new page:
     - If `Page1.free_page_head > 0`:
       - Fetch page at `page_id = Page1.free_page_head`.
       - Assert `page_type == 0x00` (fail-fast on corruption).
       - Read its `next_free_page_id` pointer from **byte offset 6..9**.
       - Set `Page1.free_page_head = popped_page.next_free_page_id`.
       - Re-initialize the popped page as target type (`page_type = 0x0D`, `cell_content_offset = 4096`, etc.).
       - Reuses the page immediately **without increasing total database file size**.
     - Else:
       - Increment `Page1.total_pages++` and allocate a new page at the end of the file.

### 4.7 Complete B+Tree Hierarchy: Interior Nodes & Secondary Index Formats

WebDB implements a strict B+Tree separation: **Table B+Trees** store row data exclusively in leaves (`0x0D`) and use fixed-width integer routing nodes (`0x05`); **Secondary Index B-Trees** store `(indexed_value, rowid)` in index leaves (`0x0A`) and index interior nodes (`0x02`).

#### 4.7.1 Table Interior Page (`page_type = 0x05`)
Table internal nodes route traversal by 64-bit integer `rowid`. All cells are fixed-width 12-byte structs:

```c
typedef struct {
    uint32_t child_page_id; // Pointer to child page where all keys <= rowid (bytes 0..3)
    int64_t  rowid;         // 64-bit routing separator key (bytes 4..11)
} TableInteriorCell;        // Exact size: 12 bytes
```

* **Header Layout:** Uses the standard 16-byte header with `page_type = 0x05`. Header bytes `6..9` store `right_child_page_id` (pointer to child subtree containing keys $> \text{all keys on this page}$).
* **Slot Directory:** Sized at `cell_count * 2` bytes starting at offset 16, pointing to the 12-byte cell payloads packed at the bottom of the page.
* **Capacity & Fan-Out Calculation:**
  $$\text{Bytes per interior entry} = 12 \text{ bytes (payload)} + 2 \text{ bytes (slot)} = 14 \text{ bytes}$$
  $$\text{Max entries per 4KB page} = \left\lfloor \frac{4096 - 16 \text{ (header)}}{14} \right\rfloor = \mathbf{291 \text{ child pointers}}$$
* **Binary Search Traversal Algorithm:**
  To route a seek for `target_rowid`:
  1. Binary search the 2-byte slot directory on `cell.rowid` in $O(\log K)$ ($K \le 291$, at most 8 iterations).
  2. Find the first cell $i$ where $\text{target\_rowid} \le \text{cell}[i].\text{rowid}$.
  3. If found, traverse to $\text{cell}[i].\text{child\_page\_id}$.
  4. If $\text{target\_rowid} > \text{cell}[\text{last}].\text{rowid}$, traverse to `right_child_page_id` from header bytes `6..9`.

#### 4.7.2 Secondary Index Leaf Page (`page_type = 0x0A`)
Secondary indexes map column values to table `rowid`s. Because indexed values can be variable-length `TEXT` or `BLOB`, index leaves use the **slotted page architecture**:

* **Index Leaf Cell Format:**
  ```c
  // Packed binary cell inside page
  typedef struct {
      uint16_t key_len;           // Length of indexed column payload (2 bytes)
      uint8_t  key_data[key_len]; // Serialized value (4B INT32, 8B FLOAT64, UTF-8 string, etc.)
      int64_t  rowid;             // Matching table rowid (8 bytes, Little-Endian)
  } IndexLeafCell;
  ```
* **Ordering & Collation Invariant:**
  - The slot directory offsets are kept strictly sorted in ascending order of `(key_data, rowid)` following SQLite collation precedence:
    $$\text{NULL} < -\infty < \text{Numbers (INT/FLOAT)} < \text{TEXT (UTF-8)} < \text{BLOB}$$
  - For duplicate key values, cells are sub-sorted by `rowid` ascending, ensuring total deterministic ordering and $O(\log N)$ binary search.
* **Sequential Index Scans:** Header bytes `6..9` store `next_page_id`, linking index leaf siblings for $O(1)$ range scans (`WHERE age >= 21 AND age <= 65`).

#### 4.7.3 Secondary Index Interior Page (`page_type = 0x02`)
Routes traversal through the secondary index tree:
* **Index Interior Cell Format:**
  ```c
  typedef struct {
      uint32_t child_page_id;     // Pointer to child page with tuples <= this key (4 bytes)
      uint16_t key_len;           // Length of indexed column payload (2 bytes)
      uint8_t  key_data[key_len]; // Serialized separator key value
      int64_t  rowid;             // 8-byte rowid tie-breaker
  } IndexInteriorCell;
  ```
* Header bytes `6..9` store `right_child_page_id`.

#### 4.7.4 Internal Node Split & Promotion Protocol
When an internal page (Table Interior `0x05` or Index Interior `0x02`) runs out of free space:
1. **Allocate Sibling:** A new 4KB page $P_{\text{new}}$ is allocated from `Page1.free_page_head` (or file growth).
2. **Median Selection & Cell Distribution:**
   - For Table Interior (`0x05`), the median entry is entry index 145.
   - Entries $0..144$ remain on the existing page $P_{\text{left}}$.
   - Entries $146..290$ move to the new sibling page $P_{\text{right}}$.
3. **Median Key Promotion:**
   - Entry 145's `rowid` is promoted to the parent internal page with its child pointer set to $P_{\text{right}}$.
   - Entry 145's `child_page_id` becomes the new `right_child_page_id` of $P_{\text{left}}$.
4. **Root Node Split (Tree Height Expansion):**
   - If the root page splits, a new root page is allocated (or the old root is copied to a child and the root page re-initialized as an interior node).
   - The root points to $P_{\text{left}}$ and $P_{\text{right}}$ with the promoted median key. Tree height increments by 1.

#### 4.7.5 Free / Recycled Page On-Disk Binary Format (`page_type = 0x00`)
When a page is de-allocated (e.g. after row deletion drops `cell_count` to 0 or a table is dropped), it is formatted as a `FreePage` and linked into the singly linked LIFO freelist headed by `Page1.free_page_head`.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Free Page Header (16 Bytes, 0x0000 - 0x000F)                           │
│   Byte 0: page_type = 0x00 (PAGE_TYPE_FREE)                            │
│   Byte 1: reserved = 0x00                                              │
│   Bytes 2..3: reserved = 0x0000 (was cell_count)                       │
│   Bytes 4..5: reserved = 0x0000 (was cell_content_offset)              │
│   Bytes 6..9: next_free_page_id (uint32_t LE)                          │
│   Bytes 10..11: reserved = 0x0000 (was free_bytes)                     │
│   Bytes 12..15: checksum (uint32_t LE CRC32 across 4096 bytes)         │
├────────────────────────────────────────────────────────────────────────┤
│ Discarded Payload Area (4080 Bytes, 0x0010 - 0x0FFF)                   │
│   Unused / zero-filled discarded bytes                                 │
└────────────────────────────────────────────────────────────────────────┘
```

##### Header Field Definitions & Offsets
| Byte Offset | Field Name | Type | Value / Description |
| :---: | :--- | :---: | :--- |
| `0..0` | `page_type` | `uint8_t` | `0x00` (`PAGE_TYPE_FREE`). |
| `1..1` | `reserved1` | `uint8_t` | `0x00` (Alignment padding). |
| `2..3` | `reserved2` | `uint16_t` | `0x0000` (Zeroed). |
| `4..5` | `reserved3` | `uint16_t` | `0x0000` (Zeroed). |
| **`6..9`** | **`next_free_page_id`** | **`uint32_t`** | **Page ID of the next recycled free page** in the LIFO chain (`0` marks the freelist tail). Matches the `next_page_id / right_child_page_id` offset of active pages. |
| `10..11` | `reserved4` | `uint16_t` | `0x0000` (Zeroed). |
| `12..15` | `checksum` | `uint32_t` | CRC32 IEEE 802.3 checksum of the full 4096-byte page (computed with bytes 12..15 zeroed). |
| `16..4095` | `unused` | `uint8_t[4080]` | Discarded payload bytes (zero-filled or uncompacted). |

##### C Struct Definition
```c
typedef struct {
    uint8_t  page_type;          // Offset 0: 0x00 (PAGE_TYPE_FREE)
    uint8_t  reserved1;          // Offset 1: 0x00
    uint16_t reserved2;          // Offset 2..3: 0x0000
    uint16_t reserved3;          // Offset 4..5: 0x0000
    uint32_t next_free_page_id;  // Offset 6..9: Next free page in LIFO chain (0 = tail)
    uint16_t reserved4;          // Offset 10..11: 0x0000
    uint32_t checksum;          // Offset 12..15: CRC32 checksum across full 4KB page
    uint8_t  unused[4080];       // Offset 16..4095: Discarded payload
} FreePage;                      // Exact size: 4096 bytes
```

##### Freelist Traversal Algorithm
To iterate or inspect all recycled pages:
```typescript
// Traverse the singly-linked free list from Page 1:
let currPageId = page1View.getUint32(16, true); // Bytes 16..19: free_page_head

while (currPageId !== 0) {
  const pageBytes = pager.getPage(currPageId);
  const pageView = new DataView(pageBytes.buffer, pageBytes.byteOffset);
  
  const pageType = pageView.getUint8(0);
  if (pageType !== 0x00) {
    throw new CorruptPageError(currPageId, `Expected free page (0x00), got 0x${pageType.toString(16)}`);
  }
  
  const nextFreePageId = pageView.getUint32(6, true); // Bytes 6..9: next_free_page_id
  currPageId = nextFreePageId;
}
```

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
     - `UUID`: 16 bytes (`uint8_t[16]`, Big-Endian / network order).
     - `ULID`: 16 bytes (`uint8_t[16]`, Big-Endian Crockford Base32 timestamp + randomness).
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

### 5.3 Native 128-bit Identity Types: UUID & ULID (Transcoding & Serialization)

WebDB natively stores both `UUID` (type code `6`) and `ULID` (type code `7`) as **fixed-width 16-byte binary slices** (`uint8_t[16]`) directly inside the Fixed-Width Column Slice:
* **Storage Reduction:** 16 bytes on disk vs 38 bytes for UTF-8 string UUIDs (a **58% reduction** in row and index size).
* **B+Tree Index Density:** Stores ~170 index keys per 4KB page (vs ~80 for string keys), yielding shallower index trees and fewer disk I/O operations.
* **Append-Only Write Performance:** Time-ordered IDs (`UUIDv7` and `ULID`) store a 48-bit millisecond timestamp in the high bits, causing new inserts to append to the rightmost leaf of the B+Tree with zero page splits or fragmentation.
* **Fast Comparisons:** B+Tree indexing uses 16-byte unsigned comparisons (`memcmp`), which execute in a single Wasm SIMD `v128` instruction.

#### Binary Layout (128 bits / 16 bytes, Big-Endian)
```
┌───────────────────────────────────────┬───────────────────────────────────────┐
│       48-bit Timestamp (6 bytes)      │       80-bit Randomness (10 bytes)    │
└───────────────────────────────────────┴───────────────────────────────────────┘
0                                       48                                     128 bits
```

#### Automatic Two-Way Transcoding (Host JS <-> Core Engine)
Developers interact purely with familiar JavaScript strings (`crypto.randomUUID()` or Crockford Base32). The Host JS Query Builder and Result Hydrator automatically handle lossless two-way translation:

```typescript
// ==========================================
// 1. UUID Transcoder (36-char Hex <-> 16 Bytes)
// ==========================================
export class UuidCodec {
  /** Packs a 36-char hyphenated UUID string into 16 raw binary bytes */
  static encode(uuidStr: string, target: Uint8Array, offset: number = 0): void {
    const clean = uuidStr.replace(/-/g, '');
    if (clean.length !== 32) {
      throw new Error(`Invalid UUID format: "${uuidStr}" (must be 36 characters with hyphens)`);
    }
    for (let i = 0; i < 16; i++) {
      target[offset + i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
  }

  /** Unpacks 16 raw bytes into canonical 36-char hyphenated UUID string */
  static decode(source: Uint8Array, offset: number = 0): string {
    let hex = '';
    for (let i = 0; i < 16; i++) {
      hex += source[offset + i].toString(16).padStart(2, '0');
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
}

// ==========================================
// 2. ULID Transcoder (26-char Crockford Base32 <-> 16 Bytes)
// ==========================================
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_DECODE = new Uint8Array(128);
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
  CROCKFORD_DECODE[CROCKFORD_ALPHABET.charCodeAt(i)] = i;
}

export class UlidCodec {
  /** Packs a 26-character Crockford Base32 string into 16 raw bytes */
  static encode(ulidStr: string, target: Uint8Array, offset: number = 0): void {
    if (ulidStr.length !== 26) {
      throw new Error(`Invalid ULID length: "${ulidStr}" (must be 26 Crockford Base32 characters)`);
    }
    const clean = ulidStr.toUpperCase();

    // 1. Parse 48-bit timestamp (first 10 characters = 50 bits; top 2 bits 0)
    let time = 0;
    for (let i = 0; i < 10; i++) {
      time = time * 32 + CROCKFORD_DECODE[clean.charCodeAt(i)];
    }
    target[offset + 0] = (time / 0x10000000000) & 0xff;
    target[offset + 1] = (time / 0x100000000) & 0xff;
    target[offset + 2] = (time / 0x1000000) & 0xff;
    target[offset + 3] = (time / 0x10000) & 0xff;
    target[offset + 4] = (time / 0x100) & 0xff;
    target[offset + 5] = time & 0xff;

    // 2. Parse 80-bit randomness (remaining 16 characters -> 10 bytes)
    let randHi = 0n;
    for (let i = 10; i < 18; i++) {
      randHi = (randHi << 5n) | BigInt(CROCKFORD_DECODE[clean.charCodeAt(i)]);
    }
    let randLo = 0n;
    for (let i = 18; i < 26; i++) {
      randLo = (randLo << 5n) | BigInt(CROCKFORD_DECODE[clean.charCodeAt(i)]);
    }
    for (let i = 0; i < 5; i++) {
      target[offset + 6 + i] = Number((randHi >> BigInt((4 - i) * 8)) & 0xffn);
      target[offset + 11 + i] = Number((randLo >> BigInt((4 - i) * 8)) & 0xffn);
    }
  }

  /** Unpacks 16 raw bytes into canonical 26-char Crockford Base32 string */
  static decode(source: Uint8Array, offset: number = 0): string {
    // 1. Extract 48-bit timestamp
    let time = 0;
    for (let i = 0; i < 6; i++) {
      time = time * 256 + source[offset + i];
    }
    let str = '';
    for (let i = 9; i >= 0; i--) {
      str = CROCKFORD_ALPHABET[time % 32] + str;
      time = Math.floor(time / 32);
    }

    // 2. Extract 80-bit randomness
    let randHi = 0n;
    for (let i = 0; i < 5; i++) {
      randHi = (randHi << 8n) | BigInt(source[offset + 6 + i]);
    }
    let randLo = 0n;
    for (let i = 0; i < 5; i++) {
      randLo = (randLo << 8n) | BigInt(source[offset + 11 + i]);
    }
    let randPart = '';
    for (let i = 0; i < 8; i++) {
      randPart = CROCKFORD_ALPHABET[Number(randLo & 31n)] + randPart;
      randLo >>= 5n;
    }
    for (let i = 0; i < 8; i++) {
      randPart = CROCKFORD_ALPHABET[Number(randHi & 31n)] + randPart;
      randHi >>= 5n;
    }
    return str + randPart;
  }
}
```

#### End-to-End WebDB Usage Example
```typescript
import { WebDB } from '@webdb/core';

const db = await WebDB.open({ name: 'ecommerce', storage: 'opfs' });

// 1. Create table with native 128-bit identity columns
await db.createTable('orders', [
  { name: 'id', type: 'ulid', primaryKey: true },       // Stored as 16 bytes -> returns 26-char Base32
  { name: 'client_uuid', type: 'uuid', notNull: true }, // Stored as 16 bytes -> returns 36-char Hex
  { name: 'total_amount', type: 'float64', notNull: true },
]);

// 2. Insert standard strings (or crypto.randomUUID())
await db.insert('orders', {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',                   // Automatically packed into 16 bytes
  client_uuid: crypto.randomUUID(),                     // Automatically packed into 16 bytes
  total_amount: 149.50,
});

// 3. Query: seamlessly filters and hydrates back to standard strings
const order = await db.from('orders')
  .where('id', '=', '01ARZ3NDEKTSV4RRFFQ69G5FAV')
  .first();

console.log(order.id);           // "01ARZ3NDEKTSV4RRFFQ69G5FAV" (string)
console.log(order.client_uuid);  // "550e8400-e29b-41d4-a716-446655440000" (string)
console.log(order.total_amount); // 149.5 (number)
```

---

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
| `8..9` | `file_format_version` | `uint16_t` | Physical engine format version (`1` for V1); incremented on breaking format changes |
| `10..11` | `min_read_version` | `uint16_t` | Minimum engine version required to read/parse this database (`1` for V1) |
| `12..15` | `total_pages` | `uint32_t` | Total allocated pages in database file |
| `16..19` | `free_page_head` | `uint32_t` | First page ID in recycled free-page linked list (or `0` if empty); traversed via bytes 6..9 (`next_free_page_id`) of each free page (see §4.7.5) |
| `20..23` | `schema_version` | `uint32_t` | Incremented on every DDL change (`CREATE TABLE`, `DROP TABLE`) |
| `24..27` | `change_counter` | `uint32_t` | Incremented on every committed write transaction |
| `28..31` | `page_checksum` | `uint32_t` | CRC32 checksum of Page 1 (computed with bytes 28..31 zeroed) |
| `32..35` | `next_catalog_page_id` | `uint32_t` | Forward-compatible pointer to next chained catalog page (`0` in V1; allocated when $> 10$ tables in future) |
| `36..99` | `reserved` | `uint8_t[64]` | Zero-filled reserved space for future checkpoints, flags, and encryption parameters |

### 6.2 Binary Master Table Layout (Bytes 100..4095)
Supports up to 10 tables in V1, each with up to 16 columns (Page 1 fits $10 \times 344\text{ B} = 3,440\text{ B}$):
```c
typedef struct {
    uint8_t  type;          // 1=INT32, 2=INT64, 3=FLOAT64, 4=TEXT, 5=BLOB, 6=UUID, 7=ULID
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

### 6.3 Engine Version Compatibility & Fail-Fast Handshake
WebDB decouples logical schema evolutions from low-level physical disk layout compatibility:
* **`schema_version` (Bytes 20..23):** Tracks user-level catalog changes. Bytecode compilers and cached prepared statements verify this to trigger query re-compilation.
* **`file_format_version` (Bytes 8..9):** Tracks the physical database binary layout.
* **`min_read_version` (Bytes 10..11):** Minimum engine version required to read this file.
* **Fail-Fast Startup Check:**
  On database connection / open:
  ```typescript
  if (minReadVersion > CURRENT_ENGINE_VERSION) {
    throw new UnsupportedFormatVersionError(
      `Database file format requires engine version >= ${minReadVersion}, but running engine is version ${CURRENT_ENGINE_VERSION}`
    );
  }
  ```
  This immediately halts initialization if a newer database file is accessed by an obsolete engine, preventing catastrophic data corruption.

### 6.4 Master Page Crash Resilience & Failover Strategy (WAL Protocol)
Page 1 does **not** require complex dual alternating ping-pong pages or separate shadow metadata structures. Instead, WebDB treats Page 1 **uniformly as a regular 4KB page (`page_id = 1`) under the WAL write-ahead protocol**:
* **Write Isolation:** All modifications to Page 1 (schema DDL, `total_pages`, `change_counter`) write to memory slots and append to the `.wal` file upon transaction commit. The master page in the main `.db` file is never directly modified during active queries or DDL.
* **Two-Phase Checkpoint Ordering:** During checkpointing, Page 1 is written to the `.db` file along with data pages, followed immediately by `dbSyncHandle.flush()`. The `.wal` file is truncated **only after** `dbSyncHandle.flush()` succeeds.
* **Torn-Write Self-Healing on Startup:** If a crash or power cut occurs mid-write of Page 1 to the `.db` file, the `.wal` file remains non-empty and intact with the committed Page 1 frame (protected by its own CRC32 checksum). Startup recovery replays the committed Page 1 frame into `.db` before any read operations, cleanly self-healing the database.
*(See [Phase 4: Transactions & WAL](./04_transactions_acid_wal.md) for the exhaustive Failure Analysis Matrix).*

---

## 7. Dual First-Class Storage Engines: OPFS & IndexedDB (`IVfsAdapter`)

WebDB uses a unified abstraction layer where **both OPFS and IndexedDB are first-class engines**, managing both the primary database file/store and the Write-Ahead Log (WAL):

```typescript
export interface IVfsAdapter {
  readonly name: 'memory' | 'opfs' | 'idb';
  readonly isSynchronous: boolean;

  // --- Main Database Storage (.db file / 'pages' store) ---
  readPage(pageId: number): Promise<Uint8Array | null>;
  writePage(pageId: number, data: Uint8Array): Promise<void>;
  writePages(pages: Array<{ pageId: number; data: Uint8Array }>): Promise<void>;
  flush(): Promise<void>;
  truncate(pageCount: number): Promise<void>;

  // --- Write-Ahead Log Storage (.wal file / 'wal_frames' store) ---
  readWalHeader(): Promise<Uint8Array | null>;
  writeWalHeader(header: Uint8Array): Promise<void>;
  readWalFrame(frameIndex: number): Promise<Uint8Array | null>;
  readWalFrames(startFrameIndex: number, maxFrames?: number): Promise<Uint8Array[]>;
  appendWalFrames(frames: Uint8Array[]): Promise<void>;
  flushWal(): Promise<void>;
  truncateWal(frameIndex: number): Promise<void>;
  getWalFrameCount(): Promise<number>;

  // --- Lifecycle ---
  close(): Promise<void>;
}
```

### 7.1 Backend Characteristics & WAL Mapping:
1. **OPFS (`FileSystemSyncAccessHandle`):**
   - High-throughput direct block I/O in Dedicated Web Workers.
   - Manages two files: `<dbname>.db` (for pages) and `<dbname>.wal` (for WAL header + 4,128-byte frames).
   - `readWalHeader()` reads 32 bytes at offset 0 of `.wal`; `readWalFrame(i)` reads 4,128 bytes at `32 + (i * 4128)`.
   - `appendWalFrames()` streams frames contiguously to the end of `.wal`.
   - `flushWal()` calls `walHandle.flush()`.
   - `truncateWal(0)` calls `walHandle.truncate(0)` resetting the log cleanly after checkpoint.
2. **IndexedDB (`IndexedDbVfsAdapter`):**
   - Universal context compatibility: runs on Main Thread, Dedicated Workers, SharedWorkers, ServiceWorkers, and mobile WebViews without COOP/COEP.
   - Manages three Object Stores in `webdb_<dbname>`:
     - `pages`: 4KB database pages keyed by numeric `pageId`.
     - `wal_meta`: 32-byte WAL header keyed by string `'header'`.
     - `wal_frames`: 4,128-byte frames keyed by monotonic numeric `frameIndex`.
   - `appendWalFrames()` commits all frames in a single atomic `readwrite` transaction.
   - `truncateWal(0)` clears the `wal_frames` and `wal_meta` stores.
3. **In-Memory (`MemoryVfsAdapter`):**
   - Zero-dependency testing adapter: `pages: Map<number, Uint8Array>`, `walFrames: Uint8Array[]`, `walHeader: Uint8Array | null`.
   - Immediate synchronous RAM durability.

---

## 8. Exhaustive Edge Cases & Memory Safety Checklist

### A. Memory Bounds & Pointer Arithmetic
* [ ] **Unchecked ArrayBuffer OOB:** Every memory access must validate that `offset + size <= buffer.byteLength`.
* [ ] **Unaligned Byte Access:** All multi-byte values (`uint16_t`, `uint32_t`, `double`) must specify `true` for Little-Endian.
* [ ] **Zero-Slot Eviction Headroom:** Cache controller must guarantee that at least 16 slots are pinned, leaving $\ge 496$ unpinned eviction slots.
* [ ] **Double Free / Double Eviction:** Once a dirty slot is marked for eviction, its dirty bit must be cleared atomically upon WAL flush before slot reuse.

### B. Slotted Page Integrity & Checksums
* [ ] **Slot Directory Colliding with Payload:** `cell_content_offset` cannot decrement below `16 + (cell_count * 2)`. Attempting to insert into a full page must return `-1` and trigger page allocation.
* [ ] **Corrupted Slot Pointer:** Any slot directory pointer pointing to $< 16$ or $> 4096$ must trigger an immediate `CorruptPageError`.
* [ ] **Row Deletion Slot Directory Shift:** Assert deleting row $i$ shifts entries $i+1..N-1$ left by 2 bytes and decrements `cell_count` without altering remaining cell offsets.
* [ ] **Empty Page Free List LIFO Push/Pop:** When the last row is deleted from a page, verify `page_type` flips to `0x00`, it is pushed to `Page1.free_page_head`, and the next allocation reclaims it.
* [ ] **Expanding Row Update Reallocation:** Updating a row to a larger size within the same page reclaims old space via `free_bytes` and correctly compacts before insertion if contiguous space is insufficient.
* [ ] **Row Overflow Leaf Split:** Updating a row such that $L_{\text{new}} - L_{\text{old}} > \text{total\_free}$ safely triggers a leaf split/reallocation without data loss.
* [ ] **Table Interior Node Capacity (291 entries):** Ensure table interior nodes correctly store up to 291 12-byte cells + 2-byte slot entries, with `right_child_page_id` at header bytes 6..9.
* [ ] **Internal Node Split & Median Promotion:** Split at exactly median entry (145), promoting median key to parent with sibling pointer, and assigning entry 145's `child_page_id` to left page's `right_child_page_id`.
* [ ] **Secondary Index Collation Sorting:** Verify secondary index entries in leaf pages are strictly ordered by `(key, rowid)` with SQLite 3VL collation rules.
* [ ] **Defragmentation Free Space Calculation:** Assert that `free_bytes` accurately tracks deleted hole space and compaction reclaims 100% of contiguous free space.
* [ ] **Torn-Write & CRC32 Bit-Rot Detection:** Any single flipped byte on disk triggers a CRC32 checksum mismatch on read, immediately throwing `CorruptPageError` before touching the memory slots.

### C. Row Record & Constraint Fail-Fasts
* [ ] **Exact 2048-Byte Boundary:** Inserting a row of exactly 2048 bytes succeeds; inserting 2049 bytes throws `RowSizeLimitExceededError`.
* [ ] **`NOT NULL` Constraint Violation:** Inserting `null` or `undefined` into a `NOT NULL` column immediately throws `NotNullConstraintError`.
* [ ] **Dynamic Null-Bitmap Alignment:** Verify bitwise null-checking for tables with 1, 8, 9, and 16 columns (rejecting > 16 with `TooManyColumnsError`) without offset drift.

### D. File Format & Version Compatibility
* [ ] **Engine Version Fail-Fast:** Opening a file where `min_read_version > CURRENT_ENGINE_VERSION` immediately throws `UnsupportedFormatVersionError` without reading further pages.
* [ ] **Forward-Compatible Reading:** Opening a file where `file_format_version > CURRENT_ENGINE_VERSION` but `min_read_version <= CURRENT_ENGINE_VERSION` opens successfully in read mode.

### E. Transient Query Arena Protection
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
4. **Row Deletion & `memmove` Verification:** Insert 4 rows; delete row 1; assert slot directory shifts left, cell count decrements to 3, and rows 0, 2, and 3 remain accessible.
5. **Empty Page Free List Cycle:** Delete all rows from a page; assert it joins `free_page_head`; insert new rows; assert the empty page is recycled instead of incrementing `total_pages`.
6. **Expanding Update with Compaction:** Update row with larger payload requiring compaction; assert update succeeds and row is intact.
7. **Boundary Limit (2048 Bytes):** Assert exactly 2048 bytes passes; 2049 bytes throws `RowSizeLimitExceededError`.

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

### Test Suite 5: Checksum Verification & Version Handshake (`tests/integrity_version.test.ts`)
1. **CRC32 Checksum Validation on Read:** Write a page to VFS; flip a single bit in storage; call `readPage()`; assert `CorruptPageError` is thrown with mismatched checksum values.
2. **Page 1 Checksum Verification:** Assert Page 1 has valid CRC32 at bytes 28..31; tamper with table metadata; assert file open fails with `CorruptPageError`.
3. **Engine Version Rejection:** Write a database file with `min_read_version = 99`; attempt to open; assert `UnsupportedFormatVersionError` is thrown immediately.
4. **Backward-Compatible Version Acceptance:** Open a database with `file_format_version = 2` but `min_read_version = 1` in version 1 engine; assert file opens successfully.

### Test Suite 6: B+Tree Interior Routing & Secondary Index Geometry (`tests/btree_hierarchy.test.ts`)
1. **Table Interior Node Saturation & Split:** Insert 300 sequential routing entries into a table interior node; assert page splits at entry 145, creates sibling, and promotes median key.
2. **Binary Search Traversal Verification:** Populate an interior node with 200 keys; test binary search across all keys, boundary values, and keys exceeding maximum (verifying fallback to `right_child_page_id`).
3. **Secondary Index Slotted Collation:** Insert index cells containing `NULL`, negative numbers, positive numbers, and UTF-8 strings; assert slot directory orders them according to SQLite collation precedence.
