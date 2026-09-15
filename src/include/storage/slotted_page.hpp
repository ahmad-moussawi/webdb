#pragma once

#include "common/types.hpp"

#include <cstdint>
#include <cstddef>
#include <string_view>

namespace webdb {

class TablePage {
public:
    static constexpr size_t PAGE_ID_OFFSET = 0x00;
    static constexpr size_t PREV_PAGE_ID_OFFSET = 0x04;
    static constexpr size_t NEXT_PAGE_ID_OFFSET = 0x08;
    static constexpr size_t SLOT_COUNT_OFFSET = 0x0C;
    static constexpr size_t FREE_SPACE_POINTER_OFFSET = 0x0E;
    static constexpr size_t GENERATION_ID_OFFSET = 0x10;
    static constexpr size_t FLAGS_OFFSET = 0x18;
    static constexpr size_t CHECKSUM_OFFSET = 0x1C;
    static constexpr size_t RESERVED_OFFSET = 0x20;
    static constexpr uint32_t FLAG_HAS_HOLES = 1u << 0;

    /**
     * @brief Formats an empty 4096-byte memory buffer as a valid TablePage.
     */
    static void init(uint8_t* buffer, page_id_t page_id, page_id_t prev_page_id = INVALID_PAGE_ID, page_id_t next_page_id = INVALID_PAGE_ID) noexcept;

    /**
     * @brief Validates all structural page invariants and CRC-32 checksum.
     */
    static StorageResult validate(const uint8_t* buffer, page_id_t expected_page_id, uint32_t page_count) noexcept;

    explicit TablePage(uint8_t* data) noexcept : data_(data) {}

    // Page header accessors
    page_id_t get_page_id() const noexcept;
    page_id_t get_prev_page_id() const noexcept;
    void set_prev_page_id(page_id_t prev_id) noexcept;

    page_id_t get_next_page_id() const noexcept;
    void set_next_page_id(page_id_t next_id) noexcept;

    uint16_t get_slot_count() const noexcept;
    uint16_t get_free_space_pointer() const noexcept;
    uint32_t get_flags() const noexcept;

    // Slot directory address boundary: 36 + slot_count * 4
    uint16_t slot_dir_end() const noexcept {
        return static_cast<uint16_t>(PAGE_HEADER_SIZE + get_slot_count() * SLOT_ENTRY_SIZE);
    }

    // Exact space formulas
    uint16_t contiguous_free_space() const noexcept;
    uint16_t reclaimable_hole_space() const noexcept;
    uint16_t total_free_space_after_compaction() const noexcept;

    // Slot inspectors
    SlotState get_slot_state(uint16_t slot_num) const noexcept;
    uint16_t get_slot_offset(uint16_t slot_num) const noexcept;
    uint16_t get_slot_length(uint16_t slot_num) const noexcept;

    // Tuple CRUD operations on the page
    StorageResult insert_tuple(const uint8_t* tuple_data, size_t tuple_size, uint16_t& out_slot_num) noexcept;
    StorageResult get_tuple(uint16_t slot_num, const uint8_t** out_tuple_data, size_t& out_size) const noexcept;
    UpdateResult update_tuple(uint16_t slot_num, const uint8_t* new_tuple_data, size_t new_size) noexcept;
    StorageResult delete_tuple(uint16_t slot_num) noexcept;
    StorageResult restore_tuple(uint16_t slot_num, const uint8_t* tuple_data,
                                uint16_t tuple_size, uint16_t tuple_offset) noexcept;

    // In-place defragmentation: preserves slot IDs, packs payloads downward, prunes trailing dead slots
    void defragment() noexcept;

    // Recomputes and writes CRC-32
    void update_checksum() noexcept;

    uint8_t* data() noexcept { return data_; }
    const uint8_t* data() const noexcept { return data_; }

private:
    struct Replacement {
        uint16_t slot_num;
        const uint8_t* data;
        uint16_t length;
    };

    uint8_t* data_{nullptr};

    void set_slot(uint16_t slot_num, SlotState state, uint16_t offset, uint16_t length) noexcept;
    void set_free_space_pointer(uint16_t ptr) noexcept;
    void set_slot_count(uint16_t count) noexcept;
    void set_flags(uint32_t flags) noexcept;
    void recalculate_has_holes() noexcept;
    void rebuild_compacted_page() noexcept;
    void rebuild_compacted_page(Replacement replacement) noexcept;
    void rebuild_compacted_page(const Replacement* replacement) noexcept;
};

} // namespace webdb
