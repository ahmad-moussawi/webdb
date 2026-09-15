# Phase 1: Storage Format, Dual Master Pages & Slotted Pages

This document is the implementation specification for **Phase 1** of WebDB. It defines the persisted binary formats, validation rules, storage APIs, crash-consistency scope, tuple encoding, slotted-page behavior, table-heap behavior, and required tests.

Phase 1 supports fixed-size 4096-byte pages, append-only allocation, dual master pages, CRC-protected pages, slotted table pages, typed tuples, and synchronous single-threaded access.

---

## 1. Scope and Non-Goals

### 1.1 Phase 1 Includes

- 4096-byte fixed-size database pages.
- CRC-32 IEEE 802.3 checksums on every persisted page.
- Two alternating master pages at page IDs `0` and `1`.
- Append-only allocation of data pages starting at page ID `2`.
- Slotted pages with insertion, deletion, update, compaction, and trailing-slot pruning.
- Tuple serialization for `INT`, `DOUBLE`, `TEXT`, and `NULL`.
- UTF-8 validation for text values.
- A synchronous, single-threaded `IPageAccessor` boundary.
- A doubly-linked `TableHeap` and corruption-aware iterator.

### 1.2 Explicit Non-Goals

The following are deferred beyond Phase 1:

- Transactions and concurrent writers.
- Write-ahead logging (WAL).
- Copy-on-write / shadow paging for data pages.
- Recovery of torn or partially persisted data-page updates.
- Free-page reuse.
- Overflow pages for oversized tuples.
- Forwarding records and stable secondary-index references.
- Schema migrations and backward-compatible decoding of future tuple versions.

### 1.3 Crash-Consistency Scope

Dual master pages provide **atomic publication of master metadata**: root pointers and `page_count` are published together by alternating between Master A and Master B.

Phase 1 data pages are modified in place. Therefore:

- A crash during a data-page write may leave a page corrupted.
- CRC validation detects that corruption when the page is subsequently read.
- Phase 1 does **not** recover earlier data-page contents after a torn write.
- “Crash-safe” in Phase 1 means master metadata selection is resilient; it does **not** mean fully transactional or recoverable atomic commits for data-page mutations.

A future WAL or copy-on-write design is required before claiming recoverable atomic commits for table data.

---

## 2. Global Constants, Types, and Status Codes

```cpp
#pragma once

#include <cstddef>
#include <cstdint>

namespace webdb {

using page_id_t = int32_t;
using generation_id_t = uint64_t;

inline constexpr page_id_t INVALID_PAGE_ID = -1;
inline constexpr page_id_t MASTER_PAGE_A_ID = 0;
inline constexpr page_id_t MASTER_PAGE_B_ID = 1;
inline constexpr page_id_t FIRST_DATA_PAGE_ID = 2;

inline constexpr size_t DATABASE_PAGE_SIZE = 4096;
inline constexpr size_t PAGE_HEADER_SIZE = 36;
inline constexpr size_t SLOT_ENTRY_SIZE = 4;

// floor((DATABASE_PAGE_SIZE - PAGE_HEADER_SIZE) / SLOT_ENTRY_SIZE) = 1015.
inline constexpr uint16_t MAX_SLOT_COUNT = 1015;

// One tuple plus one slot entry must fit in an otherwise empty TablePage.
inline constexpr size_t MAX_TUPLE_SIZE =
    DATABASE_PAGE_SIZE - PAGE_HEADER_SIZE - SLOT_ENTRY_SIZE; // 4056

inline constexpr uint16_t MAX_COLUMNS = 256;
inline constexpr size_t MAX_TEXT_SIZE = MAX_TUPLE_SIZE;

// Iterator corruption guard: 1,048,576 * 4096 = 4 GiB maximum chain traversal.
inline constexpr size_t MAX_PAGES = 1'048'576;

enum class TypeId : uint8_t {
    INVALID = 0,
    INT = 1,
    DOUBLE = 2,
    TEXT = 3,
};

enum class SlotState : uint8_t {
    EMPTY = 0,     // Never valid inside [0, slot_count) on disk in Phase 1.
    LIVE = 1,      // Contains a readable tuple payload.
    DEAD = 2,      // Deleted/replaced tuple; payload region is reclaimable.
    FORWARDED = 3, // Reserved for Phase 3; invalid on disk in Phase 1.
};

struct RID {
    page_id_t page_id{INVALID_PAGE_ID};
    uint16_t slot_num{0};

    constexpr bool is_valid() const noexcept {
        return page_id != INVALID_PAGE_ID;
    }

    constexpr bool operator==(const RID& other) const noexcept = default;
};

enum class StorageResult : uint8_t {
    SUCCESS = 0,
    PAGE_FULL,
    TUPLE_TOO_LARGE,
    SLOT_NOT_FOUND,
    CORRUPTED_PAGE,
    VERSION_MISMATCH,
    SCHEMA_MISMATCH,
    INVALID_ARGUMENT,
    CYCLE_DETECTED,
    IO_ERROR,
};

struct UpdateResult {
    StorageResult status{StorageResult::INVALID_ARGUMENT};
    RID old_rid{};
    RID new_rid{};
    bool rid_changed{false};

    constexpr bool success() const noexcept {
        return status == StorageResult::SUCCESS;
    }
};

} // namespace webdb
```

All Phase 1 public storage APIs return `StorageResult` or a structure containing a `StorageResult`. They do not use exceptions for expected storage, corruption, serialization, or I/O failures.

---

## 3. Endianness and Unaligned Access Safety

All persisted multi-byte values use **little-endian** byte order.

The storage implementation must not dereference unaligned typed pointers. In particular, code in `tuple.cpp`, `slotted_page.cpp`, and `master_page.cpp` must not use raw casts such as:

```cpp
reinterpret_cast<const uint64_t*>(buffer)
reinterpret_cast<int64_t*>(buffer)
```

All multi-byte reads and writes must use `std::memcpy`-based helpers.

```cpp
#pragma once

#include <bit>
#include <cstdint>
#include <cstring>
#include <type_traits>

namespace webdb::endian {

template <typename T>
inline T read_le(const uint8_t* src) noexcept {
    static_assert(std::is_trivially_copyable_v<T>);

    T value;
    std::memcpy(&value, src, sizeof(T));

    if constexpr (std::endian::native == std::endian::big) {
        if constexpr (sizeof(T) == 2) {
            auto bits = std::bit_cast<uint16_t>(value);
            return std::bit_cast<T>(__builtin_bswap16(bits));
        } else if constexpr (sizeof(T) == 4) {
            auto bits = std::bit_cast<uint32_t>(value);
            return std::bit_cast<T>(__builtin_bswap32(bits));
        } else if constexpr (sizeof(T) == 8) {
            auto bits = std::bit_cast<uint64_t>(value);
            return std::bit_cast<T>(__builtin_bswap64(bits));
        }
    }

    return value;
}

template <typename T>
inline void write_le(uint8_t* dst, T value) noexcept {
    static_assert(std::is_trivially_copyable_v<T>);

    if constexpr (std::endian::native == std::endian::big) {
        if constexpr (sizeof(T) == 2) {
            auto bits = std::bit_cast<uint16_t>(value);
            value = std::bit_cast<T>(__builtin_bswap16(bits));
        } else if constexpr (sizeof(T) == 4) {
            auto bits = std::bit_cast<uint32_t>(value);
            value = std::bit_cast<T>(__builtin_bswap32(bits));
        } else if constexpr (sizeof(T) == 8) {
            auto bits = std::bit_cast<uint64_t>(value);
            value = std::bit_cast<T>(__builtin_bswap64(bits));
        }
    }

    std::memcpy(dst, &value, sizeof(T));
}

inline uint16_t read_uint16(const uint8_t* p) noexcept { return read_le<uint16_t>(p); }
inline uint32_t read_uint32(const uint8_t* p) noexcept { return read_le<uint32_t>(p); }
inline uint64_t read_uint64(const uint8_t* p) noexcept { return read_le<uint64_t>(p); }
inline int32_t read_int32(const uint8_t* p) noexcept { return read_le<int32_t>(p); }
inline int64_t read_int64(const uint8_t* p) noexcept { return read_le<int64_t>(p); }
inline double read_double(const uint8_t* p) noexcept { return read_le<double>(p); }

inline void write_uint16(uint8_t* p, uint16_t v) noexcept { write_le<uint16_t>(p, v); }
inline void write_uint32(uint8_t* p, uint32_t v) noexcept { write_le<uint32_t>(p, v); }
inline void write_uint64(uint8_t* p, uint64_t v) noexcept { write_le<uint64_t>(p, v); }
inline void write_int32(uint8_t* p, int32_t v) noexcept { write_le<int32_t>(p, v); }
inline void write_int64(uint8_t* p, int64_t v) noexcept { write_le<int64_t>(p, v); }
inline void write_double(uint8_t* p, double v) noexcept { write_le<double>(p, v); }

} // namespace webdb::endian
```

---

## 4. Checksums

### 4.1 Algorithm

Every master and table page uses **CRC-32 IEEE 802.3**:

- Reflected polynomial: `0xEDB88320`
- Initial value: `0xFFFFFFFF`
- Final XOR: `0xFFFFFFFF`

The checksum always covers all 4096 bytes of the page while treating the page’s checksum field as four zero bytes.

```text
CRC32(page) = CRC32(all 4096 page bytes, checksum bytes replaced by 0x00)
```

### 4.2 Checksum Field Offsets

| Page Type | Checksum Bytes | Offset |
|---|---:|---:|
| MasterPage | `[32..35]` | `0x20..0x23` |
| TablePage | `[28..31]` | `0x1C..0x1F` |

### 4.3 Validation Order

Whenever a persisted page is read:

1. Verify the page CRC.
2. If it fails, return `StorageResult::CORRUPTED_PAGE`.
3. Validate page magic/version/page size where applicable.
4. Validate page-specific structural invariants.

Checksum validation always precedes interpretation of variable offsets, tuple lengths, slot entries, or page links.

---

## 5. Page Accessor and Allocation Contract

```cpp
class IPageAccessor {
public:
    virtual ~IPageAccessor() = default;

    // Retrieves a mutable pointer to exactly DATABASE_PAGE_SIZE bytes.
    // The accessor owns the memory. The pointer remains valid until database
    // shutdown in Phase 1; Phase 1 has no eviction.
    virtual StorageResult fetch_page(
        page_id_t page_id,
        uint8_t** out_page) = 0;

    // Allocates and zero-initializes the specified append-only page ID.
    // The caller supplies the ID from its pending MasterData.page_count.
    virtual StorageResult allocate_page(
        page_id_t expected_page_id,
        uint8_t** out_page) = 0;

    // Marks a previously fetched or allocated page dirty after byte mutation.
    virtual StorageResult mark_dirty(page_id_t page_id) = 0;

    // Persists the dirty page to the underlying backend.
    virtual StorageResult flush_page(page_id_t page_id) = 0;

    // Persists all currently dirty pages to the underlying backend.
    virtual StorageResult flush_dirty_pages() = 0;

    // Requests a durability barrier from the backend.
    virtual StorageResult sync() = 0;
};
```

### 5.1 Ownership and Mutation Rules

- The accessor owns page buffers.
- A caller must invoke `mark_dirty(page_id)` after changing any page bytes.
- A caller must not mutate a page buffer after a failed accessor operation.
- A fetch of an unallocated page returns `StorageResult::IO_ERROR`.
- `allocate_page()` must reject an ID that is not the next append-only physical page ID.

### 5.2 Canonical Allocation Rule

`MasterData.page_count` is the authoritative logical allocation cursor.

```text
page_count == total pages allocated == next unallocated page ID
```

To allocate a page during a pending metadata update:

1. Let `new_page_id = pending_master.page_count`.
2. Call `accessor.allocate_page(new_page_id, &buffer)`.
3. Initialize the page and mark it dirty.
4. Increment `pending_master.page_count`.
5. Publish the new `page_count` only when `commit_master()` succeeds.

No page IDs are reused in Phase 1.

---

## 6. Dual Master Pages

### 6.1 Master Page IDs

| Page ID | Meaning |
|---:|---|
| `0` | Master A |
| `1` | Master B |
| `>= 2` | Data pages |

### 6.2 In-Memory Representation

```cpp
struct MasterData {
    uint16_t version{1};
    uint16_t page_size{DATABASE_PAGE_SIZE};
    generation_id_t generation_id{0};

    page_id_t system_tables_root{INVALID_PAGE_ID};
    page_id_t system_columns_root{INVALID_PAGE_ID};
    page_id_t system_indexes_root{INVALID_PAGE_ID};

    uint32_t page_count{2};
};
```

### 6.3 On-Disk Layout

| Byte Range | Field | Type | Rule |
|---|---|---|---|
| `0x00..0x03` | magic | `uint32_t` | `0x57454244` (`WEBD`) |
| `0x04..0x05` | version | `uint16_t` | Must be `1` |
| `0x06..0x07` | page_size | `uint16_t` | Must be `4096` |
| `0x08..0x0F` | generation_id | `uint64_t` | Monotonic commit generation |
| `0x10..0x13` | system_tables_root | `int32_t` | Valid data page ID or invalid |
| `0x14..0x17` | system_columns_root | `int32_t` | Valid data page ID or invalid |
| `0x18..0x1B` | system_indexes_root | `int32_t` | Valid data page ID or invalid |
| `0x1C..0x1F` | page_count | `uint32_t` | At least `2` |
| `0x20..0x23` | checksum | `uint32_t` | CRC field |
| `0x24..0xFFF` | reserved | bytes | Must be all zero |

### 6.4 Initialization

`init_new_database()` must create **two fully valid, checksummed master pages**:

| Master | Generation | `page_count` |
|---|---:|---:|
| Master A | `1` | `2` |
| Master B | `0` | `2` |

Both masters have all system roots set to `INVALID_PAGE_ID`.

### 6.5 Master Validation

A valid master requires:

- Valid CRC.
- Correct magic.
- Version `1`.
- Page size `4096`.
- `page_count >= 2`.
- All reserved bytes equal zero.
- Each non-invalid root satisfies:

```text
FIRST_DATA_PAGE_ID <= root < page_count
```

### 6.6 Active Master Selection

1. If both masters are valid and generations differ, choose the higher generation.
2. If both are valid and generations are equal, choose Master A.
3. If exactly one is valid, choose the valid master.
4. If neither is valid, return `StorageResult::CORRUPTED_PAGE`.

### 6.7 Master Commit Sequence

Given the active master, pending `MasterData`, and an optional explicit list of dirty data pages:

1. Flush all dirty data pages (via `dirty_page_ids` and/or `accessor.flush_dirty_pages()`).
2. Call `sync()` (durability barrier guaranteeing data pages are persistent before master update).
3. Serialize the pending metadata to the inactive master page with:
   ```text
   generation_id = active_generation_id + 1
   ```
4. Compute and write the inactive master CRC.
5. Mark the inactive master dirty.
6. Flush the inactive master page (`accessor.flush_page(inactive_master_id)`).
7. Call `sync()` (durability barrier publishing the new master).

If the inactive master is torn or corrupt after a crash, the prior valid master remains selectable.

---

## 7. Table Pages and Slotted Storage

### 7.1 Header Layout

| Byte Range | Field | Type | Rule |
|---|---|---|---|
| `0x00..0x03` | page_id | `int32_t` | Matches requested page ID; must be `>= 2` |
| `0x04..0x07` | prev_page_id | `int32_t` | Valid data page ID or invalid |
| `0x08..0x0B` | next_page_id | `int32_t` | Valid data page ID or invalid |
| `0x0C..0x0D` | slot_count | `uint16_t` | `<= MAX_SLOT_COUNT` |
| `0x0E..0x0F` | free_space_pointer | `uint16_t` | Within valid bounds |
| `0x10..0x17` | generation_id | `uint64_t` | Reserved; must be zero in Phase 1 |
| `0x18..0x1B` | flags | `uint32_t` | Only `HAS_HOLES` may be set |
| `0x1C..0x1F` | checksum | `uint32_t` | CRC field |
| `0x20..0x23` | reserved | `uint32_t` | Must be zero |

`generation_id` is reserved for a later copy-on-write or versioned-page design. Since Phase 1 pages are mutable in place, it must remain zero and has no commit-version semantics.

### 7.2 Slot Layout

Each slot is four bytes:

```text
Bytes 0-1: little-endian packed metadata
  Bits 15-14: SlotState
  Bit 13: reserved, must be 0
  Bits 12-0: payload byte offset within page

Bytes 2-3: little-endian payload length
```

For `LIVE` slots:

```text
1 <= length <= MAX_TUPLE_SIZE
free_space_pointer <= offset
offset + length <= DATABASE_PAGE_SIZE
```

For `DEAD` slots:

```text
offset == 0
length == 0
```

`EMPTY` and `FORWARDED` are invalid inside `[0, slot_count)` in Phase 1.

### 7.3 Slot Directory and Payload Rules

- The slot directory begins at offset `36` and grows upward.
- Tuple payloads grow downward from offset `4096`.
- `free_space_pointer` identifies the lowest byte allocated to any payload.
- Slot indices are stable through compaction.
- New slots are appended by increasing `slot_count`.
- Internal dead slots may be reused by a later insertion.
- Trailing dead slots are removed during compaction.

A deleted or relocated RID is not a stable external identity in Phase 1. Since dead slots may be reused, callers must not retain deleted RIDs as references to future data.

### 7.4 Space Formulas

```text
slot_dir_end =
    PAGE_HEADER_SIZE + slot_count * SLOT_ENTRY_SIZE

allocated_payload_bytes =
    DATABASE_PAGE_SIZE - free_space_pointer

live_payload_bytes =
    sum(length of each LIVE slot)

contiguous_free_space =
    max(0, free_space_pointer - slot_dir_end)

reclaimable_hole_space =
    allocated_payload_bytes - live_payload_bytes

total_free_space_after_compaction =
    contiguous_free_space + reclaimable_hole_space
```

### 7.5 `HAS_HOLES`

`HAS_HOLES` is bit `0` in the table-page flags field.

It is a strict derived invariant:

```text
HAS_HOLES is set if and only if reclaimable_hole_space > 0
```

It must be updated after:

- tuple deletion;
- shrinking in-place updates;
- relocated updates;
- reuse of a dead slot;
- defragmentation.

Defragmentation clears `HAS_HOLES`.

### 7.6 Validation Rules

`TablePage::validate(expected_page_id, page_count)` must enforce:

1. Valid CRC.
2. `page_id == expected_page_id`.
3. `page_id >= FIRST_DATA_PAGE_ID`.
4. `slot_count <= MAX_SLOT_COUNT`.
5. `slot_dir_end <= free_space_pointer <= DATABASE_PAGE_SIZE`.
6. `prev_page_id` and `next_page_id` are either `INVALID_PAGE_ID` or satisfy:
   ```text
   FIRST_DATA_PAGE_ID <= page_id < page_count
   ```
7. Neither page link equals the page’s own ID.
8. `generation_id == 0`.
9. Only `HAS_HOLES` is set in `flags`.
10. Reserved header bytes are zero.
11. Every slot entry has its reserved bit clear.
12. Every slot in `[0, slot_count)` is `LIVE` or `DEAD`.
13. Every `DEAD` slot has zero offset and zero length.
14. Live payload ranges are within bounds and do not overlap.
15. `HAS_HOLES` equals the derived hole-state calculation.

A validation failure returns `StorageResult::CORRUPTED_PAGE`.

### 7.7 Defragmentation

`defragment()` must:

1. Preserve every live slot index.
2. Copy live payloads in ascending slot-index order.
3. Pack payloads consecutively downward from `DATABASE_PAGE_SIZE`.
4. Preserve exact serialized tuple bytes.
5. Set every internal dead slot to `state = DEAD`, `offset = 0`, `length = 0`.
6. Remove trailing dead slots.
7. Set `free_space_pointer` to the beginning of the packed live payload region.
8. Clear `HAS_HOLES`.
9. Recompute and write the page checksum after mutation.

After pruning:

```text
new_slot_count =
    highest LIVE slot index + 1,
    or 0 if no LIVE slots remain
```

---

## 8. Tuple Format, Schema, and Values

### 8.1 Schema Model

```cpp
struct Column {
    TypeId type{TypeId::INVALID};
    bool is_nullable{false};
};

class Schema {
public:
    size_t count() const noexcept;
    const Column& column(size_t index) const;
};
```

A schema is valid only when:

- `1 <= count() <= MAX_COLUMNS`;
- every column has type `INT`, `DOUBLE`, or `TEXT`;
- no column has `TypeId::INVALID`.

### 8.2 Value Model

`Value` represents one of:

- SQL `NULL`;
- `int64_t`;
- `double`;
- UTF-8 `std::string`.

A non-null `Value` must match the associated schema column type. Mismatched input values return `StorageResult::SCHEMA_MISMATCH`.

### 8.3 Tuple Encoding

```text
+--------------------------------------------------------------------------------+
| format_version (1) | flags (1) | num_columns (2) | null_bitmap (ceil(N / 8)) |
+--------------------------------------------------------------------------------+
| fixed-width values: N entries × 8 bytes                                      |
+--------------------------------------------------------------------------------+
| text bytes, concatenated in ascending column order                            |
+--------------------------------------------------------------------------------+
```

- `format_version` must equal `1`.
- `flags` must equal `0`.
- `num_columns` is little-endian `uint16_t`.
- A null bitmap bit of `1` means the corresponding column is SQL `NULL`.

Each fixed-width entry is:

| Column Type | Fixed Field |
|---|---|
| `INT` | little-endian `int64_t` |
| `DOUBLE` | little-endian IEEE-754 `double` |
| `TEXT` | little-endian `{ uint32_t var_offset, uint32_t var_length }` |

### 8.4 Deterministic NULL and TEXT Rules

- A NULL column’s complete 8-byte fixed-width entry must be zero.
- A NULL `TEXT` column consumes no variable payload bytes.
- Empty strings are valid and have `var_length == 0`.
- Text payload bytes are concatenated in ascending schema-column order.
- For each non-null text column, `var_offset` must equal the running text-payload cursor.
- The final cursor must equal the tuple’s total variable-payload length.
- Therefore, overlapping, non-monotonic, skipped, or trailing unused text ranges are invalid.
- Text must be valid UTF-8 on construction and deserialization.

### 8.5 Tuple Validation

`Tuple::deserialize()` must validate:

1. Input size does not exceed `MAX_TUPLE_SIZE`.
2. Input size is at least:
   ```text
   4 + ceil(column_count / 8) + column_count * 8
   ```
3. Tuple format version is `1`.
4. Tuple flags are `0`.
5. Serialized column count equals the provided schema count.
6. Every NULL value is allowed by the schema.
7. NULL fixed fields are all zero.
8. Every text range follows the deterministic cursor rule.
9. Every text range lies within the variable payload region.
10. Every text payload is valid UTF-8.

Malformed persisted tuple bytes return `StorageResult::CORRUPTED_PAGE`. Invalid caller-provided values or schema/value mismatches return `StorageResult::SCHEMA_MISMATCH` or `StorageResult::INVALID_ARGUMENT` as appropriate.

---

## 9. Comparison and SQL Three-Valued Logic

Comparison methods return `std::optional<bool>`:

- `true`: SQL `TRUE`
- `false`: SQL `FALSE`
- `std::nullopt`: SQL `UNKNOWN`

### 9.1 NULL and NaN

- Comparing NULL with any value returns `UNKNOWN`.
- Comparing a `DOUBLE` NaN with any value returns `UNKNOWN`.
- `+0.0` and `-0.0` compare equal.
- Positive and negative infinity use normal IEEE ordering against finite values.

### 9.2 Text Comparison

Text uses exact bytewise comparison:

```cpp
std::string_view::compare
```

No Unicode normalization, locale collation, or case folding occurs in the storage engine.

### 9.3 Exact INT/DOUBLE Equality

For `int64_t i` and `double d`:

```cpp
std::optional<bool> compare_int_double_equal(int64_t i, double d) {
    if (std::isnan(d)) {
        return std::nullopt;
    }

    if (!std::isfinite(d)) {
        return false;
    }

    constexpr double kMinInt64 = -9223372036854775808.0; // -2^63
    constexpr double kPastMaxInt64 = 9223372036854775808.0; // 2^63

    if (d < kMinInt64 || d >= kPastMaxInt64) {
        return false;
    }

    double integral_part;
    if (std::modf(d, &integral_part) != 0.0) {
        return false;
    }

    return i == static_cast<int64_t>(integral_part);
}
```

### 9.4 Exact INT/DOUBLE Less-Than

For finite `d` within the signed 64-bit range:

```text
i < d:
  if d is integral: i < int64(d)
  otherwise:        i <= floor(d)

d < i:
  if d is integral: int64(d) < i
  otherwise:        ceil(d) <= i
```

Values outside the range are handled before conversion:

| Expression | `d <= -2^63` | `d >= 2^63` |
|---|---:|---:|
| `i < d` | false | true |
| `d < i` | true | false |

No out-of-range floating-point value may be converted to `int64_t`.

---

## 10. TableHeap and Iterator

### 10.1 TableHeap State

A `TableHeap` stores:

- `first_page_id`;
- `last_page_id`;
- a reference to `IPageAccessor`;
- a pointer/reference to mutable `MasterData& pending_master` needed for append-only page allocation.

`last_page_id` is an in-memory append optimization. When opening a heap via `TableHeap::open(accessor, pending_master, first_page_id, out_heap)`, it accepts mutable pending metadata and reconstructs `last_page_id` by walking from `first_page_id` and validating chain links.

### 10.2 Insert

```cpp
StorageResult insert_tuple(const Tuple& tuple, RID* out_rid);
```

Insert order:

1. Reject serialized tuples larger than `MAX_TUPLE_SIZE`.
2. Attempt insertion into `last_page_id`.
3. If contiguous space is insufficient and `HAS_HOLES` is set, defragment and retry.
4. If still full, allocate a new page using the pending master `page_count`.
5. Initialize and link the new page:
   - new page `prev_page_id = old_last_page_id`;
   - new page `next_page_id = INVALID_PAGE_ID`;
   - old last page `next_page_id = new_page_id`;
   - update in-memory `last_page_id`.
6. Insert the tuple into the new page.

### 10.3 Update

```cpp
UpdateResult update_tuple(const RID& rid, const Tuple& new_tuple);
```

Decision order:

1. Reject an oversized serialized tuple.
2. Fetch and validate the source page.
3. Confirm that `rid.slot_num < slot_count` and the slot is `LIVE`.
4. If `new_size <= old_size`, overwrite the tuple in place:
   - preserve the RID;
   - if smaller, record the reclaimed bytes as holes.
5. Otherwise, if the growth delta fits in contiguous free space, allocate a new payload region in the same page and update the same slot.
6. Otherwise, if the growth delta fits after compaction, compact and update the same slot.
7. Otherwise:
   - insert the new tuple elsewhere;
   - mark the old slot `DEAD`;
   - return distinct old/new RIDs with `rid_changed = true`.

Phase 1 never writes `FORWARDED` slots.

### 10.4 Delete

```cpp
StorageResult delete_tuple(const RID& rid);
```

Deletion:

1. Fetch and validate the page.
2. Require that the target slot exists and is `LIVE`.
3. Change the slot to `DEAD`.
4. Set slot offset and length to zero.
5. Recalculate `HAS_HOLES`.
6. Mark the page dirty.

### 10.5 Iterator

```cpp
enum class IteratorStatus : uint8_t {
    AT_RECORD = 0,
    END_OF_SCAN,
    CORRUPTED_PAGE,
    CYCLE_DETECTED,
    PAGE_NOT_FOUND,
};
```

The iterator:

- maintains a visited page-ID set bounded by `MAX_PAGES`;
- validates every fetched table page;
- checks:
  ```text
  current_page.prev_page_id == previous_page_id
  ```
- returns `CYCLE_DETECTED` if a page is visited twice or traversal exceeds `MAX_PAGES`;
- distinguishes normal end-of-scan from page corruption or missing pages.

---

## 11. Source Layout

```text
src/
├── common/
│   └── checksum.cpp
├── include/
│   ├── common/
│   │   ├── checksum.hpp
│   │   ├── endian.hpp
│   │   └── types.hpp
│   └── storage/
│       ├── master_page.hpp
│       ├── page_accessor.hpp
│       ├── slotted_page.hpp
│       ├── table_heap.hpp
│       ├── tuple.hpp
│       └── value.hpp
└── storage/
    ├── master_page.cpp
    ├── slotted_page.cpp
    ├── table_heap.cpp
    ├── tuple.cpp
    └── value.cpp

tests/
└── test_storage.cpp
```

CMake must compile `src/common/checksum.cpp`, all Phase 1 storage sources, and register `tests/test_storage.cpp`.

---

## 12. Required Test Matrix

### 12.1 Checksums

- Verify known CRC-32 IEEE 802.3 test vectors.
- Compute valid master and table checksums using their distinct checksum offsets.
- Mutate bytes at offsets `0`, `100`, and `4095`; validation must fail.
- Mutate the stored checksum field; validation must fail.
- Verify all checksum calculations cover exactly 4096 bytes.

### 12.2 Master Pages

- New database creates two valid checksummed masters.
- Master A starts at generation `1`; Master B starts at generation `0`.
- Active master after initialization is Master A.
- Valid higher-generation Master B becomes active after a commit.
- Equal valid generations select Master A.
- One corrupted master falls back to the other valid master.
- Both corrupted masters return `CORRUPTED_PAGE`.
- Invalid roots, invalid `page_count`, and nonzero reserved bytes are rejected.

### 12.3 Slotted Pages

- Empty initialized page validates.
- Insert a tuple of exact serialized size `MAX_TUPLE_SIZE`; it succeeds on an empty page.
- A tuple of `MAX_TUPLE_SIZE + 1` is rejected with `TUPLE_TOO_LARGE`.
- Fill a page until insertion returns `PAGE_FULL`.
- Delete alternating tuples and verify hole accounting.
- Defragment and verify all live RIDs retain their slot numbers and exact tuple bytes.
- Verify payloads are packed in ascending slot-index order.
- Verify trailing dead-slot pruning reduces `slot_count`.
- Verify malformed slot offsets, overlap, reserved slot bits, invalid states, and bad flags return `CORRUPTED_PAGE`.
- Verify `HAS_HOLES` is correct after delete, shrink, reuse, and compaction.

### 12.4 Tuples and Alignment

- Exercise schemas with `1`, `3`, and `5` columns under UBSan or equivalent alignment-sensitive checks.
- Round-trip `INT`, `DOUBLE`, empty TEXT, non-empty TEXT, and NULL values.
- Reject malformed UTF-8 on input and deserialization.
- Reject nonzero tuple flags.
- Reject a wrong serialized column count.
- Reject out-of-range, overlapping, skipped, and trailing text regions.
- Reject nonzero fixed-width fields for NULL columns.
- Reject NULL in a non-nullable schema column.

### 12.5 Numeric and 3VL Comparison

- `NULL = NULL` returns `UNKNOWN`.
- NaN comparisons return `UNKNOWN`.
- `+0.0 == -0.0`.
- `INT64_MIN` compares correctly with `-2^63`.
- `2^63` must never be cast to `int64_t`.
- Verify equality and less-than around `2^53`, where not every integer is exactly representable as a double.
- Verify finite/infinite ordering behavior.

### 12.6 TableHeap and Iteration

- Insert enough tuples to span at least five pages.
- Scan all tuples in insertion order.
- Reopen/reconstruct the heap tail by walking the chain.
- Update a tuple with a larger payload that remains on the same page.
- Update a tuple requiring relocation and verify old/new RID distinction.
- Verify an old deleted or relocated RID does not resolve as a stable external identity.
- Detect a corrupted self-link, a broken backward link, and a multi-page cycle.
- Verify iterator distinguishes end-of-scan, page-not-found, corruption, and cycle detection.

---

## 13. Implementation Sign-Off Checklist

- [ ] `MAX_SLOT_COUNT` is implemented as `1015`.
- [ ] Page checksum code masks the correct four-byte field for each page type.
- [ ] All persisted multi-byte values use endian helpers.
- [ ] Master A and Master B are both initialized as valid checksummed pages.
- [ ] `page_count` is the authoritative next unallocated page ID.
- [ ] Allocation is append-only and coordinated with pending master metadata.
- [ ] Phase 1 crash scope is documented as detection, not data-page recovery.
- [ ] `IPageAccessor` returns `StorageResult`; no expected errors use exceptions.
- [ ] `UpdateResult` includes a status code.
- [ ] `FORWARDED` is rejected in Phase 1 persisted pages.
- [ ] `EMPTY` is not valid within the persisted slot-directory range.
- [ ] `HAS_HOLES` is maintained as a strict derived invariant.
- [ ] Table-page generation is reserved and zero in Phase 1.
- [ ] Tuple TEXT ranges follow deterministic packed cursor semantics.
- [ ] Numeric comparisons avoid undefined out-of-range float-to-integer conversions.
- [ ] Required source files, CMake targets, and test targets are included.