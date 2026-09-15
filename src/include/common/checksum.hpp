#pragma once

#include <cstddef>
#include <cstdint>

namespace webdb::checksum {

/**
 * @brief Computes standard CRC-32 IEEE 802.3 over a byte buffer.
 * Polynomial: 0xEDB88320 (reflected), Initial: 0xFFFFFFFF, Final XOR: 0xFFFFFFFF.
 */
uint32_t crc32(const uint8_t* data, size_t length) noexcept;

/**
 * @brief Computes 4096-byte page checksum with the 4-byte checksum field masked to zero.
 * @param page_data Pointer to exactly 4096 bytes.
 * @param checksum_field_offset Byte offset of the 4-byte checksum field inside the page (e.g. 0x20 for MasterPage, 0x1C for TablePage).
 */
uint32_t compute_page_checksum(const uint8_t* page_data, size_t checksum_field_offset) noexcept;

} // namespace webdb::checksum
