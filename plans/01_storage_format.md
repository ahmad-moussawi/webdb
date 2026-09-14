# Phase 1: Storage Format, Dual Master Pages & Slotted Pages (Detailed Technical Plan)

This document provides the exhaustive technical specification and implementation plan for **Phase 1** of WebDB.
It incorporates all refinements for unaligned memory safety, CRC-32 IEEE 802.3 specifications, dual-master atomic commits, 6-byte RID forwarding resolution, trailing slot pruning, and exact mathematical free-space accounting prior to code implementation.

---

## 1. Architectural Decisions & Key Clarifications

### 1.1 Universal Checksum Definition (CRC-32 IEEE 802.3)
Every page (both Master and Slotted Data pages) uses a single, unambiguous rule:
- **Standard**: **CRC-32 IEEE 802.3** (polynomial `0xEDB88320`, initial value `0xFFFFFFFF`, final XOR `0xFFFFFFFF`).
- **Rule**:
  ```text
  CRC32 = CRC32(entire 4096 bytes, with the 4-byte checksum field treated as 0x00000000)
  ```
- **Zero-Masking Byte Offsets During Computation**:
  - `MasterPage`: bytes `[32..35]` (`0x20..0x23`) are zeroed during calculation.
  - `TablePage`: bytes `[28..31]` (`0x1C..0x1F`) are zeroed during calculation.
- **Evaluation Order on Page Read**:
  1. Verify CRC32 checksum against computed value. If mismatched $\rightarrow$ fail immediately (`PageCorrupted`).
  2. Inspect format version and magic numbers.
  3. Validate structural invariants (slot bounds, free-space pointer, non-overlapping payloads).

### 1.2 Dual Master Pages for Crash-Resilient Commits (Page 0 & Page 1)
To ensure atomic commits and crash safety across **all** backends (native POSIX files, OPFS `SyncAccessHandle`, and IndexedDB):
- **Page 0 (`Master A`)** and **Page 1 (`Master B`)** form an alternating **Dual Master Page** pair.
- The active, authoritative master is determined by:
  $$\text{Active Master} = \arg\max \big\{ \text{generation\_id} \mid \text{valid CRC32 and valid Header} \big\}$$
- **Initial Bootstrapping State (`init_new_database`)**:
  - `system_tables_root = INVALID_PAGE_ID` (`-1`)
  - `system_columns_root = INVALID_PAGE_ID` (`-1`)
  - `system_indexes_root = INVALID_PAGE_ID` (`-1`)
  - `page_count = 2` (pages 0 and 1 allocated; first user data page will be `page_id = 2`).
  - Master A: `generation_id = 1`
  - Master B: `generation_id = 0`
- **Commit Sequence**:
  1. Write and flush all dirty data pages to storage (`accessor.flush_page(id)`).
  2. Issue a barrier sync (`accessor.sync()`).
  3. Write the inactive master slot with $\text{generation\_id} = \text{active\_generation\_id} + 1$ and a freshly calculated CRC32.
  4. Flush the updated master page and issue `accessor.sync()`.
- If a crash occurs during step 3, the other master page retains the previous generation and clean root pointers. The torn write is rejected by CRC32 mismatch or lower generation counter.
- User data pages start at `page_id >= 2`.

### 1.3 RID Stability, Update Policy & Forwarding Resolution
- **Physical RID**: `RID = { page_id_t page_id, uint16_t slot_num }`.
- Compaction/defragmentation shifts tuple payloads inside the page but **never alters slot indices**. Thus, pure compaction does not change RIDs.
- **Update Policy**:
  - `update_tuple()` returns a structured result:
    ```cpp
    struct UpdateResult {
        bool success;
        RID old_rid;
        RID new_rid;
        bool rid_changed;
    };
    ```
  - **In-Place Update**: If `new_tuple_size <= old_tuple_size`, or if sufficient free space exists within the same page, the tuple is updated in place, retaining its original `slot_num` (`rid_changed = false`).
  - **Relocated Update (Phase 1 Policy)**:
    - If the updated tuple cannot fit on the existing page:
      - The new tuple is inserted on another page (yielding `new_rid`).
      - In Phase 1, the old slot is marked `SlotState::DEAD` (with its old payload reclaimed), and `update_tuple` returns `UpdateResult { success: true, old_rid, new_rid, rid_changed: true }`.
      - When secondary indexes are introduced in Phase 3, if a forwarding pointer is required, the slot state will transition to `SlotState::FORWARDED` where its `offset` points to a dedicated 6-byte in-page payload `{ page_id (4B), slot_num (2B) }` and `length = 6`.

### 1.4 Unaligned Memory Access & WebAssembly Portability
- **Constraint**: Tuple headers contain variable-width fields (`FormatVersion (1B) + Flags (1B) + NumColumns (2B) + NullBitmap (ceil(N/8) B)`). For odd column counts (e.g., $N=1$), subsequent 8-byte scalar values (`int64_t`, `double`) start at odd, unaligned byte boundaries.
- **Strict Rule**:
  - `tuple.cpp`, `slotted_page.cpp`, and `master_page.cpp` **never perform raw pointer casts to multi-byte scalar types** (`reinterpret_cast<int64_t*>`).
  - All multi-byte reads and writes must pass through canonical `std::memcpy`-based endianness helpers in `src/include/common/endian.hpp` (`read_int64_le`, `write_int64_le`, `read_double_le`, `write_double_le`). This prevents undefined behavior and hardware alignment faults on ARM64 and WebAssembly.

### 1.5 Strict Size Limits & Integer Overflow Protection
To prevent integer overflow and guarantee that every serialized tuple fits inside a single 4096-byte page:
- `PAGE_SIZE = 4096` bytes.
- `PAGE_HEADER_SIZE = 36` bytes.
- `SLOT_ENTRY_SIZE = 4` bytes.
- `MAX_SLOT_COUNT = 1005` ($ (4096 - 36) / 4 $).
- **`MAX_TUPLE_SIZE = 4056` bytes** ($4096 - 36 - 4$).
- **`MAX_COLUMNS = 256`**.
- **`MAX_TEXT_SIZE = 4056` bytes**.
- `HAS_OVERFLOW` flag is **deferred** from Phase 1. Any tuple exceeding `MAX_TUPLE_SIZE` is strictly rejected with `StorageResult::TUPLE_TOO_LARGE`.
- Deserialization and size calculation rules:
  - All arithmetic `offset + length` is validated using `uint32_t` before bounds checking against `PAGE_SIZE` to prevent 16-bit wrap-around.

### 1.6 Storage Growth Terminology & Explicit Free-Space Formulas
- **Slot directory**: Starts at `PAGE_HEADER_SIZE` (byte 36) and grows **upward** (toward higher byte addresses).
- **Tuple payloads**: Placed at the bottom of the page and grow **downward** from byte 4096 (toward lower byte addresses).
- **Free space**: The gap between the end of the slot directory and the lowest tuple payload (`free_space_pointer`).

#### Exact Mathematical Formulas:
$$\text{slot\_dir\_end} = \text{PAGE\_HEADER\_SIZE} + (\text{slot\_count} \times \text{SLOT\_ENTRY\_SIZE})$$
$$\text{AllocatedPayloadBytes} = \text{PAGE\_SIZE} - \text{free\_space\_pointer}$$
$$\text{LivePayloadBytes} = \sum_{i \in \text{LIVE}} \text{slot}[i].\text{length}$$
$$\text{contiguous\_free\_space}() = \begin{cases} \text{free\_space\_pointer} - \text{slot\_dir\_end} & \text{if } \text{free\_space\_pointer} \ge \text{slot\_dir\_end} \\ 0 & \text{otherwise} \end{cases}$$
$$\text{reclaimable\_hole\_space}() = \text{AllocatedPayloadBytes} - \text{LivePayloadBytes}$$
$$\text{total\_free\_space\_after\_compaction}() = \text{contiguous\_free\_space}() + \text{reclaimable\_hole\_space}()$$

#### Slot Directory Pruning during Compaction:
- When performing `defragment()`:
  - Internal dead slots are preserved with `offset = 0`, `length = 0`, `state = DEAD` to maintain `slot_num` stability for existing external RIDs.
  - **Trailing dead slots** at the end of the slot array are safely pruned:
    $$\text{new\_slot\_count} = \begin{cases} \max \big\{ i \mid \text{slot}[i].\text{state} == \text{LIVE} \big\} + 1 & \text{if any live slots exist} \\ 0 & \text{if all slots dead} \end{cases}$$
  - Pruning trailing dead slots shrinks `slot_dir_end`, directly reclaiming slot directory space as contiguous free space.

### 1.7 Decoupled Storage Interface for Phase 1 (`IPageAccessor`)
To avoid coupling Phase 1 storage structures to the future Phase 2 asynchronous buffer pool, Phase 1 defines an abstract `IPageAccessor` with explicit synchronization:
```cpp
class IPageAccessor {
public:
    virtual ~IPageAccessor() = default;
    virtual uint8_t* fetch_page(page_id_t page_id) = 0;
    virtual page_id_t allocate_page() = 0;
    virtual void mark_dirty(page_id_t page_id) = 0;
    virtual void flush_page(page_id_t page_id) = 0;
    virtual void sync() = 0;
};
```
Phase 1 tests implement a synchronous `InMemoryPageAccessor` wrapping `InMemoryFileSystem`. Phase 2 will plug the `BufferPoolManager` into this boundary.

---

## 2. Directory & Header Layout

```text
src/
├── include/
│   ├── common/
│   │   ├── types.hpp          # Primitives, RID, TypeId, Result codes
│   │   ├── endian.hpp         # Canonical Little-Endian memcpy-based helpers
│   │   └── checksum.hpp       # CRC-32 IEEE 802.3 implementation
│   └── storage/
│       ├── page_accessor.hpp  # IPageAccessor interface
│       ├── master_page.hpp    # Dual Master Page (Page 0 & Page 1) layout
│       ├── slotted_page.hpp   # Slotted TablePage, compaction, slot state machine
│       ├── tuple.hpp          # Schema, NullBitmap, binary tuple serialization
│       ├── value.hpp          # Runtime Value variant & 3VL comparison rules
│       └── table_heap.hpp     # Doubly-linked TablePage chain, cycle detection, iterator
└── storage/
    ├── master_page.cpp
    ├── slotted_page.cpp
    ├── tuple.cpp
    ├── value.cpp
    └── table_heap.cpp
```

---

## 3. Component Deep Dive & Specifications

### 3.1 Common Primitives & Types (`src/include/common/types.hpp`)

```cpp
#pragma once

#include <cstdint>
#include <cstddef>
#include <string_view>

namespace webdb {

using page_id_t = int32_t;
using generation_id_t = uint64_t;

inline constexpr page_id_t INVALID_PAGE_ID = -1;
inline constexpr page_id_t MASTER_PAGE_A_ID = 0;
inline constexpr page_id_t MASTER_PAGE_B_ID = 1;
inline constexpr page_id_t FIRST_DATA_PAGE_ID = 2;

inline constexpr size_t PAGE_SIZE = 4096;
inline constexpr size_t PAGE_HEADER_SIZE = 36;
inline constexpr size_t SLOT_ENTRY_SIZE = 4;
inline constexpr size_t MAX_TUPLE_SIZE = PAGE_SIZE - PAGE_HEADER_SIZE - SLOT_ENTRY_SIZE; // 4056 bytes
inline constexpr uint16_t MAX_COLUMNS = 256;

enum class TypeId : uint8_t {
    INVALID = 0,
    INT = 1,      // 64-bit signed integer (int64_t)
    DOUBLE = 2,   // 64-bit IEEE-754 double (double)
    TEXT = 3      // UTF-8 string (byte-compared, no normalization)
};

enum class SlotState : uint8_t {
    EMPTY = 0,
    LIVE = 1,
    DEAD = 2,
    FORWARDED = 3
};

struct RID {
    page_id_t page_id{INVALID_PAGE_ID};
    uint16_t slot_num{0};

    constexpr bool is_valid() const noexcept {
        return page_id != INVALID_PAGE_ID;
    }

    constexpr bool operator==(const RID& other) const noexcept = default;
};

struct UpdateResult {
    bool success{false};
    RID old_rid{};
    RID new_rid{};
    bool rid_changed{false};
};

enum class StorageResult : uint8_t {
    SUCCESS = 0,
    PAGE_FULL,
    TUPLE_TOO_LARGE,
    SLOT_NOT_FOUND,
    CORRUPTED_PAGE,
    VERSION_MISMATCH,
    SCHEMA_MISMATCH,
    INVALID_ARGUMENT
};

} // namespace webdb
```

---

### 3.2 Canonical Little-Endian Serialization (`src/include/common/endian.hpp`)

To ensure complete safety against unaligned memory access faults in WebAssembly and ARM:
```cpp
#pragma once

#include <cstdint>
#include <cstring>
#include <bit>

namespace webdb::endian {

template <typename T>
inline T read_le(const uint8_t* src) noexcept {
    static_assert(std::is_trivially_copyable_v<T>);
    T val;
    std::memcpy(&val, src, sizeof(T));
    if constexpr (std::endian::native == std::endian::big) {
        // Swap bytes on big-endian hosts
        if constexpr (sizeof(T) == 2) {
            auto v = std::bit_cast<uint16_t>(val);
            v = __builtin_bswap16(v);
            return std::bit_cast<T>(v);
        } else if constexpr (sizeof(T) == 4) {
            auto v = std::bit_cast<uint32_t>(val);
            v = __builtin_bswap32(v);
            return std::bit_cast<T>(v);
        } else if constexpr (sizeof(T) == 8) {
            auto v = std::bit_cast<uint64_t>(val);
            v = __builtin_bswap64(v);
            return std::bit_cast<T>(v);
        }
    }
    return val;
}

template <typename T>
inline void write_le(uint8_t* dst, T val) noexcept {
    static_assert(std::is_trivially_copyable_v<T>);
    if constexpr (std::endian::native == std::endian::big) {
        if constexpr (sizeof(T) == 2) {
            auto v = std::bit_cast<uint16_t>(val);
            v = __builtin_bswap16(v);
            val = std::bit_cast<T>(v);
        } else if constexpr (sizeof(T) == 4) {
            auto v = std::bit_cast<uint32_t>(val);
            v = __builtin_bswap32(v);
            val = std::bit_cast<T>(v);
        } else if constexpr (sizeof(T) == 8) {
            auto v = std::bit_cast<uint64_t>(val);
            v = __builtin_bswap64(v);
            val = std::bit_cast<T>(v);
        }
    }
    std::memcpy(dst, &val, sizeof(T));
}

inline uint16_t read_uint16(const uint8_t* p) noexcept { return read_le<uint16_t>(p); }
inline uint32_t read_uint32(const uint8_t* p) noexcept { return read_le<uint32_t>(p); }
inline uint64_t read_uint64(const uint8_t* p) noexcept { return read_le<uint64_t>(p); }
inline int32_t  read_int32(const uint8_t* p) noexcept  { return read_le<int32_t>(p); }
inline int64_t  read_int64(const uint8_t* p) noexcept  { return read_le<int64_t>(p); }
inline double   read_double(const uint8_t* p) noexcept { return read_le<double>(p); }

inline void write_uint16(uint8_t* p, uint16_t v) noexcept { write_le<uint16_t>(p, v); }
inline void write_uint32(uint8_t* p, uint32_t v) noexcept { write_le<uint32_t>(p, v); }
inline void write_uint64(uint8_t* p, uint64_t v) noexcept { write_le<uint64_t>(p, v); }
inline void write_int32(uint8_t* p, int32_t v) noexcept   { write_le<int32_t>(p, v); }
inline void write_int64(uint8_t* p, int64_t v) noexcept   { write_le<int64_t>(p, v); }
inline void write_double(uint8_t* p, double v) noexcept   { write_le<double>(p, v); }

} // namespace webdb::endian
```

---

### 3.3 Checksum Specification (`src/include/common/checksum.hpp`)

```cpp
#pragma once

#include <cstdint>
#include <cstddef>
#include <span>

namespace webdb::checksum {

// Standard CRC-32 IEEE 802.3 implementation
uint32_t crc32(const uint8_t* data, size_t length) noexcept;

// Computes 4096-byte page checksum with the 4-byte checksum field masked to zero
uint32_t compute_page_checksum(const uint8_t* page_data, size_t checksum_field_offset) noexcept;

} // namespace webdb::checksum
```

---

### 3.4 Dual Master Pages Specification (`src/include/storage/master_page.hpp`)

To guarantee crash recovery, the database reserves:
- `page_id = 0`: Master Copy A
- `page_id = 1`: Master Copy B

#### Binary Layout (Identical for A and B, 4096 bytes):
| Byte Offset | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00 - 0x03` | `magic` | `uint32_t` | Constant `0x57454244` (`"WEBD"`) |
| `0x04 - 0x05` | `version` | `uint16_t` | Engine format version (`1`) |
| `0x06 - 0x07` | `page_size` | `uint16_t` | Canonical page size (`4096`) |
| `0x08 - 0x0F` | `generation_id` | `uint64_t` | Monotonically increasing commit generation |
| `0x10 - 0x13` | `system_tables_root` | `int32_t` | First page of `_system_tables` heap |
| `0x14 - 0x17` | `system_columns_root`| `int32_t` | First page of `_system_columns` heap |
| `0x18 - 0x1B` | `system_indexes_root`| `int32_t` | First page of `_system_indexes` heap |
| `0x1C - 0x1F` | `page_count` | `uint32_t` | Append-only page count (next unallocated page ID) |
| `0x20 - 0x23` | `checksum` | `uint32_t` | CRC32 of all 4096 bytes (with bytes 0x20-0x23 masked to 0) |
| `0x24 - 0xFFF` | `reserved` | `uint8_t[4060]`| Zero-filled reserved space for checkpoint flags |

#### Master Page Manager (`MasterPageManager`):
- `init_new_database(IPageAccessor& accessor)`: Formats Master A with `generation = 1` and Master B with `generation = 0`.
- `load_active_master(IPageAccessor& accessor) -> page_id_t`: Reads Page 0 and Page 1, checks CRC32 and magic. Selects the one with higher valid `generation_id`.
- `commit_master(IPageAccessor& accessor, const MasterData& data) -> bool`:
  1. Identifies the inactive master page.
  2. Serializes `data` with `generation_id = active_gen + 1`.
  3. Computes and writes CRC32.
  4. Marks inactive master dirty, flushes, and syncs.

---

### 3.5 Slotted TablePage Specification (`src/include/storage/slotted_page.hpp`)

`TablePage` manages the physical storage of tuples within a single 4096-byte block.

#### 36-Byte Header Layout:
| Offset | Name | Type | Invariant / Validation Rule |
| :--- | :--- | :--- | :--- |
| `0x00 - 0x03` | `page_id` | `int32_t` | Must match requested `page_id >= 2` |
| `0x04 - 0x07` | `prev_page_id` | `int32_t` | Valid page ID or `INVALID_PAGE_ID` |
| `0x08 - 0x0B` | `next_page_id` | `int32_t` | Valid page ID or `INVALID_PAGE_ID` |
| `0x0C - 0x0D` | `slot_count` | `uint16_t` | $0 \le \text{slot\_count} \le \text{MAX\_SLOT\_COUNT}$ |
| `0x0E - 0x0F` | `free_space_pointer` | `uint16_t` | $36 + (\text{slot\_count} \times 4) \le \text{ptr} \le 4096$ |
| `0x10 - 0x17` | `generation_id` | `uint64_t` | Generation that created this immutable page state |
| `0x18 - 0x1B` | `flags` | `uint32_t` | Bit 0: `HAS_HOLES`. Bits 1–31 must be 0 |
| `0x1C - 0x1F` | `checksum` | `uint32_t` | CRC32 of all 4096 bytes (bytes 0x1C–0x1F masked to 0) |
| `0x20 - 0x23` | `reserved` | `uint32_t` | Reserved (must be 0) |

#### 4-Byte Slot Entry Layout:
```text
Bit 15-14: SlotState (EMPTY = 0, LIVE = 1, DEAD = 2, FORWARDED = 3)
Bit 13:    Reserved (0)
Bit 12-0:  Byte Offset within page (0..4095)
Byte 2-3:  Payload Length (uint16_t, 1..4056 for LIVE; forward target for FORWARDED)
```

#### Structural Validation Rules (`validate()`):
On reading a page, `validate()` enforces:
1. CRC32 checksum matches.
2. `page_id >= FIRST_DATA_PAGE_ID`.
3. `prev_page_id != page_id` and `next_page_id != page_id`.
4. `slot_dir_end() <= free_space_pointer_ <= PAGE_SIZE`.
5. For every `LIVE` slot:
   - `slot.offset >= free_space_pointer_`
   - `slot.offset + slot.length <= PAGE_SIZE`
   - `slot.length > 0` and `slot.length <= MAX_TUPLE_SIZE`
   - Payloads do not overlap any other live slot payload.
6. Unknown flag bits are not set.

---

### 3.6 Tuple Binary Format & Schema (`src/include/storage/tuple.hpp`)

#### Tuple Binary Encoding:
```text
+-----------------------------------------------------------------------------------------------+
| FormatVersion (1B) | Flags (1B) | NumColumns (2B) | NullBitmap (ceil(N/8) B)                 |
+-----------------------------------------------------------------------------------------------+
| Fixed-Width Values Array (N * 8B)                                                             |
+-----------------------------------------------------------------------------------------------+
| Var-Length Payloads: [Raw UTF-8 Bytes for TEXT columns ...]                                   |
+-----------------------------------------------------------------------------------------------+
```

- **`FormatVersion`**: `1`. Deserializer rejects any version $\ne 1$.
- **`Flags`**: 8-bit reserved mask (must be `0` for Phase 1).
- **`NumColumns`**: $N \le 256$.
- **`NullBitmap`**: $\lceil N / 8 \rceil$ bytes. Bit $i = 1$ means column $i$ is NULL.
- **Fixed-Width Array ($N \times 8$ bytes)**:
  - `INT`: 8 bytes Little-Endian `int64_t`.
  - `DOUBLE`: 8 bytes IEEE-754 Little-Endian `double`.
  - `TEXT`: 8 bytes packed as `{ uint32_t var_offset, uint32_t var_length }`.
    - `var_offset`: Byte offset relative to start of Var-Length Payload section.
    - `var_length`: Byte count of UTF-8 string.
- **Var-Length Payloads**: Concatenated UTF-8 bytes.

#### Schema Validation on Decode:
`Tuple::deserialize(const uint8_t* data, size_t size, const Schema& schema, std::vector<Value>& out_values)` validates:
- `size >= 4 + ceil(schema.count() / 8) + schema.count() * 8`.
- `FormatVersion == 1`.
- `NumColumns == schema.count()`.
- For each column $i$:
  - If `NullBitmap[i] == 1`: verify `schema.column(i).is_nullable`. If not nullable $\rightarrow$ reject (`SCHEMA_MISMATCH`).
  - If `TEXT`: verify `var_offset + var_length <= total_var_length`. Verify UTF-8 byte validity.
  - If `INT` or `DOUBLE`: decode using canonical Little-Endian helpers.

---

### 3.7 Type System, Values & 3VL Comparison Policy (`src/include/storage/value.hpp`)

`Value` represents an in-memory decoded scalar value supporting SQL Three-Valued Logic.

#### Text Handling Policy:
- Input strings are validated for UTF-8 conformity on insertion. Malformed UTF-8 is rejected.
- String comparisons use exact bytewise comparison (`std::string_view::compare`).
- No Unicode normalization or collation transforms applied in core engine.
- Identifiers are strictly case-sensitive.

#### Exact `INT` vs `DOUBLE` Comparison Algorithm:
```cpp
inline std::optional<bool> compare_int_double(int64_t i, double d) {
    if (std::isnan(d)) return std::nullopt; // UNKNOWN in 3VL
    
    // Check if double is outside int64 representable range
    if (d > static_cast<double>(std::numeric_limits<int64_t>::max())) return false;
    if (d < static_cast<double>(std::numeric_limits<int64_t>::min())) return false;
    
    // If d has a fractional part, it cannot equal any integer
    double int_part;
    if (std::modf(d, &int_part) != 0.0) return false;
    
    return i == static_cast<int64_t>(d);
}
```

#### 3VL Kleene Logic Truth Table:
`compare_equals()` and `compare_less_than()` return `std::optional<bool>`:
- `true` $\rightarrow$ `TRUE`
- `false` $\rightarrow$ `FALSE`
- `std::nullopt` $\rightarrow$ `UNKNOWN`

| Left | Operator | Right | Result |
| :--- | :--- | :--- | :--- |
| `NULL` | any | any | `UNKNOWN` (`std::nullopt`) |
| any | any | `NULL` | `UNKNOWN` (`std::nullopt`) |
| `10` | `=` | `10` | `true` |
| `10` | `=` | `20` | `false` |
| `'abc'` | `<` | `'abd'` | `true` (bytewise) |

---

### 3.8 TableHeap & Chain Protection (`src/include/storage/table_heap.hpp`)

`TableHeap` represents an un-ordered table storage abstraction across a doubly-linked chain of `TablePage`s.

#### Key Invariants & Operations:
1. **Append Optimization**: Maintains `last_page_id` in memory to allow $O(1)$ appends without traversing the chain from `first_page_id`.
2. **Cycle & Linkage Protection**:
   - `TableIterator` maintains a visited-page set (or cycle detector) capped at `MAX_PAGES` to prevent infinite loops from corrupted `next_page_id` pointers.
   - On page access, asserts that `current_page->prev_page_id == previous_page_id`.
3. **`insert_tuple(const Tuple& tuple, RID* out_rid)`**:
   - Attempts insert on `last_page_id`.
   - If full, attempts defragmentation. If still full, allocates a new page, sets `new_page->prev_page_id = last_page_id`, `last_page->next_page_id = new_page_id`, and updates `last_page_id = new_page_id`.
4. **`update_tuple(const RID& rid, const Tuple& new_tuple) -> UpdateResult`**:
   - Updates in-place if possible.
   - If space is insufficient, marks old slot `DEAD` and inserts on `last_page_id`, returning `UpdateResult { success: true, old_rid, new_rid, rid_changed: true }`.
5. **`delete_tuple(const RID& rid) -> bool`**:
   - Sets slot state to `DEAD`, increments hole count, sets `HAS_HOLES` flag.

---

## 4. Test Suite & Verification Matrix (`tests/test_storage.cpp`)

The test suite will cover 100% of the Phase 1 edge cases:

1. **CRC-32 IEEE 802.3 & Checksum Tests**:
   - Full 4096-byte checksum verification with zero-masked fields.
   - Mutation test: Flip bit at offset 0, offset 100, offset 4095; verify checksum fails.
   - Verify checksum field mutation itself causes verification failure.
2. **Dual Master Page Tests**:
   - Initial state: Master A valid (gen 1), Master B empty (gen 0). Active = A.
   - Interrupted write test: Corrupt Master B during write; verify engine still boots into Master A.
   - Clean commit test: Write Master B (gen 2); verify engine boots into Master B.
3. **Slotted Page Structural Integrity**:
   - Insert until `contiguous_free_space < tuple_size`.
   - Delete alternating slots; verify `contiguous_free_space` is small but `reclaimable_hole_space` is large.
   - Trigger `defragment()`; verify all live slots retain exact byte content and valid offsets.
   - Verify trailing dead slots are pruned, expanding contiguous space.
   - Invariant validation: Craft malformed page buffers (slot overlaps, `free_space_pointer` < header end, out-of-bounds offsets) and assert `validate()` returns false.
4. **Tuple Size Boundaries & Alignment Safety**:
   - Insert tuple of exact size `MAX_TUPLE_SIZE (4056 B)` $\rightarrow$ Success.
   - Insert tuple of size $4057$ B $\rightarrow$ Rejected with `TUPLE_TOO_LARGE`.
   - Verify non-aligned scalar offsets (e.g., $N=1, 3, 5$) read/write without crashes or UBSan errors.
5. **3VL & UTF-8 Tests**:
   - `Value::compare_equals(NULL, NULL)` returns `std::nullopt`.
   - Exact `INT` vs `DOUBLE` precision comparison tests.
   - Malformed UTF-8 sequence in `TEXT` column $\rightarrow$ Rejected on tuple construction.
   - Type mismatch during decoding (e.g. string payload for INT column) $\rightarrow$ Rejected.
6. **TableHeap & Iterator Tests**:
   - Multi-page insert spanning 5+ pages.
   - Sequential scan reads all tuples back in order.
   - Update with enlargement: Verify `UpdateResult.rid_changed == true` and old/new RIDs are distinct.
   - Corrupted next pointer: Detect cycle and terminate iterator with error instead of hanging.

---

## 5. Review Sign-off Checklist

- [x] Standardized on CRC-32 IEEE 802.3 with explicit field zero-masking offsets.
- [x] Dual Master Pages (Page 0 & Page 1) specify crash-safe root updates for all backends.
- [x] Forwarding RID 6-byte resolution and explicit `UpdateResult` policy defined.
- [x] Unaligned memory access eliminated via `std::memcpy` endianness helpers.
- [x] Explicit formulas for `reclaimable_hole_space()` and trailing slot pruning.
- [x] `IPageAccessor` includes explicit `flush_page()` and `sync()` primitives.
- [x] Exact algorithm for `INT` vs `DOUBLE` 3VL comparison formalized.
- [x] Hard limits defined: max tuple (4056 B), max columns (256), `HAS_OVERFLOW` deferred.
- [x] Comprehensive test matrix created.
