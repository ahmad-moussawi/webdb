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

inline constexpr size_t PAGE_SIZE = 4096;
inline constexpr size_t PAGE_HEADER_SIZE = 36;
inline constexpr size_t SLOT_ENTRY_SIZE = 4;

// floor((PAGE_SIZE - PAGE_HEADER_SIZE) / SLOT_ENTRY_SIZE) = 1015.
inline constexpr uint16_t MAX_SLOT_COUNT = 1015;

// One tuple plus one slot entry must fit in an otherwise empty TablePage.
inline constexpr size_t MAX_TUPLE_SIZE =
    PAGE_SIZE - PAGE_HEADER_SIZE - SLOT_ENTRY_SIZE; // 4056

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
    constexpr bool operator!=(const RID& other) const noexcept = default;
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
