# WebDB Internals Handbook — Phase 1: Binary Storage Format & Slotted Pages

> **Who is this guide for?**
> You do **not** need to know C++, nor do you need prior experience with database internals. This guide explains every concept from first principles using plain English, ASCII diagrams, visual illustrations, and intuitive analogies.

---

## 1. The Big Picture: What is a Database Storage Engine?

When people think of a database like SQLite, PostgreSQL, or WebDB, they often think of SQL queries like `SELECT * FROM users;`. But underneath the query parser sits the **storage engine**.

The storage engine's only job is:
1. Turn structured rows and columns into raw bytes (`0`s and `1`s).
2. Store those bytes persistently (on a hard drive, SSD, or browser storage like IndexedDB).
3. Retrieve and modify those bytes reliably, even if the computer suddenly loses power, the browser tab crashes, or data gets corrupted.

### The Challenge of In-Browser Storage

In a traditional operating system (Linux, macOS, Windows), a C++ program can call standard functions like `fopen()`, `pwrite()`, or `fsync()` to directly read and write files on disk.

In a web browser, WebAssembly (WASM) runs inside a **strict security sandbox**. It has **no access to your hard drive**. Instead, WebDB must store its data in browser-provided storage APIs (such as **IndexedDB** or the **Origin Private File System (OPFS)**).

Phase 1 lays the binary foundation: how WebDB formats raw bytes in memory so they can be saved and loaded anywhere.

---

## 2. Core Building Blocks

### A. The Page: Why 4,096 Bytes (4 KiB)?

Computers do not read and write to disks one byte at a time. Doing so would be astronomically slow. Instead, operating systems and hard drives read and write in fixed-size blocks called **pages**.

```
+-----------------------------------------------------------------------+
|                       One Database Page (4,096 Bytes)                  |
+-----------------------------------------------------------------------+
| Byte 0                                                      Byte 4095 |
```

WebDB defines:
```cpp
inline constexpr size_t DATABASE_PAGE_SIZE = 4096; // 4 KiB
```

Every single piece of data in WebDB—system settings, table rows, indexes—lives inside one or more 4,096-byte pages.
- Every page has a unique identifier called a **Page ID** (`page_id_t`), which is a signed 32-bit integer (`int32_t`).
- Page IDs start at `0`:
  - `page_id = 0`: **Master Page A** (Metadata)
  - `page_id = 1`: **Master Page B** (Metadata)
  - `page_id >= 2`: **Data Pages** (Table rows)

---

### B. Endianness: Little-Endian Byte Order

When storing a large number like `305,419,896` (in hexadecimal: `0x12345678`), which takes 4 bytes, in what order should the bytes be saved into memory?
- **Big-Endian**: Save the most significant byte first: `12 34 56 78` (like reading left-to-right).
- **Little-Endian**: Save the least significant byte first: `78 56 34 12`.

Most modern CPUs (Intel x86, AMD, ARM chips in Apple M-series and Android phones) and WebAssembly use **Little-Endian**.

WebDB guarantees that all numbers on disk are **strictly Little-Endian**. That means a database file created on an iPhone will be 100% identical and readable on an Intel desktop or inside a browser.

---

### C. Unaligned Memory Access Safety

In C++, if you tell the computer "read an 8-byte number starting at byte 3", some processors will either:
1. Crash immediately with a hardware alignment fault (e.g., older ARM or WebAssembly under certain compiler flags).
2. Read it very slowly.

To guarantee WebDB never crashes regardless of device, WebDB strictly forbids pointer casting (`reinterpret_cast`). Instead, it copies bytes safely using `std::memcpy`:

```cpp
// Instead of risky pointer casting:
// uint64_t val = *(reinterpret_cast<uint64_t*>(buffer + 3)); // RISKY!

// WebDB safely reads bytes:
template <typename T>
inline T read_le(const uint8_t* src) noexcept {
    T value;
    std::memcpy(&value, src, sizeof(T));
    // Converts to CPU endianness if running on big-endian hardware
    return value;
}
```

---

### D. Checksums (CRC-32 IEEE 802.3)

What happens if a laptop battery dies while writing a page, or browser storage gets corrupted?
If the database blindly reads scrambled bytes, it might crash or return garbage data.

To prevent this, every page in WebDB reserves 4 bytes in its header for a **CRC-32 Checksum**.
- A checksum is a mathematical fingerprint of the page contents.
- Before writing a page, WebDB calculates the checksum over the remaining 4,092 bytes and writes the 4-byte fingerprint into the header.
- When loading a page, WebDB recalculates the fingerprint. If even a single bit changed, the checksum fails, and WebDB flags the page as `StorageResult::CORRUPTED_PAGE` rather than corrupting user data.

---

## 3. Dual Master Pages: Crash-Proof Metadata Without a WAL

In typical databases, making metadata updates safe against sudden power loss requires a complex subsystem called a **Write-Ahead Log (WAL)**.

WebDB Phase 1 achieves crash-resilient metadata publication **without** a WAL using an elegant technique called **Dual Master Pages (Ping-Pong Master Pages)**.

### How It Works

Pages `0` and `1` are reserved exclusively for database metadata:
- How many total pages exist in the database (`page_count`).
- Where the root table is located (`catalog_root_page_id`).
- A monotonic counter called the **Generation ID** (`generation_id`).

```
+--------------------------+      +--------------------------+
|      Master Page A       |      |      Master Page B       |
|       (Page ID: 0)       |      |       (Page ID: 1)       |
|--------------------------|      |--------------------------|
| Generation ID: 4         |      | Generation ID: 5         |
| Page Count: 10           |      | Page Count: 11           |
| CRC-32: [Valid]          |      | CRC-32: [Valid]          |
| [ACTIVE MASTER]          |      | [NEWEST / ACTIVE MASTER] |
+--------------------------+      +--------------------------+
```

### The Ping-Pong Commit Rule

1. Whenever WebDB wants to update database metadata, it **never overwrites the active master page**.
2. Instead, it writes to the **other** master page with `generation_id = active_generation + 1`.
3. When the database boots up:
   - It reads Page 0 and verifies its CRC checksum.
   - It reads Page 1 and verifies its CRC checksum.
   - If both are valid, **the one with the higher Generation ID wins**.
   - If the power died while writing Page 1 (leaving it corrupted or half-written), Page 1's CRC will fail! WebDB automatically falls back to Page 0. The database cleanly recovers to the state right before the failed write.

---

## 4. Slotted Pages: How Rows Fit Inside a 4 KiB Page

Imagine you have a single 4,096-byte page and you want to store rows (called **Tuples**) in it.
Some rows are small (`id = 1, name = "Bob"`), while other rows are large (`id = 2, bio = "A very long paragraph..."`).

If rows have variable lengths, where do you put them?
- If you put them sequentially from the top, deleting a row in the middle leaves a gap. Shifting all following rows to close the gap is slow and invalidates pointers to those rows!
- If you use fixed slots, small rows waste tons of unused space.

The database industry solved this decades ago with **Slotted Pages**. WebDB implements a clean, robust slotted page architecture.

### The Two-Way Growth Layout

Inside a 4,096-byte page:
1. **Header (36 bytes)** sits at the very beginning (Byte 0 to 35).
2. **Slot Array (4 bytes per slot)** starts immediately after the header and **grows DOWNWARD** (towards higher memory addresses).
3. **Tuple Data (the actual row bytes)** starts at the very end of the page (Byte 4095) and **grows UPWARD** (towards lower memory addresses).
4. In the middle sits **Free Space**.

```
+-------------------------------------------------------------------+
| Page Header (36 Bytes): CRC, PageID, FreeSpaceOffset, SlotCount   |
+-------------------------------------------------------------------+
| Slot 0: [Offset: 3950, Size: 146]                                 |
| Slot 1: [Offset: 3800, Size: 150]                                 |  ==> Grows DOWNWARDS (-->)
| Slot 2: [Offset: 3720, Size: 80]                                  |
+-------------------------------------------------------------------+
|                        FREE SPACE REGION                          |
|             (Available for new slots and row data)                |
+-------------------------------------------------------------------+
| Tuple 2 Data (80 bytes)                                           |
| Tuple 1 Data (150 bytes)                                          |  <== Grows UPWARDS (<--)
| Tuple 0 Data (146 bytes)                                          |
+-------------------------------------------------------------------+
Byte 4095 (End of Page)
```

### Why This Layout is Brilliant: Stable Row Identifiers (RIDs)

Every row in WebDB has a stable address called a **Record ID (RID)**:
```cpp
struct RID {
    page_id_t page_id;  // Which page (e.g., Page 5)
    uint16_t  slot_num; // Which slot (e.g., Slot 2)
};
```

Because external indexes point to `RID(page_id=5, slot_num=2)`, **the physical tuple data inside Page 5 can be moved anywhere inside that page during compaction**, as long as `Slot 2` is updated with the new byte offset! The outside world never needs to know the data moved.

### Slot States

Each 4-byte slot contains:
- `offset` (2 bytes, `uint16_t`): Byte index where the tuple data starts.
- `size` (2 bytes, `uint16_t`): Length of the tuple data, plus 2 bits reserved for state:
  - `LIVE`: Points to an active, readable tuple.
  - `DEAD`: The row was deleted or updated. Its payload is reclaimed during compaction.
  - `EMPTY`: Unallocated slot.

### Deletions and Compaction

When you delete a row:
1. Its slot is marked `DEAD`.
2. The slot number is not removed, so other slot numbers don't shift.
3. If free space runs low on new insertions, WebDB runs **in-page compaction**: it slides all `LIVE` tuples tightly back to the bottom of the page, eliminating dead gaps, and updates their slot offsets.
4. If slots at the very end of the slot array are marked `DEAD`, WebDB performs **trailing-slot pruning**, shrinking the slot array and reclaiming free space.

---

## 5. Tuples: Serializing Types (`INT`, `DOUBLE`, `TEXT`, `NULL`)

A row in a table consists of multiple typed values. WebDB supports:
1. `INT` (64-bit signed integer: 8 bytes)
2. `DOUBLE` (64-bit IEEE floating-point: 8 bytes)
3. `TEXT` (Variable-length UTF-8 string)
4. `NULL` (Representing the absence of a value)

### Tuple Binary Format

To pack a row into bytes without wasting space:
```
+-----------------------------------------------------------------------+
| Column Count | Null Bitmask | Value Offsets / Payloads | Text Payloads |
+-----------------------------------------------------------------------+
```

1. **Column Count (`uint16_t`)**: Number of columns in this row.
2. **Null Bitmask**: A compact series of bits (1 bit per column). If column 3 is `NULL`, bit 3 is `1`. A `NULL` column takes **zero bytes** in the payload!
3. **Values Area**:
   - `INT` and `DOUBLE` values are stored inline directly in their 8-byte binary format.
   - `TEXT` values store an offset pointing to the text payload located at the end of the tuple, preceded by its byte length.
   - Text strings are strictly validated for **valid UTF-8 encoding** to prevent corrupt strings from entering the database.

---

## 6. The Table Heap: Chaining Pages Together

A single slotted page can only hold up to 4,056 bytes of row data. Real tables need to store gigabytes of rows across thousands of pages.

To connect pages, WebDB uses a **Table Heap**: a doubly-linked list of table pages.

```
+---------------+        +---------------+        +---------------+
| Table Page 2  |        | Table Page 3  |        | Table Page 4  |
| prev_page: -1 | <====> | prev_page: 2  | <====> | prev_page: 3  |
| next_page: 3  |        | next_page: 4  |        | next_page: -1 |
+---------------+        +---------------+        +---------------+
```

- Each page header stores:
  - `prev_page_id`: Page ID of the predecessor (or `-1` if first page).
  - `next_page_id`: Page ID of the successor (or `-1` if last page).
- **Inserting Rows**: New rows are inserted into the last page. If the page is full (`StorageResult::PAGE_FULL`), a new page is allocated, linked to the end of the chain, and the row is inserted there.
- **Scanning (`TableIterator`)**: Iterating over a table starts at `first_page_id` at slot `0`, reading each `LIVE` tuple. When slot count is exhausted, it follows `next_page_id` to the next page.
- **Cycle & Corruption Defense**: To prevent infinite loops caused by corrupted disks, `TableIterator` maintains an anti-cycle guard and traversal limit (maximum 1,048,576 pages / 4 GiB).

---

## 7. Open Questions, Contradictions & Things Needing Clarification

While Phase 1 is fully functional and tested, several architectural constraints should be kept in mind:

1. **Torn Writes on Data Pages**:
   - *The Reality:* Dual Master Pages make **metadata** publication crash-proof. However, table data pages are modified in place. If the browser or computer loses power halfway through writing a 4 KiB data page, that data page will have a mismatched CRC checksum and become unreadable (`CORRUPTED_PAGE`).
   - *Resolution:* Full crash-durability for data pages requires Phase 4 (generation-aware commit protocols / shadow pages).
2. **No Overflow Pages**:
   - *The Limitation:* `MAX_TUPLE_SIZE = 4056` bytes. If a single row (e.g., a huge text document) exceeds 4,056 bytes, Phase 1 returns `StorageResult::TUPLE_TOO_LARGE`. Multi-page overflow chains are deferred to later milestones.
3. **No Free-Page Recycling**:
   - *The Limitation:* When all rows on a page are deleted, the page is not unlinked or returned to a free list. Data page allocation is strictly append-only in Phase 1.
