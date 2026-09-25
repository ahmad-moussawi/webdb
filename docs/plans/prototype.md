# WebDB Prototype Specification: The Vertical Slice ("Walking Skeleton")

## 1. Overview & Objective

The goal of this working prototype is to validate and demonstrate the core architectural innovations of WebDB end-to-end in JavaScript before completing the full multi-phase roadmap. 

It provides an immediate, functional relational database engine that:
1. Stores data in real **4KB Slotted Pages** within a flat `ArrayBuffer`.
2. Encodes and decodes the schema via the **Page 1 Binary Master Table**.
3. Executes queries via a synchronous **Bytecode Virtual Machine (VDBE-style)** using strict C-style pointer arithmetic and zero dynamic object allocations in the execution hot path.
4. Enforces **SQLite-compatible Three-Valued Logic (3VL)** for `NULL` handling.
5. Exposes a clean, fluent TypeScript API: `db.createTable()`, `db.insert()`, `db.select().from().where().toArray()`.
6. Persists data via the unified **`IVfsAdapter`** (In-Memory and IndexedDB backends).

---

## 2. Intentional Prototype Scope & Limitations

To deliver an ultra-fast, robust working engine without waiting for all advanced phases, the prototype makes specific, deliberate simplifications:

| Area | Full Engine (plan.md) | Prototype ("Walking Skeleton") |
| :--- | :--- | :--- |
| **Page Eviction & LRU** | Dynamic 4MB cache (1,024 slots) with async page-fault eviction and cursor pinning | **In-Memory Working Set**: Allocates 64 rigid slots (256 KB) in `ArrayBuffer`. Fits initial tables completely in memory; eviction is bypassed. |
| **B+Tree Balancing** | Multi-level B+Tree with balancing, page splits, and sibling borrowing | **Sequential Slotted Pages / Single-Leaf Tables**: Records fill 4KB pages; next page allocated via Page 1 `total_pages`. Scans sequentially traverse data pages. |
| **Indexes** | Secondary B-Tree index point seeks and range scans | **Full Table Scans with VM Filtering**: All filters evaluated row-by-row in bytecode VM. |
| **Crash Recovery (WAL)** | Frame-by-frame WAL logging, LSN tracking, and deduplicated monotonic checkpoints | **Direct Atomic Write-Through**: Batched dirty pages are flushed straight to the `IVfsAdapter` (Memory or IndexedDB) on commit. |
| **Joins & Aggregations** | Up to 16-table nested loop joins, dynamic query arena hash tables for `GROUP BY` | **Single-table queries only**: `SELECT`, `WHERE`, `ORDER BY` (in-memory), `LIMIT`, `OFFSET`. |
| **Multi-Tab / Multi-Worker** | `SharedWorker` coordinator & `navigator.locks` leader election | **Single Tab / Single Context**: Runs directly in the calling environment (main thread or worker). |

---

## 3. Binary & Memory Layout Specifications

### 3.1 Global Shared Memory (`ArrayBuffer`)
* Sized initially to **64 slots $\times$ 4096 bytes = 262,144 bytes (256 KB)**.
* **Layout:**
  - `0x00000..0x00FFF` (4 KB): **Page 1 (Header + Binary Master Table)**
  - `0x01000..0x01FFF` (4 KB): **Page 2 (Table Root Page / Data Page)**
  - `0x02000..0x3FFFF` (248 KB): Additional data pages (Pages 3..63)
  - `0x40000..0x47FFF` (32 KB): **Output Result Buffer** (for chunked row emission)
  - `0x48000..0x48FFF` (4 KB): **VmContext Struct & Bytecode Buffer**

### 3.2 Page 1: File Header & Binary Master Table
* **Bytes 0..99 (File Header):**
  - Bytes `0..5`: Magic bytes `"WEBDB\0"`
  - Bytes `6..7`: Page size (`4096`, uint16)
  - Bytes `8..9`: File format version (`file_format_version`, uint16, default `1`)
  - Bytes `10..11`: Minimum readable version (`min_read_version`, uint16, default `1`)
  - Bytes `12..15`: Total page count (`total_pages`, uint32)
  - Bytes `16..19`: Free page head pointer (`free_page_head`, uint32; next free page ID read from bytes 6..9 of each free page)
  - Bytes `20..23`: Schema version (`schema_version`, uint32)
  - Bytes `24..27`: Change counter (`change_counter`, uint32)
  - Bytes `28..31`: Page 1 Checksum (`page_checksum`, uint32, CRC32 with bytes 28..31 zeroed)
  - Bytes `32..35`: Next catalog page pointer (`next_catalog_page_id`, uint32, 0 in V1)
  - Bytes `36..99`: Reserved (64 bytes zero-filled)
* **Bytes 100..4095 (Master Table Catalog):**
  - Pre-allocated slots for 16 tables ($16 \times 128\text{ B} = 2,048\text{ B}$), with dedicated 4KB Column Catalog Pages supporting up to 256 columns:
    ```
    TableDescriptor (offset 100 + table_idx * 128, total size 128 bytes):
      uint16_t table_id
      uint16_t column_count (up to 256)
      uint32_t root_page_id
      uint32_t col_catalog_page_id
      char     name[64] (null-padded UTF-8)
      uint32_t flags
      uint32_t row_count_estimate
      uint8_t  _reserved[44]

    ColumnMeta (stored on dedicated 4KB catalog pages, 72 bytes each):
      uint8_t  type (1=INT32, 2=INT64, 3=FLOAT64, 4=TEXT, 5=BLOB, 6=UUID, 7=ULID)
      uint8_t  flags (0x1=PRIMARY KEY, 0x2=NOT NULL, 0x4=INDEXED, 0x8=AUTO_INC)
      uint16_t col_offset (offset in fixed slice)
      char     name[64] (null-padded UTF-8)
      uint32_t index_root_page (0 if unindexed)
    ```

### 3.3 Slotted 4KB Data Page Layout
```
┌────────────────────────────────────────────────────────────────────────┐
│ Page Header (16 Bytes):                                                │
│   uint8_t  page_type (0x0D = Leaf Data Page)                           │
│   uint8_t  reserved (0)                                                │
│   uint16_t cell_count (Number of rows in page)                         │
│   uint16_t cell_content_offset (Byte offset of lowest row payload)     │
│   uint32_t next_page_id (Page link for sequential scan, or 0)          │
│   uint16_t free_bytes (Fragmented uncompacted hole bytes)              │
│   uint32_t checksum (CRC32 IEEE 802.3 of full 4KB page)                │
├────────────────────────────────────────────────────────────────────────┤
│ Slot Directory (grows downward from offset 16):                        │
│   uint16_t cell_offsets[cell_count] (Pointers to row starts)           │
├────────────────────────────────────────────────────────────────────────┤
│                      <--- Free Space Area --->                         │
├────────────────────────────────────────────────────────────────────────┤
│ Cell Payloads (grows upward from 4096):                                │
│   Row N ... Row 2 ... Row 1                                            │
└────────────────────────────────────────────────────────────────────────┘
```
* **Slot Shifting on Deletion:** Deleting a row shifts slot directory entries left by 2 bytes (`memmove`), decrements `cell_count--`, and adds the row size to `free_bytes`.
* **Gap Defragmentation:** When an insert requires space and contiguous free space is insufficient but total free space is sufficient, an in-place compaction collapses all holes to the bottom.

### 3.4 Row Binary Record Format & Null-Bitmap
```
┌────────────┬──────────────────────────┬───────────────────────┬─────────────────────────┬──────────────────────────┐
│ Flags (1B) │ Null-Bitmap (ceil(N/8)B) │ Fixed Slice (4B / 8B) │ Var-Offset Table (2B/ea)│ Var Payloads (UTF-8/Blob)│
└────────────┴──────────────────────────┴───────────────────────┴─────────────────────────┴──────────────────────────┘
```
* **Flags (1B):** `0x01` = Active, `0x00` = Deleted.
* **Dynamic Null-Bitmap (`ceil(col_count / 8)` bytes):**
  - Bit $i$ set to `1` indicates column $i$ is `NULL`.
  - When bit is set, fixed-width bytes and variable offsets are omitted (0 bytes stored).
* **Strict Size Limit:** Max 2048 bytes per row; throws `RowSizeLimitExceededError` on overflow.

---

## 4. SQLite-Compatible NULL Semantics & Datatypes

The prototype strictly enforces:
1. **Core Types:** `INT32` (4B), `INT64` (8B), `FLOAT64` (8B), `TEXT` (string), `BLOB` (`Uint8Array`).
2. **Three-Valued Logic (3VL):**
   - `col = NULL` and `col != NULL` evaluate to `UNKNOWN` (falsy in filter conditions).
   - `NULL = NULL` does not match in standard equality filters.
   - `col IS NULL` and `col IS NOT NULL` explicitly test the row's Null-Bitmap bit.
3. **Fail-Fast `NOT NULL` Enforcement:** Inserting `NULL` into a column flagged with `0x02` immediately throws `NotNullConstraintError`.

---

## 5. Bytecode VM Architecture (VDBE)

The prototype implements an interruptible, single-frame state machine `vm_step(ctx_offset)`:

### 5.1 Opcodes Implemented
* `OP_OPEN_CURSOR (cursor_id, table_id, root_page_id)`: Initializes cursor on the table's root page.
* `OP_REWIND (cursor_id, jump_eof)`: Positions cursor at the first row of the first page.
* `OP_NEXT_ROW (cursor_id, jump_eof)`: Advances cursor to next slot; if at page end, follows `next_page_id`.
* `OP_COLUMN_INT (cursor_id, col_idx, target_reg)`: Reads integer from row into register.
* `OP_COLUMN_FLOAT (cursor_id, col_idx, target_reg)`: Reads float from row into register.
* `OP_COLUMN_TEXT (cursor_id, col_idx, target_reg)`: Reads string offset/length and points register to text slice.
* `OP_IS_NULL (cursor_id, col_idx, jump_if_null)`: Checks Null-Bitmap bit; jumps if set.
* `OP_IS_NOT_NULL (cursor_id, col_idx, jump_if_not_null)`: Jumps if Null-Bitmap bit is clear.
* `OP_EQ / OP_NE / OP_GT / OP_GE / OP_LT / OP_LE (reg_a, reg_b, jump_target)`: Evaluates filter comparison.
* `OP_EMIT_ROW (cursor_id)`: Copies current row record into Output Result Buffer.
* `OP_HALT`: Halts execution and sets `status = STATUS_DONE`.

### 5.2 Resumability (`VmContext`)
```typescript
interface VmContext {
  pc: number;             // Program counter
  status: number;         // STATUS_RUNNING, STATUS_DONE, STATUS_BUFFER_FULL
  resultCount: number;    // Rows written to output buffer
  resultOffset: number;   // Current write offset in result buffer
  registers: number[];    // Scalar comparison registers
  cursor: {
    pageId: number;
    cellIdx: number;
    slotOffset: number;
  };
}
```

---

## 6. Storage Layer (`IVfsAdapter`)

The prototype ships with two implementations of `IVfsAdapter`:
1. **`MemoryVfsAdapter`**: Backed by an in-memory `Uint8Array` array of pages. Zero external dependencies; instant for unit tests.
2. **`IndexedDbVfsAdapter`**: Stores 4KB pages in an IndexedDB Object Store (`pages`), keyed by numeric `pageId`. Fully persistent across page refreshes.

---

## 7. Public API Surface

```typescript
import { WebDB } from './webdb.js';

const db = await WebDB.open({
  name: 'test_db',
  storage: 'memory', // or 'idb'
});

await db.createTable('users', [
  { name: 'id', type: 'INT32', flags: { primaryKey: true, notNull: true } },
  { name: 'name', type: 'TEXT', flags: { notNull: true } },
  { name: 'age', type: 'INT32' },
  { name: 'score', type: 'FLOAT64' },
]);

await db.insert('users', { id: 1, name: 'Alice', age: 28, score: 95.5 });
await db.insert('users', { id: 2, name: 'Bob', age: 19, score: 82.0 });
await db.insert('users', { id: 3, name: 'Charlie', age: null, score: 88.0 });

// Queries
const adults = await db.from('users')
  .where('age', '>', 21)
  .toArray();

const nullAges = await db.from('users')
  .whereNull('age')
  .toArray();
```

---

## 8. Directory & File Structure

```
src/
├── types.ts          # Core enums (Datatypes, Flags, Opcodes, Status) & interfaces
├── constants.ts      # Magic numbers, page size (4096), header offsets
├── storage/
│   ├── vfs.ts        # IVfsAdapter interface
│   ├── memory.ts     # MemoryVfsAdapter
│   └── idb.ts        # IndexedDbVfsAdapter
├── engine/
│   ├── page.ts       # Slotted Page encoder, decoder, and row packer
│   ├── catalog.ts    # Page 1 Binary Master Table manager
│   ├── vm.ts         # Bytecode VM step execution loop
│   └── compiler.ts   # Fluent AST to bytecode instruction compiler
└── webdb.ts          # Public WebDB database handle and query builder
tests/
├── page.test.ts      # Slotted page & row packing tests
├── nulls.test.ts     # 3VL SQLite-compatible NULL tests
├── vm.test.ts        # Bytecode execution tests
└── webdb.test.ts     # End-to-end fluent queries and persistence tests
```
