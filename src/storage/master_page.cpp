#include "storage/master_page.hpp"
#include "common/checksum.hpp"
#include "common/endian.hpp"

#include <cstring>
#include <algorithm>
#include <limits>

namespace webdb {

namespace {

StorageResult write_initial_master(IPageAccessor& accessor, page_id_t page_id, uint8_t* buffer,
                                   generation_id_t generation_id) noexcept {
    MasterData data{};
    data.version = MasterPage::CURRENT_VERSION;
    data.page_size = static_cast<uint16_t>(PAGE_SIZE);
    data.generation_id = generation_id;
    data.page_count = 2;

    MasterPage::serialize(data, buffer);
    auto mark_res = accessor.mark_dirty(page_id);
    if (mark_res != StorageResult::SUCCESS) {
        return mark_res;
    }
    return accessor.flush_page(page_id);
}

}  // namespace

void MasterPage::serialize(const MasterData& data, uint8_t* out_buffer) noexcept {
    // 1. Zero out the entire 4096-byte page buffer (including reserved space)
    std::memset(out_buffer, 0, PAGE_SIZE);

    // 2. Write binary header fields using canonical little-endian helpers
    endian::write_uint32(out_buffer + 0x00, MAGIC);
    endian::write_uint16(out_buffer + 0x04, data.version);
    endian::write_uint16(out_buffer + 0x06, data.page_size);
    endian::write_uint64(out_buffer + 0x08, data.generation_id);
    endian::write_int32(out_buffer + 0x10, data.system_tables_root);
    endian::write_int32(out_buffer + 0x14, data.system_columns_root);
    endian::write_int32(out_buffer + 0x18, data.system_indexes_root);
    endian::write_uint32(out_buffer + 0x1C, data.page_count);

    // 3. Compute CRC-32 over all 4096 bytes with checksum field [32..35] treated as zero
    const uint32_t csum = checksum::compute_page_checksum(out_buffer, CHECKSUM_OFFSET);
    endian::write_uint32(out_buffer + CHECKSUM_OFFSET, csum);
}

StorageResult MasterPage::validate(const uint8_t* buffer) noexcept {
    if (!buffer) {
        return StorageResult::INVALID_ARGUMENT;
    }

    // 1. Checksum verification always precedes field inspection
    const uint32_t expected_crc = checksum::compute_page_checksum(buffer, CHECKSUM_OFFSET);
    const uint32_t actual_crc = endian::read_uint32(buffer + CHECKSUM_OFFSET);
    if (expected_crc != actual_crc) {
        return StorageResult::CORRUPTED_PAGE;
    }

    // 2. Magic and format version
    const uint32_t magic = endian::read_uint32(buffer + 0x00);
    if (magic != MAGIC) {
        return StorageResult::CORRUPTED_PAGE;
    }

    const uint16_t version = endian::read_uint16(buffer + 0x04);
    if (version != CURRENT_VERSION) {
        return StorageResult::VERSION_MISMATCH;
    }

    const uint16_t page_sz = endian::read_uint16(buffer + 0x06);
    if (page_sz != PAGE_SIZE) {
        return StorageResult::CORRUPTED_PAGE;
    }

    const uint32_t page_count = endian::read_uint32(buffer + 0x1C);
    if (page_count < 2 || page_count > static_cast<uint32_t>(std::numeric_limits<page_id_t>::max())) {
        return StorageResult::CORRUPTED_PAGE;
    }

    // 3. Check roots: must be INVALID_PAGE_ID or satisfy [FIRST_DATA_PAGE_ID, page_count)
    auto check_root = [page_count](int32_t root) {
        if (root == INVALID_PAGE_ID) return true;
        return root >= FIRST_DATA_PAGE_ID && static_cast<uint32_t>(root) < page_count;
    };

    if (!check_root(endian::read_int32(buffer + 0x10)) || !check_root(endian::read_int32(buffer + 0x14)) ||
        !check_root(endian::read_int32(buffer + 0x18))) {
        return StorageResult::CORRUPTED_PAGE;
    }

    // 4. Verify reserved bytes [0x24..0xFFF] are all zero
    for (size_t i = 0x24; i < PAGE_SIZE; ++i) {
        if (buffer[i] != 0) {
            return StorageResult::CORRUPTED_PAGE;
        }
    }

    return StorageResult::SUCCESS;
}

StorageResult MasterPage::deserialize(const uint8_t* buffer, MasterData& out_data) noexcept {
    const auto res = validate(buffer);
    if (res != StorageResult::SUCCESS) {
        return res;
    }

    out_data.version = endian::read_uint16(buffer + 0x04);
    out_data.page_size = endian::read_uint16(buffer + 0x06);
    out_data.generation_id = endian::read_uint64(buffer + 0x08);
    out_data.system_tables_root = endian::read_int32(buffer + 0x10);
    out_data.system_columns_root = endian::read_int32(buffer + 0x14);
    out_data.system_indexes_root = endian::read_int32(buffer + 0x18);
    out_data.page_count = endian::read_uint32(buffer + 0x1C);

    return StorageResult::SUCCESS;
}

StorageResult MasterPageManager::init_new_database(IPageAccessor& accessor) noexcept {
    uint8_t* master_a_buf = nullptr;
    auto res = accessor.allocate_page(MASTER_PAGE_A_ID, &master_a_buf);
    if (res != StorageResult::SUCCESS) {
        return res;
    }

    bool master_b_allocated = false;
    auto cleanup = [&]() noexcept {
        if (master_b_allocated) {
            (void)accessor.discard_page(MASTER_PAGE_B_ID);
        }
        (void)accessor.discard_page(MASTER_PAGE_A_ID);
    };

    uint8_t* master_b_buf = nullptr;
    res = accessor.allocate_page(MASTER_PAGE_B_ID, &master_b_buf);
    if (res != StorageResult::SUCCESS) {
        cleanup();
        return res;
    }
    master_b_allocated = true;

    // Master A starts authoritative; Master B is the rollback fallback.
    res = write_initial_master(accessor, MASTER_PAGE_A_ID, master_a_buf, 1);
    if (res != StorageResult::SUCCESS) {
        cleanup();
        return res;
    }

    res = write_initial_master(accessor, MASTER_PAGE_B_ID, master_b_buf, 0);
    if (res != StorageResult::SUCCESS) {
        cleanup();
        return res;
    }

    res = accessor.sync();
    if (res != StorageResult::SUCCESS) {
        cleanup();
        return res;
    }
    return StorageResult::SUCCESS;
}

StorageResult MasterPageManager::load_active_master(IPageAccessor& accessor, page_id_t& out_active_id,
                                                    MasterData& out_data) noexcept {
    uint8_t* buf_a = nullptr;
    const auto res_a = accessor.fetch_page(MASTER_PAGE_A_ID, &buf_a);
    MasterData data_a{};
    const bool valid_a =
        (res_a == StorageResult::SUCCESS) && (MasterPage::deserialize(buf_a, data_a) == StorageResult::SUCCESS);

    uint8_t* buf_b = nullptr;
    const auto res_b = accessor.fetch_page(MASTER_PAGE_B_ID, &buf_b);
    MasterData data_b{};
    const bool valid_b =
        (res_b == StorageResult::SUCCESS) && (MasterPage::deserialize(buf_b, data_b) == StorageResult::SUCCESS);

    if (valid_a && valid_b) {
        if (data_a.generation_id > data_b.generation_id) {
            out_active_id = MASTER_PAGE_A_ID;
            out_data = data_a;
        } else if (data_b.generation_id > data_a.generation_id) {
            out_active_id = MASTER_PAGE_B_ID;
            out_data = data_b;
        } else {
            // Tie-break: prefer Master A
            out_active_id = MASTER_PAGE_A_ID;
            out_data = data_a;
        }
        return StorageResult::SUCCESS;
    }

    if (valid_a) {
        out_active_id = MASTER_PAGE_A_ID;
        out_data = data_a;
        return StorageResult::SUCCESS;
    }

    if (valid_b) {
        out_active_id = MASTER_PAGE_B_ID;
        out_data = data_b;
        return StorageResult::SUCCESS;
    }

    return StorageResult::CORRUPTED_PAGE;
}

StorageResult MasterPageManager::commit_master(IPageAccessor& accessor, page_id_t& active_id, MasterData& pending_data,
                                               const std::vector<page_id_t>& dirty_page_ids) noexcept {
    if (active_id != MASTER_PAGE_A_ID && active_id != MASTER_PAGE_B_ID) {
        return StorageResult::INVALID_ARGUMENT;
    }

    uint8_t* active_buf = nullptr;
    auto fetch_active_res = accessor.fetch_page(active_id, &active_buf);
    if (fetch_active_res != StorageResult::SUCCESS) {
        return fetch_active_res;
    }

    MasterData active_data{};
    auto active_data_res = MasterPage::deserialize(active_buf, active_data);
    if (active_data_res != StorageResult::SUCCESS) {
        return active_data_res;
    }
    if (active_data.generation_id == std::numeric_limits<generation_id_t>::max()) {
        return StorageResult::IO_ERROR;
    }

    MasterData candidate = pending_data;
    candidate.generation_id = active_data.generation_id + 1;

    uint8_t candidate_buf[PAGE_SIZE];
    MasterPage::serialize(candidate, candidate_buf);
    auto candidate_res = MasterPage::validate(candidate_buf);
    if (candidate_res != StorageResult::SUCCESS) {
        return candidate_res;
    }

    // 1. Flush all dirty data pages before durability barrier
    for (page_id_t pid : dirty_page_ids) {
        auto flush_res = accessor.flush_page(pid);
        if (flush_res != StorageResult::SUCCESS) {
            return flush_res;
        }
    }
    auto flush_all_res = accessor.flush_dirty_pages();
    if (flush_all_res != StorageResult::SUCCESS) {
        return flush_all_res;
    }

    // 2. Durability barrier: guarantee all newly referenced data pages are durable on storage
    auto sync_res = accessor.sync();
    if (sync_res != StorageResult::SUCCESS) {
        return sync_res;
    }

    // 3. Identify inactive master
    const page_id_t inactive_id = (active_id == MASTER_PAGE_A_ID) ? MASTER_PAGE_B_ID : MASTER_PAGE_A_ID;
    uint8_t* inactive_buf = nullptr;
    auto fetch_res = accessor.fetch_page(inactive_id, &inactive_buf);
    if (fetch_res != StorageResult::SUCCESS) {
        return fetch_res;
    }

    uint8_t previous_inactive[PAGE_SIZE];
    std::memcpy(previous_inactive, inactive_buf, PAGE_SIZE);

    // 4. Serialize the validated candidate to the inactive master page.
    std::memcpy(inactive_buf, candidate_buf, PAGE_SIZE);
    auto mark_res = accessor.mark_dirty(inactive_id);
    if (mark_res != StorageResult::SUCCESS) {
        std::memcpy(inactive_buf, previous_inactive, PAGE_SIZE);
        return mark_res;
    }

    // 5. Flush inactive master and barrier sync.
    auto flush_res = accessor.flush_page(inactive_id);
    if (flush_res != StorageResult::SUCCESS) {
        std::memcpy(inactive_buf, previous_inactive, PAGE_SIZE);
        return flush_res;
    }

    auto final_sync_res = accessor.sync();
    if (final_sync_res != StorageResult::SUCCESS) {
        return final_sync_res;
    }

    // Publish caller-visible state only after the final durability barrier.
    pending_data = candidate;
    active_id = inactive_id;
    return StorageResult::SUCCESS;
}

}  // namespace webdb
