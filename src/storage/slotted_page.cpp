#include "storage/slotted_page.hpp"
#include "common/checksum.hpp"
#include "common/endian.hpp"

#include <cstring>
#include <algorithm>
#include <new>
#include <vector>

namespace webdb {

void TablePage::init(uint8_t* buffer, page_id_t page_id, page_id_t prev_page_id, page_id_t next_page_id) noexcept {
    std::memset(buffer, 0, DATABASE_PAGE_SIZE);

    endian::write_int32(buffer + PAGE_ID_OFFSET, page_id);
    endian::write_int32(buffer + PREV_PAGE_ID_OFFSET, prev_page_id);
    endian::write_int32(buffer + NEXT_PAGE_ID_OFFSET, next_page_id);
    endian::write_uint16(buffer + SLOT_COUNT_OFFSET, 0);
    endian::write_uint16(buffer + FREE_SPACE_POINTER_OFFSET, static_cast<uint16_t>(DATABASE_PAGE_SIZE));
    endian::write_uint64(buffer + GENERATION_ID_OFFSET, 0);
    endian::write_uint32(buffer + FLAGS_OFFSET, 0);
    endian::write_uint32(buffer + RESERVED_OFFSET, 0);

    // Compute initial CRC
    const uint32_t csum = checksum::compute_page_checksum(buffer, CHECKSUM_OFFSET);
    endian::write_uint32(buffer + CHECKSUM_OFFSET, csum);
}

StorageResult TablePage::validate(const uint8_t* buffer, page_id_t expected_page_id, uint32_t page_count) noexcept {
    if (!buffer) {
        return StorageResult::INVALID_ARGUMENT;
    }

    try {
        // 1. Checksum validation always precedes interpretation
        const uint32_t expected_crc = checksum::compute_page_checksum(buffer, CHECKSUM_OFFSET);
        const uint32_t actual_crc = endian::read_uint32(buffer + CHECKSUM_OFFSET);
        if (expected_crc != actual_crc) {
            return StorageResult::CORRUPTED_PAGE;
        }

        // 2. Page ID checks
        const page_id_t pid = endian::read_int32(buffer + PAGE_ID_OFFSET);
        if (pid != expected_page_id || pid < FIRST_DATA_PAGE_ID || static_cast<uint32_t>(pid) >= page_count) {
            return StorageResult::CORRUPTED_PAGE;
        }

        // 3. Link checks
        const page_id_t prev_id = endian::read_int32(buffer + PREV_PAGE_ID_OFFSET);
        const page_id_t next_id = endian::read_int32(buffer + NEXT_PAGE_ID_OFFSET);
        if (prev_id == pid || next_id == pid) {
            return StorageResult::CORRUPTED_PAGE;
        }

        auto check_link = [page_count](page_id_t link) {
            if (link == INVALID_PAGE_ID) return true;
            return link >= FIRST_DATA_PAGE_ID && static_cast<uint32_t>(link) < page_count;
        };

        if (!check_link(prev_id) || !check_link(next_id)) {
            return StorageResult::CORRUPTED_PAGE;
        }

        // 4. Slot count & free space pointer bounds
        const uint16_t slot_count = endian::read_uint16(buffer + SLOT_COUNT_OFFSET);
        if (slot_count > MAX_SLOT_COUNT) {
            return StorageResult::CORRUPTED_PAGE;
        }

        const uint16_t free_ptr = endian::read_uint16(buffer + FREE_SPACE_POINTER_OFFSET);
        const uint16_t slot_dir_limit = static_cast<uint16_t>(PAGE_HEADER_SIZE + slot_count * SLOT_ENTRY_SIZE);
        if (free_ptr < slot_dir_limit || free_ptr > DATABASE_PAGE_SIZE) {
            return StorageResult::CORRUPTED_PAGE;
        }

        // 5. Reserved fields
        if (endian::read_uint64(buffer + GENERATION_ID_OFFSET) != 0) {
            return StorageResult::CORRUPTED_PAGE;
        }
        const uint32_t flags = endian::read_uint32(buffer + FLAGS_OFFSET);
        if ((flags & ~FLAG_HAS_HOLES) != 0) {  // Unknown flag bits
            return StorageResult::CORRUPTED_PAGE;
        }
        if (endian::read_uint32(buffer + RESERVED_OFFSET) != 0) {
            return StorageResult::CORRUPTED_PAGE;
        }

        // 6. Validate each slot entry and check for overlapping payloads
        struct PayloadRange {
            uint16_t start;
            uint16_t end;
        };
        std::vector<PayloadRange> live_ranges;
        live_ranges.reserve(slot_count);

        uint32_t live_payload_sum = 0;

        for (uint16_t i = 0; i < slot_count; ++i) {
            const uint8_t* slot_ptr = buffer + PAGE_HEADER_SIZE + (i * SLOT_ENTRY_SIZE);
            const uint16_t meta = endian::read_uint16(slot_ptr);
            const uint16_t len = endian::read_uint16(slot_ptr + 2);

            const uint8_t state_bits = static_cast<uint8_t>((meta >> 14) & 0x03u);
            const uint8_t reserved_bit = static_cast<uint8_t>((meta >> 13) & 0x01u);
            const uint16_t offset = static_cast<uint16_t>(meta & 0x1FFFu);

            if (reserved_bit != 0) {
                return StorageResult::CORRUPTED_PAGE;
            }

            const auto state = static_cast<SlotState>(state_bits);
            if (state == SlotState::EMPTY || state == SlotState::FORWARDED) {
                return StorageResult::CORRUPTED_PAGE;  // Invalid on disk in Phase 1
            }

            if (state == SlotState::DEAD) {
                if (offset != 0 || len != 0) {
                    return StorageResult::CORRUPTED_PAGE;
                }
            } else if (state == SlotState::LIVE) {
                if (len == 0 || len > MAX_TUPLE_SIZE) {
                    return StorageResult::CORRUPTED_PAGE;
                }
                if (offset < free_ptr || (static_cast<uint32_t>(offset) + len) > DATABASE_PAGE_SIZE) {
                    return StorageResult::CORRUPTED_PAGE;
                }
                live_ranges.push_back({offset, static_cast<uint16_t>(offset + len)});
                live_payload_sum += len;
            }
        }

        // Check overlaps among live payloads
        std::sort(live_ranges.begin(), live_ranges.end(),
                  [](const auto& a, const auto& b) { return a.start < b.start; });
        for (size_t i = 1; i < live_ranges.size(); ++i) {
            if (live_ranges[i].start < live_ranges[i - 1].end) {
                return StorageResult::CORRUPTED_PAGE;  // Overlapping live payload
            }
        }

        // Check HAS_HOLES invariant
        const uint32_t allocated_payloads = DATABASE_PAGE_SIZE - free_ptr;
        const uint32_t reclaimable_holes = allocated_payloads - live_payload_sum;
        const bool should_have_holes = (reclaimable_holes > 0);
        const bool actually_has_holes = (flags & FLAG_HAS_HOLES) != 0;
        if (should_have_holes != actually_has_holes) {
            return StorageResult::CORRUPTED_PAGE;
        }

        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        return StorageResult::IO_ERROR;
    }
}

page_id_t TablePage::get_page_id() const noexcept {
    return endian::read_int32(data_ + PAGE_ID_OFFSET);
}

page_id_t TablePage::get_prev_page_id() const noexcept {
    return endian::read_int32(data_ + PREV_PAGE_ID_OFFSET);
}

void TablePage::set_prev_page_id(page_id_t prev_id) noexcept {
    endian::write_int32(data_ + PREV_PAGE_ID_OFFSET, prev_id);
    update_checksum();
}

page_id_t TablePage::get_next_page_id() const noexcept {
    return endian::read_int32(data_ + NEXT_PAGE_ID_OFFSET);
}

void TablePage::set_next_page_id(page_id_t next_id) noexcept {
    endian::write_int32(data_ + NEXT_PAGE_ID_OFFSET, next_id);
    update_checksum();
}

uint16_t TablePage::get_slot_count() const noexcept {
    return endian::read_uint16(data_ + SLOT_COUNT_OFFSET);
}

void TablePage::set_slot_count(uint16_t count) noexcept {
    endian::write_uint16(data_ + SLOT_COUNT_OFFSET, count);
}

uint16_t TablePage::get_free_space_pointer() const noexcept {
    return endian::read_uint16(data_ + FREE_SPACE_POINTER_OFFSET);
}

void TablePage::set_free_space_pointer(uint16_t ptr) noexcept {
    endian::write_uint16(data_ + FREE_SPACE_POINTER_OFFSET, ptr);
}

uint32_t TablePage::get_flags() const noexcept {
    return endian::read_uint32(data_ + FLAGS_OFFSET);
}

void TablePage::set_flags(uint32_t flags) noexcept {
    endian::write_uint32(data_ + FLAGS_OFFSET, flags);
}

uint16_t TablePage::contiguous_free_space() const noexcept {
    const uint16_t free_ptr = get_free_space_pointer();
    const uint16_t dir_end = slot_dir_end();
    if (free_ptr < dir_end) return 0;
    return static_cast<uint16_t>(free_ptr - dir_end);
}

uint16_t TablePage::reclaimable_hole_space() const noexcept {
    const uint16_t free_ptr = get_free_space_pointer();
    const uint16_t allocated = static_cast<uint16_t>(DATABASE_PAGE_SIZE - free_ptr);
    uint32_t live_sum = 0;
    const uint16_t count = get_slot_count();
    for (uint16_t i = 0; i < count; ++i) {
        if (get_slot_state(i) == SlotState::LIVE) {
            live_sum += get_slot_length(i);
        }
    }
    return static_cast<uint16_t>(allocated - live_sum);
}

uint16_t TablePage::total_free_space_after_compaction() const noexcept {
    return static_cast<uint16_t>(contiguous_free_space() + reclaimable_hole_space());
}

SlotState TablePage::get_slot_state(uint16_t slot_num) const noexcept {
    if (slot_num >= get_slot_count()) return SlotState::EMPTY;
    const uint8_t* p = data_ + PAGE_HEADER_SIZE + (slot_num * SLOT_ENTRY_SIZE);
    const uint16_t meta = endian::read_uint16(p);
    return static_cast<SlotState>((meta >> 14) & 0x03u);
}

uint16_t TablePage::get_slot_offset(uint16_t slot_num) const noexcept {
    if (slot_num >= get_slot_count()) return 0;
    const uint8_t* p = data_ + PAGE_HEADER_SIZE + (slot_num * SLOT_ENTRY_SIZE);
    const uint16_t meta = endian::read_uint16(p);
    return static_cast<uint16_t>(meta & 0x1FFFu);
}

uint16_t TablePage::get_slot_length(uint16_t slot_num) const noexcept {
    if (slot_num >= get_slot_count()) return 0;
    const uint8_t* p = data_ + PAGE_HEADER_SIZE + (slot_num * SLOT_ENTRY_SIZE);
    return endian::read_uint16(p + 2);
}

void TablePage::set_slot(uint16_t slot_num, SlotState state, uint16_t offset, uint16_t length) noexcept {
    uint8_t* p = data_ + PAGE_HEADER_SIZE + (slot_num * SLOT_ENTRY_SIZE);
    const uint16_t meta = static_cast<uint16_t>((static_cast<uint16_t>(state) << 14) | (offset & 0x1FFFu));
    endian::write_uint16(p, meta);
    endian::write_uint16(p + 2, length);
}

void TablePage::recalculate_has_holes() noexcept {
    const bool holes = (reclaimable_hole_space() > 0);
    uint32_t flags = get_flags();
    if (holes) {
        flags |= FLAG_HAS_HOLES;
    } else {
        flags &= ~FLAG_HAS_HOLES;
    }
    set_flags(flags);
}

void TablePage::update_checksum() noexcept {
    const uint32_t csum = checksum::compute_page_checksum(data_, CHECKSUM_OFFSET);
    endian::write_uint32(data_ + CHECKSUM_OFFSET, csum);
}

StorageResult TablePage::insert_tuple(const uint8_t* tuple_data, size_t tuple_size, uint16_t& out_slot_num) noexcept {
    if (!tuple_data || tuple_size == 0) {
        return StorageResult::INVALID_ARGUMENT;
    }
    if (tuple_size > MAX_TUPLE_SIZE) {
        return StorageResult::TUPLE_TOO_LARGE;
    }

    const uint16_t t_size = static_cast<uint16_t>(tuple_size);
    const uint16_t cur_slots = get_slot_count();
    const uint16_t free_ptr = get_free_space_pointer();
    const uint16_t dir_end = slot_dir_end();
    if (free_ptr < dir_end || free_ptr > DATABASE_PAGE_SIZE || cur_slots > MAX_SLOT_COUNT) {
        return StorageResult::CORRUPTED_PAGE;
    }

    // 1. Check if we can reuse an internal DEAD slot
    uint16_t target_slot = cur_slots;
    bool reusing_slot = false;
    for (uint16_t i = 0; i < cur_slots; ++i) {
        if (get_slot_state(i) == SlotState::DEAD) {
            target_slot = i;
            reusing_slot = true;
            break;
        }
    }

    const uint16_t slot_growth = reusing_slot ? 0 : static_cast<uint16_t>(SLOT_ENTRY_SIZE);
    const uint16_t needed_bytes = static_cast<uint16_t>(t_size + slot_growth);

    // 2. Check if contiguous free space is sufficient
    if (contiguous_free_space() < needed_bytes) {
        // Check if compaction would yield enough space
        if (total_free_space_after_compaction() < needed_bytes) {
            return StorageResult::PAGE_FULL;
        }
        defragment();
        // After defragment, slots may have been pruned; re-evaluate target_slot
        if (reusing_slot && target_slot >= get_slot_count()) {
            reusing_slot = false;
            target_slot = get_slot_count();
            // We now grow the slot directory, re-check space with slot growth
            if (contiguous_free_space() < static_cast<uint16_t>(t_size + SLOT_ENTRY_SIZE)) {
                return StorageResult::PAGE_FULL;
            }
        }
    }

    // Ensure slot count doesn't exceed maximum
    if (!reusing_slot && (get_slot_count() >= MAX_SLOT_COUNT)) {
        return StorageResult::PAGE_FULL;
    }

    // 3. Allocate payload at bottom
    const uint16_t new_free_ptr = static_cast<uint16_t>(get_free_space_pointer() - t_size);
    set_free_space_pointer(new_free_ptr);
    std::memcpy(data_ + new_free_ptr, tuple_data, t_size);

    // 4. Update slot entry
    set_slot(target_slot, SlotState::LIVE, new_free_ptr, t_size);
    if (!reusing_slot) {
        set_slot_count(static_cast<uint16_t>(target_slot + 1));
    }

    out_slot_num = target_slot;
    recalculate_has_holes();
    update_checksum();
    return StorageResult::SUCCESS;
}

StorageResult TablePage::get_tuple(uint16_t slot_num, const uint8_t** out_tuple_data, size_t& out_size) const noexcept {
    if (!out_tuple_data) {
        return StorageResult::INVALID_ARGUMENT;
    }
    if (slot_num >= get_slot_count()) {
        return StorageResult::SLOT_NOT_FOUND;
    }
    if (get_slot_state(slot_num) != SlotState::LIVE) {
        return StorageResult::SLOT_NOT_FOUND;
    }

    const uint16_t offset = get_slot_offset(slot_num);
    const uint16_t len = get_slot_length(slot_num);
    const uint16_t free_ptr = get_free_space_pointer();
    if (offset < free_ptr || (static_cast<uint32_t>(offset) + len) > DATABASE_PAGE_SIZE) {
        return StorageResult::CORRUPTED_PAGE;
    }

    *out_tuple_data = data_ + offset;
    out_size = len;
    return StorageResult::SUCCESS;
}

UpdateResult TablePage::update_tuple(uint16_t slot_num, const uint8_t* new_tuple_data, size_t new_size) noexcept {
    UpdateResult result{};
    result.old_rid = RID{get_page_id(), slot_num};
    result.new_rid = result.old_rid;
    result.rid_changed = false;

    if (!new_tuple_data || new_size == 0) {
        result.status = StorageResult::INVALID_ARGUMENT;
        return result;
    }
    if (slot_num >= get_slot_count() || get_slot_state(slot_num) != SlotState::LIVE) {
        result.status = StorageResult::SLOT_NOT_FOUND;
        return result;
    }
    if (new_size > MAX_TUPLE_SIZE) {
        result.status = StorageResult::TUPLE_TOO_LARGE;
        return result;
    }

    const uint16_t old_offset = get_slot_offset(slot_num);
    const uint16_t old_size = get_slot_length(slot_num);
    const uint16_t free_ptr = get_free_space_pointer();
    if (old_offset < free_ptr || (static_cast<uint32_t>(old_offset) + old_size) > DATABASE_PAGE_SIZE) {
        result.status = StorageResult::CORRUPTED_PAGE;
        return result;
    }

    const uint16_t n_size = static_cast<uint16_t>(new_size);

    // Case A: new_size <= old_size -> overwrite in-place
    if (n_size <= old_size) {
        std::memcpy(data_ + old_offset, new_tuple_data, n_size);
        set_slot(slot_num, SlotState::LIVE, old_offset, n_size);
        recalculate_has_holes();
        update_checksum();
        result.status = StorageResult::SUCCESS;
        return result;
    }

    // Expansion needed
    const uint16_t delta = static_cast<uint16_t>(n_size - old_size);

    // Case B: full new payload fits in contiguous free space (without compaction)
    if (n_size <= contiguous_free_space()) {
        const uint16_t new_ptr = static_cast<uint16_t>(get_free_space_pointer() - n_size);
        set_free_space_pointer(new_ptr);
        std::memcpy(data_ + new_ptr, new_tuple_data, n_size);
        set_slot(slot_num, SlotState::LIVE, new_ptr, n_size);
        recalculate_has_holes();
        update_checksum();
        result.status = StorageResult::SUCCESS;
        return result;
    }

    // Case C: net growth fits after compaction
    if (delta <= total_free_space_after_compaction()) {
        rebuild_compacted_page(Replacement{slot_num, new_tuple_data, n_size});
        result.status = StorageResult::SUCCESS;
        return result;
    }

    // Case D: cannot fit on this page -> requires relocation to another page
    result.status = StorageResult::PAGE_FULL;
    return result;
}

StorageResult TablePage::delete_tuple(uint16_t slot_num) noexcept {
    if (slot_num >= get_slot_count() || get_slot_state(slot_num) != SlotState::LIVE) {
        return StorageResult::SLOT_NOT_FOUND;
    }

    const uint16_t offset = get_slot_offset(slot_num);
    const uint16_t len = get_slot_length(slot_num);
    const uint16_t free_ptr = get_free_space_pointer();
    if (offset < free_ptr || (static_cast<uint32_t>(offset) + len) > DATABASE_PAGE_SIZE) {
        return StorageResult::CORRUPTED_PAGE;
    }

    set_slot(slot_num, SlotState::DEAD, 0, 0);
    recalculate_has_holes();
    update_checksum();
    return StorageResult::SUCCESS;
}

StorageResult TablePage::restore_tuple(uint16_t slot_num, const uint8_t* tuple_data, uint16_t tuple_size,
                                       uint16_t tuple_offset) noexcept {
    if (!tuple_data || tuple_size == 0 || slot_num >= get_slot_count() || get_slot_state(slot_num) != SlotState::DEAD) {
        return StorageResult::INVALID_ARGUMENT;
    }

    const uint16_t free_ptr = get_free_space_pointer();
    if (tuple_offset < free_ptr || static_cast<uint32_t>(tuple_offset) + tuple_size > DATABASE_PAGE_SIZE) {
        return StorageResult::CORRUPTED_PAGE;
    }

    std::memcpy(data_ + tuple_offset, tuple_data, tuple_size);
    set_slot(slot_num, SlotState::LIVE, tuple_offset, tuple_size);
    recalculate_has_holes();
    update_checksum();
    return StorageResult::SUCCESS;
}

void TablePage::rebuild_compacted_page() noexcept {
    rebuild_compacted_page(static_cast<const Replacement*>(nullptr));
}

void TablePage::rebuild_compacted_page(Replacement replacement) noexcept {
    rebuild_compacted_page(&replacement);
}

void TablePage::rebuild_compacted_page(const Replacement* replacement) noexcept {
    const uint16_t count = get_slot_count();
    if (count == 0) return;

    // Allocate temporary page buffer
    uint8_t temp[DATABASE_PAGE_SIZE];
    std::memcpy(temp, data_, PAGE_HEADER_SIZE);

    uint16_t temp_free_ptr = static_cast<uint16_t>(DATABASE_PAGE_SIZE);

    // 1. Pack live payloads downward from byte 4096 in ascending slot index order
    for (uint16_t i = 0; i < count; ++i) {
        if (replacement && i == replacement->slot_num) {
            temp_free_ptr = static_cast<uint16_t>(temp_free_ptr - replacement->length);
            std::memcpy(temp + temp_free_ptr, replacement->data, replacement->length);

            // Write updated slot in temp
            uint8_t* p = temp + PAGE_HEADER_SIZE + (i * SLOT_ENTRY_SIZE);
            const uint16_t meta =
                static_cast<uint16_t>((static_cast<uint16_t>(SlotState::LIVE) << 14) | (temp_free_ptr & 0x1FFFu));
            endian::write_uint16(p, meta);
            endian::write_uint16(p + 2, replacement->length);
        } else if (get_slot_state(i) == SlotState::LIVE) {
            const uint16_t old_offset = get_slot_offset(i);
            const uint16_t len = get_slot_length(i);
            temp_free_ptr = static_cast<uint16_t>(temp_free_ptr - len);
            std::memcpy(temp + temp_free_ptr, data_ + old_offset, len);

            // Write updated slot in temp
            uint8_t* p = temp + PAGE_HEADER_SIZE + (i * SLOT_ENTRY_SIZE);
            const uint16_t meta =
                static_cast<uint16_t>((static_cast<uint16_t>(SlotState::LIVE) << 14) | (temp_free_ptr & 0x1FFFu));
            endian::write_uint16(p, meta);
            endian::write_uint16(p + 2, len);
        } else {
            // Internal dead slot: preserve slot entry with offset=0, len=0
            uint8_t* p = temp + PAGE_HEADER_SIZE + (i * SLOT_ENTRY_SIZE);
            const uint16_t meta = static_cast<uint16_t>((static_cast<uint16_t>(SlotState::DEAD) << 14));
            endian::write_uint16(p, meta);
            endian::write_uint16(p + 2, 0);
        }
    }

    // 2. Prune trailing dead slots
    uint16_t new_slot_count = 0;
    for (int i = count - 1; i >= 0; --i) {
        const uint8_t* p = temp + PAGE_HEADER_SIZE + (i * SLOT_ENTRY_SIZE);
        const uint16_t meta = endian::read_uint16(p);
        const auto state = static_cast<SlotState>((meta >> 14) & 0x03u);
        if (state == SlotState::LIVE) {
            new_slot_count = static_cast<uint16_t>(i + 1);
            break;
        }
    }

    // Zero out any pruned trailing slot directory entries
    if (new_slot_count < count) {
        std::memset(temp + PAGE_HEADER_SIZE + (new_slot_count * SLOT_ENTRY_SIZE), 0,
                    (count - new_slot_count) * SLOT_ENTRY_SIZE);
    }

    // 3. Zero out the middle free space gap
    const uint16_t new_slot_dir_end = static_cast<uint16_t>(PAGE_HEADER_SIZE + (new_slot_count * SLOT_ENTRY_SIZE));
    if (temp_free_ptr > new_slot_dir_end) {
        std::memset(temp + new_slot_dir_end, 0, temp_free_ptr - new_slot_dir_end);
    }

    // 4. Update header fields
    endian::write_uint16(temp + SLOT_COUNT_OFFSET, new_slot_count);
    endian::write_uint16(temp + FREE_SPACE_POINTER_OFFSET, temp_free_ptr);
    uint32_t flags = endian::read_uint32(temp + FLAGS_OFFSET);
    flags &= ~FLAG_HAS_HOLES;  // Compaction clears holes
    endian::write_uint32(temp + FLAGS_OFFSET, flags);

    // 5. Copy back to page data and update CRC
    std::memcpy(data_, temp, DATABASE_PAGE_SIZE);
    update_checksum();
}

void TablePage::defragment() noexcept {
    rebuild_compacted_page();
}

}  // namespace webdb
