#include "test_support.hpp"

namespace webdb::test {

void test_checksums() {
    std::cout << "[RUNNING] checksum and CRC validation tests..." << std::endl;

    const std::string text = "123456789";
    const uint32_t csum = checksum::crc32(reinterpret_cast<const uint8_t*>(text.data()), text.size());
    TEST_ASSERT(csum == 0xCBF43926u, "CRC-32 matches the IEEE 802.3 test vector");
    TEST_ASSERT(checksum::crc32(nullptr, 0) == 0, "CRC-32 of empty input is zero");

    std::vector<uint8_t> master_page(PAGE_SIZE, 0xAB);
    endian::write_uint32(master_page.data() + MasterPage::CHECKSUM_OFFSET, 0x12345678u);
    const uint32_t master_csum1 = checksum::compute_page_checksum(master_page.data(), MasterPage::CHECKSUM_OFFSET);
    endian::write_uint32(master_page.data() + MasterPage::CHECKSUM_OFFSET, 0xDEADBEEFu);
    const uint32_t master_csum2 = checksum::compute_page_checksum(master_page.data(), MasterPage::CHECKSUM_OFFSET);
    TEST_ASSERT(master_csum1 == master_csum2, "Master-page checksum field is excluded from its checksum");

    std::vector<uint8_t> table_page(PAGE_SIZE, 0xCD);
    endian::write_uint32(table_page.data() + TablePage::CHECKSUM_OFFSET, 0x55AA55AAu);
    const uint32_t table_csum1 = checksum::compute_page_checksum(table_page.data(), TablePage::CHECKSUM_OFFSET);
    endian::write_uint32(table_page.data() + TablePage::CHECKSUM_OFFSET, 0xCAFEBABEu);
    const uint32_t table_csum2 = checksum::compute_page_checksum(table_page.data(), TablePage::CHECKSUM_OFFSET);
    TEST_ASSERT(table_csum1 == table_csum2, "Table-page checksum field is excluded from its checksum");

    std::vector<uint8_t> boundary_page(PAGE_SIZE, 0x55);
    const uint32_t base_csum = checksum::compute_page_checksum(boundary_page.data(), TablePage::CHECKSUM_OFFSET);
    for (const size_t offset : {size_t{0}, size_t{100}, PAGE_SIZE - 1}) {
        boundary_page[offset] ^= 0x01;
        TEST_ASSERT(checksum::compute_page_checksum(boundary_page.data(), TablePage::CHECKSUM_OFFSET) != base_csum,
                    "Changing any page boundary sample changes the checksum");
        boundary_page[offset] ^= 0x01;
    }

    std::cout << "[PASSED] checksum and CRC validation tests" << std::endl;
}

} // namespace webdb::test
