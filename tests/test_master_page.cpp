#include "test_support.hpp"

namespace webdb::test {

void test_master_page_dual() {
    std::cout << "[RUNNING] dual-master metadata tests..." << std::endl;
    InMemoryPageAccessor accessor;

    auto result = MasterPageManager::init_new_database(accessor);
    TEST_ASSERT(result == StorageResult::SUCCESS, "A new database initializes both master pages");

    page_id_t active_id = INVALID_PAGE_ID;
    MasterData active_data{};
    result = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(result == StorageResult::SUCCESS, "The active master page loads successfully");
    TEST_ASSERT(active_id == MASTER_PAGE_A_ID, "Master A is initially authoritative");
    TEST_ASSERT(active_data.generation_id == 1, "Initial generation is one");
    TEST_ASSERT(active_data.page_count == 2, "Initial page count includes both master pages");

    active_data.system_tables_root = 2;
    active_data.page_count = 3;
    result = MasterPageManager::commit_master(accessor, active_id, active_data);
    TEST_ASSERT(result == StorageResult::SUCCESS, "Metadata commits to the inactive master");
    TEST_ASSERT(active_id == MASTER_PAGE_B_ID, "The active master alternates to Master B");

    active_data.page_count = 4;
    result = MasterPageManager::commit_master(accessor, active_id, active_data);
    TEST_ASSERT(result == StorageResult::SUCCESS, "A second metadata commit succeeds");
    TEST_ASSERT(active_id == MASTER_PAGE_A_ID, "The active master alternates back to Master A");
    TEST_ASSERT(active_data.generation_id == 3, "Each commit increments the generation");

    result = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(result == StorageResult::SUCCESS, "The newest master reloads successfully");
    TEST_ASSERT(active_id == MASTER_PAGE_A_ID && active_data.generation_id == 3,
                "Reload selects the newest valid master");
    TEST_ASSERT(active_data.system_tables_root == 2 && active_data.page_count == 4,
                "Reload preserves committed metadata");

    InMemoryPageAccessor stale_generation_accessor;
    TEST_ASSERT(MasterPageManager::init_new_database(stale_generation_accessor) == StorageResult::SUCCESS,
                "Initialize stale-generation test database");
    page_id_t stale_active_id = INVALID_PAGE_ID;
    MasterData stale_data{};
    TEST_ASSERT(MasterPageManager::load_active_master(stale_generation_accessor, stale_active_id, stale_data) == StorageResult::SUCCESS,
                "Load stale-generation test master");
    stale_data.generation_id = 0;
    TEST_ASSERT(MasterPageManager::commit_master(stale_generation_accessor, stale_active_id, stale_data) == StorageResult::SUCCESS,
                "Commit succeeds with stale caller generation");
    TEST_ASSERT(stale_data.generation_id == 2 && stale_active_id == MASTER_PAGE_B_ID,
                "Commit derives the next generation from the active master");
    TEST_ASSERT(MasterPageManager::load_active_master(stale_generation_accessor, stale_active_id, stale_data) == StorageResult::SUCCESS &&
                    stale_data.generation_id == 2,
                "Recovery selects the newly committed generation");

    InMemoryPageAccessor failed_publication_accessor;
    TEST_ASSERT(MasterPageManager::init_new_database(failed_publication_accessor) == StorageResult::SUCCESS,
                "Initialize failed-publication test database");
    page_id_t failed_active_id = INVALID_PAGE_ID;
    MasterData failed_data{};
    TEST_ASSERT(MasterPageManager::load_active_master(failed_publication_accessor, failed_active_id, failed_data) == StorageResult::SUCCESS,
                "Load failed-publication test master");
    const MasterData failed_data_before = failed_data;
    uint8_t inactive_before[DATABASE_PAGE_SIZE];
    std::memcpy(inactive_before, failed_publication_accessor.raw_buffer(MASTER_PAGE_B_ID), DATABASE_PAGE_SIZE);
    failed_publication_accessor.fail_mark_dirty = true;
    TEST_ASSERT(MasterPageManager::commit_master(failed_publication_accessor, failed_active_id, failed_data) == StorageResult::IO_ERROR,
                "Failed master publication reports dirty-mark failure");
    TEST_ASSERT(failed_active_id == MASTER_PAGE_A_ID && failed_data.generation_id == failed_data_before.generation_id,
                "Failed publication leaves active ID and caller metadata unchanged");
    TEST_ASSERT(std::memcmp(inactive_before, failed_publication_accessor.raw_buffer(MASTER_PAGE_B_ID), DATABASE_PAGE_SIZE) == 0,
                "Failed publication restores the inactive master buffer");

    uint8_t* master_a_buf = accessor.raw_buffer(MASTER_PAGE_A_ID);
    master_a_buf[10] ^= 0xFF;
    result = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(result == StorageResult::SUCCESS && active_id == MASTER_PAGE_B_ID && active_data.generation_id == 2,
                "Corrupt Master A falls back to valid Master B");

    uint8_t* master_b_buf = accessor.raw_buffer(MASTER_PAGE_B_ID);
    master_b_buf[10] ^= 0xFF;
    result = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(result == StorageResult::CORRUPTED_PAGE, "Two corrupt masters are rejected");

    MasterData tie_data{};
    tie_data.generation_id = 5;
    tie_data.page_count = 10;
    MasterPage::serialize(tie_data, master_a_buf);
    MasterPage::serialize(tie_data, master_b_buf);
    result = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(result == StorageResult::SUCCESS && active_id == MASTER_PAGE_A_ID,
                "Equal generations use the documented Master A tie-breaker");

    InMemoryPageAccessor failing_flush;
    failing_flush.fail_flush = true;
    TEST_ASSERT(MasterPageManager::init_new_database(failing_flush) == StorageResult::IO_ERROR,
                "Initialization reports flush failures");

    InMemoryPageAccessor failing_sync;
    failing_sync.fail_sync = true;
    TEST_ASSERT(MasterPageManager::init_new_database(failing_sync) == StorageResult::IO_ERROR,
                "Initialization reports sync failures");

    accessor.fail_flush = true;
    TEST_ASSERT(MasterPageManager::commit_master(accessor, active_id, active_data) == StorageResult::IO_ERROR,
                "Commit reports flush failures");
    accessor.fail_flush = false;
    accessor.fail_mark_dirty = true;
    TEST_ASSERT(MasterPageManager::commit_master(accessor, active_id, active_data) == StorageResult::IO_ERROR,
                "Commit reports dirty-mark failures");
    accessor.fail_mark_dirty = false;

    std::vector<uint8_t> test_master(DATABASE_PAGE_SIZE, 0);
    MasterData valid_data{};
    valid_data.generation_id = 1;
    valid_data.page_count = 5;
    MasterPage::serialize(valid_data, test_master.data());
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::SUCCESS,
                "A valid serialized master passes validation");

    auto rewrite_checksum = [&]() {
        const uint32_t csum = checksum::compute_page_checksum(test_master.data(), MasterPage::CHECKSUM_OFFSET);
        endian::write_uint32(test_master.data() + MasterPage::CHECKSUM_OFFSET, csum);
    };

    endian::write_uint32(test_master.data() + 0x1C, 1);
    rewrite_checksum();
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE,
                "Page counts below two are rejected");

    MasterPage::serialize(valid_data, test_master.data());
    endian::write_int32(test_master.data() + 0x10, 10);
    rewrite_checksum();
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE,
                "Roots outside the page count are rejected");

    MasterPage::serialize(valid_data, test_master.data());
    endian::write_int32(test_master.data() + 0x14, 1);
    rewrite_checksum();
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE,
                "Roots pointing to master pages are rejected");

    MasterPage::serialize(valid_data, test_master.data());
    test_master[0x50] = 0x01;
    rewrite_checksum();
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE,
                "Nonzero reserved bytes are rejected");

    MasterPage::serialize(valid_data, test_master.data());
    endian::write_uint16(test_master.data() + 0x04, 2);
    rewrite_checksum();
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::VERSION_MISMATCH,
                "Unsupported master versions are rejected");

    MasterPage::serialize(valid_data, test_master.data());
    endian::write_uint32(test_master.data() + 0x1C,
                         static_cast<uint32_t>(std::numeric_limits<page_id_t>::max()) + 1u);
    rewrite_checksum();
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE,
                "Page counts beyond the page ID range are rejected");

    std::cout << "[PASSED] dual-master metadata tests" << std::endl;
}

} // namespace webdb::test
