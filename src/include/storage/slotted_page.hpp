#pragma once

#include "common/types.hpp"

#include <cstdint>
#include <cstddef>
#include <string_view>

namespace webdb {

class TablePage {
public:
    static constexpr size_t CHECKSUM_OFFSET = 0x1C; // Bytes [28..31]
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

    // In-place defragmentation: preserves slot IDs, packs payloads downward, prunes trailing dead slots
    void defragment() noexcept;

    // Recomputes and writes CRC-32
    void update_checksum() noexcept;

    uint8_t* data() noexcept { return data_; }
    const uint8_t* data() const noexcept { return data_; }

private:
    uint8_t* data_{nullptr};

    void set_slot(uint16_t slot_num, SlotState state, uint16_t offset, uint16_t length) noexcept;
    void set_free_space_pointer(uint16_t ptr) noexcept;
    void set_slot_count(uint16_t count) noexcept;
    void set_flags(uint32_t flags) noexcept;
    void recalculate_has_holes() noexcept;
    void compact(int32_t update_slot, const uint8_t* update_data, uint16_t update_len) noexcept;
};

} // namespace webdb
