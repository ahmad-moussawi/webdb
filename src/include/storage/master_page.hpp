#pragma once

#include "common/types.hpp"
#include "storage/page_accessor.hpp"

namespace webdb {

struct MasterData {
    uint16_t version{1};
    uint16_t page_size{static_cast<uint16_t>(PAGE_SIZE)};
    generation_id_t generation_id{0};

    page_id_t system_tables_root{INVALID_PAGE_ID};
    page_id_t system_columns_root{INVALID_PAGE_ID};
    page_id_t system_indexes_root{INVALID_PAGE_ID};

    uint32_t page_count{2};
};

class MasterPage {
public:
    static constexpr uint32_t MAGIC = 0x57454244u; // "WEBD"
    static constexpr uint16_t CURRENT_VERSION = 1;
    static constexpr size_t CHECKSUM_OFFSET = 0x20; // Bytes [32..35]

    /**
     * @brief Serializes MasterData into a raw 4096-byte page buffer with CRC-32.
     */
    static void serialize(const MasterData& data, uint8_t* out_buffer) noexcept;

    /**
     * @brief Validates and deserializes raw 4096-byte buffer into MasterData.
     */
    static StorageResult deserialize(const uint8_t* buffer, MasterData& out_data) noexcept;

    /**
     * @brief Validates that a master page buffer has a valid CRC-32, magic, version, and roots.
     */
    static StorageResult validate(const uint8_t* buffer) noexcept;
};

class MasterPageManager {
public:
    /**
     * @brief Initializes a fresh database with Master A (gen 1) and Master B (gen 0).
     */
    static StorageResult init_new_database(IPageAccessor& accessor) noexcept;

    /**
     * @brief Discovers and loads the authoritative active master page (Page 0 vs Page 1).
     * Tie-breaking rule: if both valid with equal generation, Master A (Page 0) is chosen.
     */
    static StorageResult load_active_master(IPageAccessor& accessor,
                                           page_id_t& out_active_id,
                                           MasterData& out_data) noexcept;

    /**
     * @brief Atomically commits new metadata to the inactive master page.
     * Sequence: flush data pages -> sync() -> write inactive master with gen+1 -> flush master -> sync().
     */
    static StorageResult commit_master(IPageAccessor& accessor,
                                       page_id_t active_id,
                                       MasterData& pending_data) noexcept;
};

} // namespace webdb
