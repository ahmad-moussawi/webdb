#include "common/checksum.hpp"
#include "common/types.hpp"

#include <array>
#include <cstring>

namespace webdb::checksum {

namespace {

// Precomputed 256-entry lookup table for CRC-32 IEEE 802.3 (polynomial 0xEDB88320)
constexpr auto generate_crc32_table() {
    std::array<uint32_t, 256> table{};
    constexpr uint32_t polynomial = 0xEDB88320u;
    for (uint32_t i = 0; i < 256; ++i) {
        uint32_t crc = i;
        for (uint32_t j = 0; j < 8; ++j) {
            crc = (crc & 1) ? ((crc >> 1) ^ polynomial) : (crc >> 1);
        }
        table[i] = crc;
    }
    return table;
}

constexpr auto CRC32_TABLE = generate_crc32_table();

} // namespace

uint32_t crc32(const uint8_t* data, size_t length) noexcept {
    if (!data || length == 0) {
        return 0;
    }

    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < length; ++i) {
        const uint8_t byte = data[i];
        const uint8_t lookup_index = static_cast<uint8_t>((crc ^ byte) & 0xFFu);
        crc = (crc >> 8) ^ CRC32_TABLE[lookup_index];
    }

    return crc ^ 0xFFFFFFFFu;
}

uint32_t compute_page_checksum(const uint8_t* page_data, size_t checksum_field_offset) noexcept {
    if (!page_data) {
        return 0;
    }

    // Process first chunk up to checksum field
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < checksum_field_offset; ++i) {
        const uint8_t byte = page_data[i];
        crc = (crc >> 8) ^ CRC32_TABLE[static_cast<uint8_t>((crc ^ byte) & 0xFFu)];
    }

    // Process 4 zero bytes for the masked checksum field
    for (size_t i = 0; i < sizeof(uint32_t); ++i) {
        constexpr uint8_t byte = 0;
        crc = (crc >> 8) ^ CRC32_TABLE[static_cast<uint8_t>((crc ^ byte) & 0xFFu)];
    }

    // Process remaining bytes from (checksum_field_offset + 4) to PAGE_SIZE
    const size_t tail_start = checksum_field_offset + sizeof(uint32_t);
    for (size_t i = tail_start; i < PAGE_SIZE; ++i) {
        const uint8_t byte = page_data[i];
        crc = (crc >> 8) ^ CRC32_TABLE[static_cast<uint8_t>((crc ^ byte) & 0xFFu)];
    }

    return crc ^ 0xFFFFFFFFu;
}

} // namespace webdb::checksum
