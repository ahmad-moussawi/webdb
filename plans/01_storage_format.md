# Phase 1: Storage Format, Dual Master Pages & Slotted Pages (Detailed Technical Plan)

This document provides the exhaustive technical specification and implementation plan for **Phase 1** of WebDB.
It resolves all checksum coverage rules, RID stability policies, size limits, dual-master crash recovery, and malformed page validation invariants prior to beginning code implementation.

---

## 1. Architectural Decisions & Key Clarifications

### 1.1 Universal Checksum Definition & Checksum Offset Rationale
Every page uses **CRC-32 IEEE 802.3** (polynomial `0xEDB88320`, initial value `0xFFFFFFFF`, final XOR `0xFFFFFFFF`) calculated over the entire 4096 bytes with its 4-byte checksum field treated as `0x00000000`.

- **Deliberate Checksum Field Placement Differences**:
  - `MasterPage`: Checksum is at bytes `[32..35]` (`0x20..0x23`), following the fixed 32-byte database identity header.
  - `TablePage`: Checksum is at bytes `[28..31]` (`0x1C..0x1F`), placed directly before the 4-byte reserved alignment padding field (`[32..35]`).
  - Both headers total exactly 36 bytes.
- **Evaluation Order on Page Read**:
  1. Verify CRC32 checksum against computed value. If mismatched $\rightarrow$ return `StorageResult::CORRUPTED_PAGE` immediately.
  2. Inspect format version and magic numbers.
  3. Validate structural invariants (slot bounds, free-space pointer, non-overlapping payloads).

### 1.2 Dual Master Pages for Crash-Resilient Commits (Page 0 & Page 1)
To ensure atomic commits and crash safety across all backends:
- **Page 0 (`Master A`)** and **Page 1 (`Master B`)** form an alternating **Dual Master Page** pair.
- **`page_count` Semantics (Canonical Rule)**:
  `page_count` represents the **total number of allocated pages in the database**, which also equals the **next unallocated page ID** (e.g. on init, `page_count = 2`, meaning pages 0 and 1 are allocated, and the next allocated user page ID will be 2).
- **Initial Bootstrapping State (`init_new_database`)**:
  - `system_tables_root = INVALID_PAGE_ID` (`-1`)
  - `system_columns_root = INVALID_PAGE_ID` (`-1`)
  - `system_indexes_root = INVALID_PAGE_ID` (`-1`)
  - `page_count = 2` (pages 0 and 1 allocated; first user data page will be `page_id = 2`).
  - Master A: `generation_id = 1`
  - Master B: `generation_id = 0`
- **Master Selection & Tie-Breaking Rule**:
  1. Both valid, different generation: choose master with higher `generation_id`.
  2. Both valid, **identical generation** (e.g. tie): **Master A (Page 0) is preferred as the canonical tie-breaker**.
  3. One valid, one invalid: select the single valid master.
  4. Both invalid: return `StorageResult::CORRUPTED_PAGE` (unrecoverable database error).
- **Commit Sequence**:
  1. Write and flush all dirty data pages to storage (`accessor.flush_page(id)`).
  2. Issue a barrier sync (`accessor.sync()`).
  3. Identify the inactive master slot, populate with `generation_id = active_gen + 1`, and calculate CRC32.
  4. Write inactive master, flush (`accessor.flush_page(inactive_id)`), and issue `accessor.sync()`.
- If a crash occurs during step 3 or 4, the active master remains intact and valid. User data pages start at `page_id >= 2`.

### 1.3 RID Stability, Update Policy & Forwarding Resolution
- **Physical RID**: `RID = { page_id_t page_id, uint16_t slot_num }`.
- Compaction shifts tuple payloads inside the page but **never alters slot indices**. Thus, pure compaction does not change RIDs.
- **Update Policy & Decision Order**:
  1. **Case A (In-Place Immediate)**: If `new_tuple_size <= old_tuple_size`, overwrite payload in-place (reclaiming excess bytes as holes) without moving any other slots (`rid_changed = false`).
  2. **Case B (Same Page In-Place via Contiguous Gap)**: If `new_tuple_size > old_tuple_size` and `new_tuple_size - old_tuple_size <= contiguous_free_space()`, allocate new payload space at `free_space_pointer - new_tuple_size`, copy new tuple, update existing slot offset and length, mark old payload area as a dead hole, and set `HAS_HOLES` flag (`rid_changed = false`).
  3. **Case C (Same Page via Compaction)**: If `new_tuple_size - old_tuple_size > contiguous_free_space()`, but `new_tuple_size - old_tuple_size <= total_free_space_after_compaction()`, run `defragment()` on the page, then place the new payload (`rid_changed = false`).
  4. **Case D (Relocation to Another Page)**: If total free space on current page is insufficient, mark current slot `SlotState::DEAD`, insert new tuple on `last_page_id`, and return `UpdateResult { success: true, old_rid, new_rid, rid_changed: true }`.
- **`SlotState::FORWARDED` Scope**:
  - `SlotState::FORWARDED` is **reserved for Phase 3** secondary index pointer stability.
  - In Phase 1, `FORWARDED` is rejected by `TablePage::validate()` with `StorageResult::CORRUPTED_PAGE` if encountered on disk.

### 1.4 Unaligned Memory Access & WebAssembly Portability
- **Strict Rule**:
  - `tuple.cpp`, `slotted_page.cpp`, and `master_page.cpp` **never perform raw pointer casts to multi-byte scalar types** (`reinterpret_cast<int64_t*>`).
  - All multi-byte reads and writes must pass through canonical `std::memcpy`-based endianness helpers in `src/include/common/endian.hpp` (`read_int64`, `write_int64`, `read_double`, `write_double`). This prevents undefined behavior and hardware alignment faults on ARM64 and WebAssembly.

### 1.5 Strict Size Limits, Safety Bounds & Invariants
- `PAGE_SIZE = 4096` bytes.
- `PAGE_HEADER_SIZE = 36` bytes.
- `SLOT_ENTRY_SIZE = 4` bytes.
- `MAX_SLOT_COUNT = 1005` ($ (4096 - 36) / 4 $).
- **`MAX_TUPLE_SIZE = 4056` bytes** ($4096 - 36 - 4$).
- **`MAX_COLUMNS = 256`**.
- **`MAX_TEXT_SIZE = 4056` bytes**.
- **`MAX_PAGES = 1048576`** (1 million pages = 4GB max supported table chain length, preventing infinite loop traversal on corrupted cycles).
- `HAS_OVERFLOW` flag is **deferred** from Phase 1. Any tuple exceeding `MAX_TUPLE_SIZE` is strictly rejected with `StorageResult::TUPLE_TOO_LARGE`.
- Deserialization and size calculation rules:
  - All arithmetic `offset + length` is validated using `uint32_t` before bounds checking against `PAGE_SIZE` to prevent 16-bit wrap-around.

### 1.6 Storage Growth Terminology & Explicit Free-Space Formulas
- **Slot directory**: Starts at byte 36 and grows **upward** (toward higher byte addresses).
- **Tuple payloads**: Placed at bottom of page and grow **downward** from byte 4096 (toward lower byte addresses).
- **Free space**: The gap between end of slot directory and lowest tuple payload (`free_space_pointer`).

#### Exact Mathematical Formulas:
$$\text{slot\_dir\_end} = \text{PAGE\_HEADER\_SIZE} + (\text{slot\_count} \times \text{SLOT\_ENTRY\_SIZE})$$
$$\text{AllocatedPayloadBytes} = \text{PAGE\_SIZE} - \text{free\_space\_pointer}$$
$$\text{LivePayloadBytes} = \sum_{i \in \text{LIVE}} \text{slot}[i].\text{length}$$
$$\text{contiguous\_free\_space}() = \begin{cases} \text{free\_space\_pointer} - \text{slot\_dir\_end} & \text{if } \text{free\_space\_pointer} \ge \text{slot\_dir\_end} \\ 0 & \text{otherwise} \end{cases}$$
$$\text{reclaimable\_hole\_space}() = \text{AllocatedPayloadBytes} - \text{LivePayloadBytes}$$
$$\text{total\_free\_space\_after\_compaction}() = \text{contiguous\_free\_space}() + \text{reclaimable\_hole\_space}()$$

#### Compaction (Defragmentation) Ordering & Trailing Slot Pruning:
- Compaction maintains **exact slot indices** for all live tuples.
- **Payload physical order** is packed consecutively downward from byte 4096 in ascending slot index order ($i = 0, 1, 2 \dots$).
- **Internal dead slots** remain at their existing index with `offset = 0`, `length = 0`, `state = DEAD`.
- **Trailing dead slots** at the end of the slot array are pruned:
  $$\text{new\_slot\_count} = \begin{cases} \max \big\{ i \mid \text{slot}[i].\text{state} == \text{LIVE} \big\} + 1 & \text{if any live slots exist} \\ 0 & \text{if all slots dead} \end{cases}$$

### 1.7 Concurrency & Single-Threaded Core
Phase 1 (and the core engine) is strictly **single-threaded**. No mutexes, condition variables, or atomic primitives are used in the storage layer. All concurrency protection is enforced at the Web Worker event loop boundary.

### 1.8 `IPageAccessor` Lifecycle & Ownership Contract
```cpp
class IPageAccessor {
public:
    virtual ~IPageAccessor() = default;

    // Returns a raw pointer to the 4096-byte memory buffer of the page.
    // The pointer remains valid as long as the page is resident in memory.
    // Throws or returns nullptr on fatal I/O failure.
    virtual uint8_t* fetch_page(page_id_t page_id) = 0;

    // Allocates a new append-only page ID (page_id = page_count++).
    virtual page_id_t allocate_page() = 0;

    // Caller MUST invoke mark_dirty() after modifying any bytes in the returned page buffer.
    virtual void mark_dirty(page_id_t page_id) = 0;

    // Flushes dirty page to storage backend.
    virtual void flush_page(page_id_t page_id) = 0;

    // Issues a durable storage barrier (e.g. sync/flush).
    virtual void sync() = 0;
};
```
- In Phase 1, page allocation is strictly **append-only** (`page_count++`). Page reuse via free-lists is deferred.
- Memory ownership remains with the accessor implementation. Pointers returned by `fetch_page` remain valid until database shutdown or buffer eviction (which only occurs starting in Phase 2).

### 1.9 Text Encoding, Overlaps & NULL Field Policy
- **UTF-8 Validation**: Text fields are validated for well-formed UTF-8 **both** on input (when constructing `Value` or `Tuple`) and during `Tuple::deserialize()`. Malformed UTF-8 returns `StorageResult::INVALID_ARGUMENT`.
- **Text Comparisons**: Strictly bytewise (`std::string_view::compare`), no normalization, case-sensitive identifiers.
- **Empty Strings**: Fully supported (`var_length = 0`). For empty strings, `var_offset` points to the current payload position without consuming bytes.
- **Text Payload Overlaps**: Overlapping variable-length text ranges within a tuple are **strictly forbidden** and rejected by `Tuple::deserialize` with `StorageResult::SCHEMA_MISMATCH`.
- **NULL Field Determinism**: When a column is marked NULL in `NullBitmap`, its 8-byte fixed-width field and any corresponding text bytes must be **zeroed out** on serialization to guarantee deterministic binary page comparisons in tests.

### 1.10 Error Handling & Status Codes
All Phase 1 storage operations return structured error codes rather than throwing exceptions:
```cpp
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
    IO_ERROR
};
```
If a validator encounters corrupted checksums, overlapping slots, or out-of-bounds pointers, it returns `StorageResult::CORRUPTED_PAGE`.

---

## 2. Directory & Header Layout

```text
src/
├── include/
│   ├── common/
│   │   ├── types.hpp          # Primitives, RID, TypeId, StorageResult codes
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
inline constexpr size_t MAX_PAGES = 1048576; // 4GB max supported table chain length

enum class TypeId : uint8_t {
    INVALID = 0,
    INT = 1,      // 64-bit signed integer (int64_t)
    DOUBLE = 2,   // 64-bit IEEE-754 double (double)
    TEXT = 3      // UTF-8 string (byte-compared, no normalization)
};

enum class SlotState : uint8_t {
    EMPTY = 0,     // Slot unused (trailing directory space)
    LIVE = 1,      // Active valid tuple
    DEAD = 2,      // Deleted tuple; space reclaimable
    FORWARDED = 3  // Reserved for Phase 3 secondary index relocation
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
    INVALID_ARGUMENT,
    CYCLE_DETECTED,
    IO_ERROR
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

// Standard CRC-32 IEEE 802.3 implementation (polynomial 0xEDB88320)
uint32_t crc32(const uint8_t* data, size_t length) noexcept;

// Computes 4096-byte page checksum with the 4-byte checksum field masked to zero
uint32_t compute_page_checksum(const uint8_t* page_data, size_t checksum_field_offset) noexcept;

} // namespace webdb::checksum
```

---

### 3.4 Dual Master Pages Specification (`src/include/storage/master_page.hpp`)

#### In-Memory Data Model:
```cpp
struct MasterData {
    uint16_t version{1};
    uint16_t page_size{PAGE_SIZE};
    generation_id_t generation_id{0};
    page_id_t system_tables_root{INVALID_PAGE_ID};
    page_id_t system_columns_root{INVALID_PAGE_ID};
    page_id_t system_indexes_root{INVALID_PAGE_ID};
    uint32_t page_count{2};
};
```

#### Binary Layout (4096 bytes, Page 0 & Page 1):
| Byte Offset | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00 - 0x03` | `magic` | `uint32_t` | Constant `0x57454244` (`"WEBD"`) |
| `0x04 - 0x05` | `version` | `uint16_t` | Engine format version (`1`) |
| `0x06 - 0x07` | `page_size` | `uint16_t` | Canonical page size (`4096`) |
| `0x08 - 0x0F` | `generation_id` | `uint64_t` | Monotonically increasing commit generation |
| `0x10 - 0x13` | `system_tables_root` | `int32_t` | First page of `_system_tables` heap |
| `0x14 - 0x17` | `system_columns_root`| `int32_t` | First page of `_system_columns` heap |
| `0x18 - 0x1B` | `system_indexes_root`| `int32_t` | First page of `_system_indexes` heap |
| `0x1C - 0x1F` | `page_count` | `uint32_t` | Total allocated pages / next unallocated page ID |
| `0x20 - 0x23` | `checksum` | `uint32_t` | CRC32 of all 4096 bytes (bytes 0x20..0x23 zeroed during compute) |
| `0x24 - 0xFFF` | `reserved` | `uint8_t[4060]`| Zero-filled reserved space |

#### Master Page Manager Operations (`MasterPageManager`):
- `init_new_database(IPageAccessor& accessor)`: Formats Master A with `generation = 1` and Master B with `generation = 0`.
- `load_active_master(IPageAccessor& accessor, MasterData& out_data) -> StorageResult`:
  - Reads Page 0 and Page 1, checks CRC32 and magic.
  - If both valid with identical generation, selects Master A (tie-break).
  - If both invalid, returns `StorageResult::CORRUPTED_PAGE`.
- `commit_master(IPageAccessor& accessor, const MasterData& data) -> StorageResult`:
  - Writes inactive master with `generation_id = active_gen + 1`, flushes, and syncs.

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
| `0x1C - 0x1F` | `checksum` | `uint32_t` | CRC32 of all 4096 bytes (bytes 0x1C..0x1F zeroed during compute) |
| `0x20 - 0x23` | `reserved` | `uint32_t` | Reserved alignment padding (must be 0) |

#### 4-Byte Slot Entry Layout & Transitions:
```text
Bit 15-14: SlotState (EMPTY = 0, LIVE = 1, DEAD = 2, FORWARDED = 3)
Bit 13:    Reserved (0)
Bit 12-0:  Byte Offset within page (0..4095)
Byte 2-3:  Payload Length (uint16_t, 1..4056 for LIVE; 0 for DEAD/EMPTY)
```

- **Allowed Slot State Transitions in Phase 1**:
  - `EMPTY -> LIVE` (new tuple appended or slot initialized)
  - `LIVE -> DEAD` (tuple deleted or relocated)
  - `DEAD -> LIVE` (reusing internal dead slot for new tuple)
  - Any other transition (or appearance of `FORWARDED` on disk) returns `StorageResult::CORRUPTED_PAGE`.

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
6. Unknown flag bits or `FORWARDED` slot states are not set.

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

- **`FormatVersion`**: `1`. Deserializer strictly rejects any version $\ne 1$ (`StorageResult::VERSION_MISMATCH`).
- **`Flags`**: 8-bit reserved mask (must be `0` for Phase 1).
- **`NumColumns`**: $N \le 256$.
- **`NullBitmap`**: $\lceil N / 8 \rceil$ bytes. Bit $i = 1$ means column $i$ is NULL.
- **Fixed-Width Array ($N \times 8$ bytes)**:
  - `INT`: 8 bytes Little-Endian `int64_t`. (If NULL, zeroed).
  - `DOUBLE`: 8 bytes IEEE-754 Little-Endian `double`. (If NULL, zeroed).
  - `TEXT`: 8 bytes packed as `{ uint32_t var_offset, uint32_t var_length }`. (If NULL, both fields zeroed).
- **Var-Length Payloads**: Concatenated UTF-8 bytes. Empty strings consume 0 bytes with `var_length = 0`. Non-monotonic or overlapping text ranges are strictly rejected.

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
- Input strings are validated for UTF-8 conformity on insertion and deserialization.
- String comparisons use exact bytewise comparison (`std::string_view::compare`).
- No Unicode normalization or collation transforms applied in core engine.
- Identifiers are strictly case-sensitive.

#### Exact `INT` vs `DOUBLE` Comparison Algorithm:
```cpp
inline std::optional<bool> compare_int_double(int64_t i, double d) {
    if (std::isnan(d)) return std::nullopt; // UNKNOWN in 3VL
    
    if (d > static_cast<double>(std::numeric_limits<int64_t>::max())) return false;
    if (d < static_cast<double>(std::numeric_limits<int64_t>::min())) return false;
    
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

### 3.8 TableHeap & Iterator Contract (`src/include/storage/table_heap.hpp`)

`TableHeap` represents an un-ordered table storage abstraction across a doubly-linked chain of `TablePage`s.

#### Iterator State & Error Discrimination:
`TableIterator` explicitly differentiates normal scan termination from corruption or link cycles:
```cpp
enum class IteratorStatus : uint8_t {
    AT_RECORD = 0,
    END_OF_SCAN,
    CORRUPTED_PAGE,
    CYCLE_DETECTED,
    PAGE_NOT_FOUND
};
```
- Tracks a visited-page hash set bounded at `MAX_PAGES` (1,048,576). If a page ID appears twice, transitions to `CYCLE_DETECTED`.
- Verifies `current_page->prev_page_id == previous_page_id`.

#### Key Invariants & Operations:
1. **Append Optimization**: Maintains `last_page_id` in memory for $O(1)$ appends without chain traversal.
2. **`insert_tuple(const Tuple& tuple, RID* out_rid) -> StorageResult`**:
   - Attempts insert on `last_page_id`.
   - If full, attempts defragmentation. If still full, allocates a new page via `accessor.allocate_page()`, links pointers, and updates `last_page_id`.
3. **`update_tuple(const RID& rid, const Tuple& new_tuple) -> UpdateResult`**:
   - Follows Decision Order (Section 1.3). Relocated updates mark old slot `DEAD` and insert on `last_page_id` with `rid_changed = true`.
4. **`delete_tuple(const RID& rid) -> StorageResult`**:
   - Sets slot state to `DEAD`, marks page dirty.

---

## 4. Test Suite & Verification Matrix (`tests/test_storage.cpp`)

The test suite will cover 100% of Phase 1 edge cases:

1. **CRC-32 IEEE 802.3 & Checksum Tests**:
   - Full 4096-byte checksum verification with zero-masked fields at respective offsets (0x20 for Master, 0x1C for TablePage).
   - Mutation test: Flip bit at offset 0, offset 100, offset 4095; verify checksum fails.
   - Verify checksum field mutation itself causes verification failure.
2. **Dual Master Page Tests**:
   - Initial state: Master A valid (gen 1), Master B empty (gen 0). Active = A.
   - Interrupted write test: Corrupt Master B during write; verify engine still boots into Master A.
   - Clean commit test: Write Master B (gen 2); verify engine boots into Master B.
   - Tie-breaker test: Both pages valid with identical generation $\rightarrow$ selects Master A.
   - Total corruption test: Corrupt both Master A and B $\rightarrow$ returns `StorageResult::CORRUPTED_PAGE`.
3. **Slotted Page Structural Integrity**:
   - Insert until `contiguous_free_space < tuple_size`.
   - Delete alternating slots; verify `contiguous_free_space` is small but `reclaimable_hole_space` is large.
   - Trigger `defragment()`; verify all live slots retain exact byte content and valid offsets.
   - Verify trailing dead slots are pruned, expanding contiguous space.
   - Invariant validation: Craft malformed page buffers (slot overlaps, `free_space_pointer` < header end, out-of-bounds offsets) and assert `validate()` returns `CORRUPTED_PAGE`.
4. **Tuple Size Boundaries & Alignment Safety**:
   - Insert tuple of exact size `MAX_TUPLE_SIZE (4056 B)` $\rightarrow$ Success.
   - Insert tuple of size $4057$ B $\rightarrow$ Rejected with `TUPLE_TOO_LARGE`.
   - Verify non-aligned scalar offsets (e.g., $N=1, 3, 5$) read/write without crashes or UBSan errors.
   - Empty text strings (`var_length = 0`) correctly packed and read back.
   - Overlapping text ranges $\rightarrow$ Rejected with `SCHEMA_MISMATCH`.
   - NULL columns verify fixed and var-len fields are zeroed.
5. **3VL & UTF-8 Tests**:
   - `Value::compare_equals(NULL, NULL)` returns `std::nullopt`.
   - Exact `INT` vs `DOUBLE` precision comparison tests.
   - Malformed UTF-8 sequence in `TEXT` column $\rightarrow$ Rejected on tuple construction.
   - Type mismatch during decoding (e.g. string payload for INT column) $\rightarrow$ Rejected.
6. **TableHeap & Iterator Tests**:
   - Multi-page insert spanning 5+ pages.
   - Sequential scan reads all tuples back in order.
   - Update with enlargement: Verify `UpdateResult.rid_changed == true` and old/new RIDs are distinct.
   - Corrupted next pointer: Detect cycle and terminate iterator with `IteratorStatus::CYCLE_DETECTED`.

---

## 5. Review Sign-off Checklist

- [x] Unambiguous universal CRC32 rule and deliberate offset differences documented.
- [x] `page_count` canonical meaning defined (total allocated pages / next unallocated page ID).
- [x] Dual Master tie-breaking and corruption handling specified.
- [x] `IPageAccessor` ownership, lifecycle, and `sync()` contract finalized.
- [x] Text empty string, overlap rejection, and NULL zeroing rules defined.
- [x] Slot state machine transitions specified; `FORWARDED` deferred to Phase 3.
- [x] Defragmentation physical ordering and trailing slot pruning clarified.
- [x] In-memory data models (`MasterData`, `UpdateResult`) defined.
- [x] Error handling returns `StorageResult` codes (no exceptions).
- [x] Append-only allocation and single-threaded core explicitly stated.
- [x] `IteratorStatus` error discrimination and `MAX_PAGES = 1048576` defined.
- [x] Exact 4-step update decision order formalized.
