#include "test_support.hpp"

namespace webdb::test {

#if defined(WEBDB_RUN_CHECKSUMS)
void test_checksums() {
    std::cout << "[RUNNING] test_checksums..." << std::endl;

    // 1. Known CRC32 test vector
    const std::string text = "123456789";
    const uint32_t csum = checksum::crc32(reinterpret_cast<const uint8_t*>(text.data()), text.size());
    // Known standard CRC-32 IEEE 802.3 for "123456789" is 0xCBF43926
    TEST_ASSERT(csum == 0xCBF43926u, "CRC-32 IEEE 802.3 standard vector check");

    // Additional standard vector: empty string has CRC32 = 0
    TEST_ASSERT(checksum::crc32(nullptr, 0) == 0, "CRC32 of empty is 0");

    // 2. Page checksum masking verification for MasterPage (offset 0x20) and TablePage (offset 0x1C)
    std::vector<uint8_t> master_page(PAGE_SIZE, 0xAB);
    endian::write_uint32(master_page.data() + MasterPage::CHECKSUM_OFFSET, 0x12345678u);
    const uint32_t master_csum1 = checksum::compute_page_checksum(master_page.data(), MasterPage::CHECKSUM_OFFSET);

    endian::write_uint32(master_page.data() + MasterPage::CHECKSUM_OFFSET, 0xDEADBEEFu);
    const uint32_t master_csum2 = checksum::compute_page_checksum(master_page.data(), MasterPage::CHECKSUM_OFFSET);
    TEST_ASSERT(master_csum1 == master_csum2, "MasterPage checksum field zero-masking invariance");

    std::vector<uint8_t> table_page(PAGE_SIZE, 0xCD);
    endian::write_uint32(table_page.data() + TablePage::CHECKSUM_OFFSET, 0x55AA55AAu);
    const uint32_t table_csum1 = checksum::compute_page_checksum(table_page.data(), TablePage::CHECKSUM_OFFSET);

    endian::write_uint32(table_page.data() + TablePage::CHECKSUM_OFFSET, 0xCAFEBABEu);
    const uint32_t table_csum2 = checksum::compute_page_checksum(table_page.data(), TablePage::CHECKSUM_OFFSET);
    TEST_ASSERT(table_csum1 == table_csum2, "TablePage checksum field zero-masking invariance");

    // Mutating byte at offset 0, offset 100, and offset 4095 MUST change the checksum
    std::vector<uint8_t> boundary_page(PAGE_SIZE, 0x55);
    const uint32_t base_csum = checksum::compute_page_checksum(boundary_page.data(), TablePage::CHECKSUM_OFFSET);

    boundary_page[0] ^= 0x01;
    TEST_ASSERT(checksum::compute_page_checksum(boundary_page.data(), TablePage::CHECKSUM_OFFSET) != base_csum, "Byte 0 flip changes CRC");
    boundary_page[0] ^= 0x01; // revert

    boundary_page[100] ^= 0x01;
    TEST_ASSERT(checksum::compute_page_checksum(boundary_page.data(), TablePage::CHECKSUM_OFFSET) != base_csum, "Byte 100 flip changes CRC");
    boundary_page[100] ^= 0x01; // revert

    boundary_page[PAGE_SIZE - 1] ^= 0x01;
    TEST_ASSERT(checksum::compute_page_checksum(boundary_page.data(), TablePage::CHECKSUM_OFFSET) != base_csum, "Byte 4095 flip changes CRC");

    std::cout << "[PASSED] test_checksums" << std::endl;
}
#endif

#if defined(WEBDB_RUN_MASTER_PAGE)
void test_master_page_dual() {
    std::cout << "[RUNNING] test_master_page_dual..." << std::endl;
    InMemoryPageAccessor accessor;

    // 1. Initialize new database
    auto res = MasterPageManager::init_new_database(accessor);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Init new database");

    // 2. Discover active master -> must be Master A (generation 1)
    page_id_t active_id = INVALID_PAGE_ID;
    MasterData active_data{};
    res = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Load active master");
    TEST_ASSERT(active_id == MASTER_PAGE_A_ID, "Master A is initially active");
    TEST_ASSERT(active_data.generation_id == 1, "Master A generation is 1");
    TEST_ASSERT(active_data.page_count == 2, "Page count starts at 2");

    // 3. Commit new metadata -> should write Master B with generation 2
    active_data.system_tables_root = 2;
    active_data.page_count = 3;
    res = MasterPageManager::commit_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Commit master update");
    TEST_ASSERT(active_id == MASTER_PAGE_B_ID, "commit_master updates active_id to Master B in-place");

    // Commit a second time using the same active_id variable without re-loading -> must write Master A (gen 3)
    active_data.page_count = 4;
    res = MasterPageManager::commit_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Second commit succeeds");
    TEST_ASSERT(active_id == MASTER_PAGE_A_ID, "commit_master alternates active_id back to Master A");
    TEST_ASSERT(active_data.generation_id == 3, "Generation incremented to 3");

    // 4. Reload active master -> should now be Master A with generation 3
    res = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Reload master");
    TEST_ASSERT(active_id == MASTER_PAGE_A_ID, "Master A is now active");
    TEST_ASSERT(active_data.generation_id == 3, "Generation incremented to 3");
    TEST_ASSERT(active_data.system_tables_root == 2, "System tables root matches");
    TEST_ASSERT(active_data.page_count == 4, "Page count updated");

    // 5. Interrupted write simulation: Corrupt Master A and reload -> falls back to Master B (gen 2)
    uint8_t* master_a_buf = accessor.raw_buffer(MASTER_PAGE_A_ID);
    master_a_buf[10] ^= 0xFF; // Corrupt byte
    res = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Fall back to valid master B");
    TEST_ASSERT(active_id == MASTER_PAGE_B_ID, "Master B selected after Master A corrupted");
    TEST_ASSERT(active_data.generation_id == 2, "Fallback generation is 2");

    // 6. Total corruption: Corrupt Master B too -> returns CORRUPTED_PAGE
    uint8_t* master_b_buf = accessor.raw_buffer(MASTER_PAGE_B_ID);
    master_b_buf[10] ^= 0xFF;
    res = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::CORRUPTED_PAGE, "Both corrupt returns error");

    // 7. Tie-breaker test: Both valid with equal generation 5 -> Master A selected
    MasterData tie_data{};
    tie_data.generation_id = 5;
    tie_data.page_count = 10;
    MasterPage::serialize(tie_data, master_a_buf);
    MasterPage::serialize(tie_data, master_b_buf);
    res = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Tie-break load");
    TEST_ASSERT(active_id == MASTER_PAGE_A_ID, "Tie-break selects Master A");
    TEST_ASSERT(active_data.generation_id == 5, "Generation matches tie");

    // 8. Error propagation on write/sync failure during init and commit
    InMemoryPageAccessor failing_acc;
    failing_acc.fail_flush = true;
    res = MasterPageManager::init_new_database(failing_acc);
    TEST_ASSERT(res == StorageResult::IO_ERROR, "Init fails when flush fails");

    InMemoryPageAccessor failing_sync_acc;
    failing_sync_acc.fail_sync = true;
    res = MasterPageManager::init_new_database(failing_sync_acc);
    TEST_ASSERT(res == StorageResult::IO_ERROR, "Init fails when sync fails");

    // Test commit failure propagation
    accessor.fail_flush = true;
    res = MasterPageManager::commit_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::IO_ERROR, "Commit fails when flush fails");
    accessor.fail_flush = false;

    accessor.fail_mark_dirty = true;
    res = MasterPageManager::commit_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::IO_ERROR, "Commit fails when mark_dirty fails");
    accessor.fail_mark_dirty = false;

    // 9. Master page structural validation rejections
    std::vector<uint8_t> test_master(PAGE_SIZE, 0);
    MasterData valid_md{};
    valid_md.generation_id = 1;
    valid_md.page_count = 5;
    MasterPage::serialize(valid_md, test_master.data());
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::SUCCESS, "Valid serialized master");

    // a. Invalid page_count (< 2)
    endian::write_uint32(test_master.data() + 0x1C, 1);
    uint32_t csum = checksum::compute_page_checksum(test_master.data(), MasterPage::CHECKSUM_OFFSET);
    endian::write_uint32(test_master.data() + MasterPage::CHECKSUM_OFFSET, csum);
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE, "page_count < 2 rejected");

    // b. Invalid root (root >= page_count)
    MasterPage::serialize(valid_md, test_master.data()); // reset
    endian::write_int32(test_master.data() + 0x10, 10); // root 10 >= page_count 5
    csum = checksum::compute_page_checksum(test_master.data(), MasterPage::CHECKSUM_OFFSET);
    endian::write_uint32(test_master.data() + MasterPage::CHECKSUM_OFFSET, csum);
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE, "Root >= page_count rejected");

    // c. Invalid root (root < FIRST_DATA_PAGE_ID and != INVALID_PAGE_ID)
    MasterPage::serialize(valid_md, test_master.data()); // reset
    endian::write_int32(test_master.data() + 0x14, 1); // root 1 is Master B
    csum = checksum::compute_page_checksum(test_master.data(), MasterPage::CHECKSUM_OFFSET);
    endian::write_uint32(test_master.data() + MasterPage::CHECKSUM_OFFSET, csum);
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE, "Root pointing to master page rejected");

    // d. Nonzero reserved bytes
    MasterPage::serialize(valid_md, test_master.data()); // reset
    test_master[0x50] = 0x01; // inside reserved region [0x24..0xFFF]
    csum = checksum::compute_page_checksum(test_master.data(), MasterPage::CHECKSUM_OFFSET);
    endian::write_uint32(test_master.data() + MasterPage::CHECKSUM_OFFSET, csum);
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE, "Nonzero reserved bytes rejected");

    // e. Version mismatch
    MasterPage::serialize(valid_md, test_master.data()); // reset
    endian::write_uint16(test_master.data() + 0x04, 2); // version 2 != 1
    csum = checksum::compute_page_checksum(test_master.data(), MasterPage::CHECKSUM_OFFSET);
    endian::write_uint32(test_master.data() + MasterPage::CHECKSUM_OFFSET, csum);
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::VERSION_MISMATCH, "Version mismatch rejected");

    // f. page_count must fit in the persisted page ID type
    MasterPage::serialize(valid_md, test_master.data());
    endian::write_uint32(test_master.data() + 0x1C,
                         static_cast<uint32_t>(std::numeric_limits<page_id_t>::max()) + 1u);
    csum = checksum::compute_page_checksum(test_master.data(), MasterPage::CHECKSUM_OFFSET);
    endian::write_uint32(test_master.data() + MasterPage::CHECKSUM_OFFSET, csum);
    TEST_ASSERT(MasterPage::validate(test_master.data()) == StorageResult::CORRUPTED_PAGE,
                "page_count beyond page ID range rejected");

    std::cout << "[PASSED] test_master_page_dual" << std::endl;
}
#endif

#if defined(WEBDB_RUN_SLOTTED_PAGE)
void test_slotted_page() {
    std::cout << "[RUNNING] slotted-page layout and mutation tests..." << std::endl;
    std::vector<uint8_t> buffer(PAGE_SIZE, 0);

    TablePage::init(buffer.data(), 2, INVALID_PAGE_ID, INVALID_PAGE_ID);
    auto val_res = TablePage::validate(buffer.data(), 2, 10);
    TEST_ASSERT(val_res == StorageResult::SUCCESS, "Fresh TablePage validates");

    // A page ID must be inside the published page-count range, even with a valid checksum.
    endian::write_int32(buffer.data() + 0x00, 10);
    TablePage(buffer.data()).update_checksum();
    TEST_ASSERT(TablePage::validate(buffer.data(), 10, 10) == StorageResult::CORRUPTED_PAGE,
                "TablePage rejects an unpublished own page ID");
    TablePage::init(buffer.data(), 2, INVALID_PAGE_ID, INVALID_PAGE_ID);

    TablePage page(buffer.data());
    TEST_ASSERT(page.get_page_id() == 2, "Page ID is 2");
    TEST_ASSERT(page.get_slot_count() == 0, "Slot count is 0");
    TEST_ASSERT(page.contiguous_free_space() == PAGE_SIZE - PAGE_HEADER_SIZE, "Initial free space");

    // 1. Insert a 100-byte tuple
    const std::vector<uint8_t> t1(100, 0x11);
    uint16_t s1 = 0;
    auto ins_res = page.insert_tuple(t1.data(), t1.size(), s1);
    TEST_ASSERT(ins_res == StorageResult::SUCCESS, "Insert tuple 1");
    TEST_ASSERT(s1 == 0, "First slot is 0");
    TEST_ASSERT(page.get_slot_count() == 1, "Slot count is 1");

    // Verify retrieval
    const uint8_t* out_p = nullptr;
    size_t out_len = 0;
    auto get_res = page.get_tuple(s1, &out_p, out_len);
    TEST_ASSERT(get_res == StorageResult::SUCCESS, "Get tuple 1");
    TEST_ASSERT(out_len == 100, "Tuple 1 length matches");
    TEST_ASSERT(std::memcmp(out_p, t1.data(), 100) == 0, "Tuple 1 bytes match");

    TEST_ASSERT(page.get_tuple(s1, nullptr, out_len) == StorageResult::INVALID_ARGUMENT,
                "Get tuple rejects a null output pointer");

    // 2. Insert maximum tuple size on an empty page
    std::vector<uint8_t> max_buf(PAGE_SIZE, 0);
    TablePage::init(max_buf.data(), 3);
    TablePage max_page(max_buf.data());
    const std::vector<uint8_t> max_tuple(MAX_TUPLE_SIZE, 0xAA);
    uint16_t max_slot = 0;
    ins_res = max_page.insert_tuple(max_tuple.data(), max_tuple.size(), max_slot);
    TEST_ASSERT(ins_res == StorageResult::SUCCESS, "Insert exact MAX_TUPLE_SIZE");
    TEST_ASSERT(max_page.contiguous_free_space() == 0, "Page is exactly full");

    // Oversized tuple (> MAX_TUPLE_SIZE) must be rejected
    const std::vector<uint8_t> over_tuple(MAX_TUPLE_SIZE + 1, 0xBB);
    uint16_t dummy_slot = 0;
    ins_res = page.insert_tuple(over_tuple.data(), over_tuple.size(), dummy_slot);
    TEST_ASSERT(ins_res == StorageResult::TUPLE_TOO_LARGE, "Oversized tuple rejected");

    // 3. Fill page with 200-byte tuples until PAGE_FULL
    std::vector<uint16_t> slots;
    slots.push_back(s1);
    const std::vector<uint8_t> chunk(200, 0x22);
    StorageResult fill_res = StorageResult::SUCCESS;
    while (true) {
        uint16_t s = 0;
        fill_res = page.insert_tuple(chunk.data(), chunk.size(), s);
        if (fill_res == StorageResult::SUCCESS) {
            slots.push_back(s);
        } else {
            break;
        }
    }
    TEST_ASSERT(fill_res == StorageResult::PAGE_FULL, "Page fill terminates specifically with PAGE_FULL");
    TEST_ASSERT(page.get_slot_count() > 10, "Multiple tuples inserted");

    // 4. Deletion and hole tracking
    (void)page.get_slot_count();
    // Delete slot 2
    auto del_res = page.delete_tuple(slots[2]);
    TEST_ASSERT(del_res == StorageResult::SUCCESS, "Delete slot 2");
    TEST_ASSERT(page.get_slot_state(slots[2]) == SlotState::DEAD, "Slot 2 marked DEAD");
    TEST_ASSERT((page.get_flags() & TablePage::FLAG_HAS_HOLES) != 0, "HAS_HOLES flag set");
    TEST_ASSERT(page.reclaimable_hole_space() >= 200, "Reclaimable hole space tracked");

    // Verify get on deleted slot returns SLOT_NOT_FOUND
    get_res = page.get_tuple(slots[2], &out_p, out_len);
    TEST_ASSERT(get_res == StorageResult::SLOT_NOT_FOUND, "Get deleted slot fails");

    // 5. In-place compaction (defragment)
    page.defragment();
    TEST_ASSERT((page.get_flags() & TablePage::FLAG_HAS_HOLES) == 0, "HAS_HOLES cleared after defrag");
    TEST_ASSERT(page.reclaimable_hole_space() == 0, "Zero holes after defrag");
    // Verify surviving tuples remain readable and unaltered
    get_res = page.get_tuple(slots[0], &out_p, out_len);
    TEST_ASSERT(get_res == StorageResult::SUCCESS && out_len == 100, "Surviving slot 0 valid");
    get_res = page.get_tuple(slots[1], &out_p, out_len);
    TEST_ASSERT(get_res == StorageResult::SUCCESS && out_len == 200, "Surviving slot 1 valid");

    // 6. In-place update (shrink)
    const std::vector<uint8_t> smaller_t1(50, 0x33);
    auto upd_res = page.update_tuple(slots[0], smaller_t1.data(), smaller_t1.size());
    TEST_ASSERT(upd_res.success(), "In-place shrink update succeeds");
    TEST_ASSERT(!upd_res.rid_changed, "RID does not change on in-place shrink");
    get_res = page.get_tuple(slots[0], &out_p, out_len);
    TEST_ASSERT(out_len == 50 && out_p[0] == 0x33, "Shrunk tuple payload matches");

    // Null buffer and zero length rejection on update
    auto null_upd = page.update_tuple(slots[0], nullptr, 50);
    TEST_ASSERT(null_upd.status == StorageResult::INVALID_ARGUMENT, "update_tuple rejects null buffer");
    auto zero_upd = page.update_tuple(slots[0], smaller_t1.data(), 0);
    TEST_ASSERT(zero_upd.status == StorageResult::INVALID_ARGUMENT, "update_tuple rejects zero size");
    auto null_zero_upd = page.update_tuple(slots[0], nullptr, 0);
    TEST_ASSERT(null_zero_upd.status == StorageResult::INVALID_ARGUMENT, "update_tuple rejects null buffer and zero size");

    // 7. Same-page growth update (growing into contiguous free space)
    std::vector<uint8_t> growth_buf(PAGE_SIZE, 0);
    TablePage::init(growth_buf.data(), 4);
    TablePage growth_page(growth_buf.data());
    const std::vector<uint8_t> init_item(50, 0x44);
    uint16_t growth_slot = 0;
    growth_page.insert_tuple(init_item.data(), init_item.size(), growth_slot);
    TEST_ASSERT(growth_slot == 0, "Inserted init item at slot 0");

    const std::vector<uint8_t> grown_item(120, 0x55);
    auto growth_res = growth_page.update_tuple(growth_slot, grown_item.data(), grown_item.size());
    TEST_ASSERT(growth_res.success(), "Same-page growth succeeds");
    TEST_ASSERT(!growth_res.rid_changed, "Same-page growth preserves RID");
    get_res = growth_page.get_tuple(growth_slot, &out_p, out_len);
    TEST_ASSERT(out_len == 120 && out_p[0] == 0x55, "Grown item data valid");
    TEST_ASSERT((growth_page.get_flags() & TablePage::FLAG_HAS_HOLES) != 0, "Old item space becomes hole");

    // 7b. Growth requiring compaction: the net growth fits, but contiguous space does not.
    std::vector<uint8_t> case_c_buf(PAGE_SIZE, 0);
    TablePage::init(case_c_buf.data(), 8);
    TablePage case_c_page(case_c_buf.data());
    uint16_t c_s0 = 0, c_s1 = 0, c_s2 = 0;
    const std::vector<uint8_t> c_item1(1500, 0x11);
    const std::vector<uint8_t> c_item2(1500, 0x22);
    const std::vector<uint8_t> c_item3(500, 0x33);
    case_c_page.insert_tuple(c_item1.data(), c_item1.size(), c_s0);
    case_c_page.insert_tuple(c_item2.data(), c_item2.size(), c_s1);
    case_c_page.insert_tuple(c_item3.data(), c_item3.size(), c_s2);
    // Delete item 1 to create a 1500 byte hole
    case_c_page.delete_tuple(c_s1);
    // Item 3 is at slot 2 (last slot, 500 bytes). Contiguous free space is ~500 bytes.
    // Grow item 3 to 1200 bytes (delta = 700 bytes > contiguous free space, fits after compaction)
    const std::vector<uint8_t> c_item3_grown(1200, 0x77);
    auto c_res = case_c_page.update_tuple(c_s2, c_item3_grown.data(), c_item3_grown.size());
    TEST_ASSERT(c_res.success(), "Growth requiring compaction succeeds");
    TEST_ASSERT(TablePage::validate(case_c_buf.data(), 8, 20) == StorageResult::SUCCESS,
                "Page remains valid after compaction-based growth");
    get_res = case_c_page.get_tuple(c_s2, &out_p, out_len);
    TEST_ASSERT(get_res == StorageResult::SUCCESS && out_len == 1200 && out_p[0] == 0x77,
                "Updated trailing slot retains its payload after compaction");

    // 7c. Regression test: delta fits in contiguous free space but n_size does NOT
    // (Must trigger Case C compaction, NOT allocate past slot directory in Case B)
    std::vector<uint8_t> case_b_c_buf(PAGE_SIZE, 0);
    TablePage::init(case_b_c_buf.data(), 9);
    TablePage case_b_c_page(case_b_c_buf.data());
    uint16_t b_c_s0 = 0, b_c_s1 = 0;
    // Fill page almost completely: leave exactly 100 bytes contiguous free space
    // Header=36, slots=8 -> slot dir end = 44. To have 100 contiguous bytes, free_ptr = 144.
    // Total payload space needed = 4096 - 144 = 3952 bytes.
    // Item 0: 3852 bytes, Item 1: 100 bytes.
    const std::vector<uint8_t> b_c_item0(3852, 0xAA);
    const std::vector<uint8_t> b_c_item1(100, 0xBB);
    case_b_c_page.insert_tuple(b_c_item0.data(), b_c_item0.size(), b_c_s0);
    case_b_c_page.insert_tuple(b_c_item1.data(), b_c_item1.size(), b_c_s1);
    TEST_ASSERT(case_b_c_page.contiguous_free_space() == 100, "Contiguous free space is exactly 100");

    // Grow item 1 from 100 bytes to 150 bytes:
    // delta = 50 <= contiguous_free_space() (100).
    // But n_size = 150 > contiguous_free_space() (100)!
    // If buggy Case B ran, free_ptr would drop from 144 to (144 - 150) -> underflow or cross dir end (44)!
    const std::vector<uint8_t> b_c_item1_grown(150, 0xCC);
    auto b_c_res = case_b_c_page.update_tuple(b_c_s1, b_c_item1_grown.data(), b_c_item1_grown.size());
    TEST_ASSERT(b_c_res.success(), "Update succeeds via compaction when n_size > contiguous_free_space");
    TEST_ASSERT(TablePage::validate(case_b_c_buf.data(), 9, 20) == StorageResult::SUCCESS, "Page remains valid and non-corrupted");
    get_res = case_b_c_page.get_tuple(b_c_s1, &out_p, out_len);
    TEST_ASSERT(get_res == StorageResult::SUCCESS && out_len == 150 && out_p[0] == 0xCC, "Tuple data valid");
    TEST_ASSERT(case_b_c_page.contiguous_free_space() == 50, "Contiguous free space correctly reflects compacted growth (100 - 50 = 50)");

    // 8. Trailing dead-slot pruning on defragment
    std::vector<uint8_t> prune_buf(PAGE_SIZE, 0);
    TablePage::init(prune_buf.data(), 5);
    TablePage prune_page(prune_buf.data());
    uint16_t ps0 = 0, ps1 = 0, ps2 = 0;
    const std::vector<uint8_t> p_item(40, 0x66);
    prune_page.insert_tuple(p_item.data(), p_item.size(), ps0);
    prune_page.insert_tuple(p_item.data(), p_item.size(), ps1);
    prune_page.insert_tuple(p_item.data(), p_item.size(), ps2);
    TEST_ASSERT(prune_page.get_slot_count() == 3, "Slot count is 3");

    // Delete trailing slots (slot 2 and slot 1)
    prune_page.delete_tuple(ps2);
    prune_page.delete_tuple(ps1);
    TEST_ASSERT(prune_page.get_slot_count() == 3, "Before defrag, slot count still 3");
    prune_page.defragment();
    TEST_ASSERT(prune_page.get_slot_count() == 1,
                "Defragmentation prunes trailing DEAD slots and leaves one slot");
    get_res = prune_page.get_tuple(ps0, &out_p, out_len);
    TEST_ASSERT(get_res == StorageResult::SUCCESS && out_len == 40, "Slot 0 remains valid");

    // 8b. Trailing DEAD slot pruning during insert_tuple with compaction
    // When cur_slots had trailing DEAD slots, insert_tuple might initially pick slot 1 as reusable DEAD slot.
    // Compaction prunes slots 1 & 2 down to 1. The new slot must be placed at slot 1, and slot_count must become 2 (not 3+1=4!).
    std::vector<uint8_t> prune_ins_buf(PAGE_SIZE, 0);
    TablePage::init(prune_ins_buf.data(), 12);
    TablePage prune_ins_page(prune_ins_buf.data());
    uint16_t pi0 = 0, pi1 = 0, pi2 = 0;
    prune_ins_page.insert_tuple(p_item.data(), p_item.size(), pi0);
    prune_ins_page.insert_tuple(p_item.data(), p_item.size(), pi1);
    prune_ins_page.insert_tuple(p_item.data(), p_item.size(), pi2);
    // Delete slots 1 and 2, creating holes and trailing dead slots
    prune_ins_page.delete_tuple(pi2);
    prune_ins_page.delete_tuple(pi1);
    TEST_ASSERT(prune_ins_page.get_slot_count() == 3, "Slot count before insert is 3");
    // Insert a new tuple that forces defragmentation (e.g. size that doesn't fit in contiguous space without compaction)
    const uint16_t available_contig = prune_ins_page.contiguous_free_space();
    const std::vector<uint8_t> big_item(available_contig + 20, 0x88); // forces compaction
    uint16_t pi_new = 0;
    auto ins_prune_res = prune_ins_page.insert_tuple(big_item.data(), big_item.size(), pi_new);
    TEST_ASSERT(ins_prune_res == StorageResult::SUCCESS,
                "Insert succeeds after defragmenting trailing DEAD slots");
    TEST_ASSERT(pi_new == 1, "Inserted tuple reuses the first slot after trailing-slot pruning");
    TEST_ASSERT(prune_ins_page.get_slot_count() == 2,
                "Slot count reflects one surviving slot plus the inserted slot");
    TEST_ASSERT(TablePage::validate(prune_ins_buf.data(), 12, 20) == StorageResult::SUCCESS, "Page valid without empty/corrupted slots");

    // 9. Malformed TablePage validation tests
    std::vector<uint8_t> malformed(PAGE_SIZE, 0);
    TablePage::init(malformed.data(), 6, INVALID_PAGE_ID, INVALID_PAGE_ID);

    // a. slot_count > MAX_SLOT_COUNT
    endian::write_uint16(malformed.data() + 0x0C, MAX_SLOT_COUNT + 1);
    TablePage::init(malformed.data(), 6); // re-init
    endian::write_uint16(malformed.data() + 0x0C, 1016);
    TablePage(malformed.data()).update_checksum();
    TEST_ASSERT(TablePage::validate(malformed.data(), 6, 10) == StorageResult::CORRUPTED_PAGE, "slot_count > MAX rejected");

    // b. free_space_pointer < slot_dir_end
    TablePage::init(malformed.data(), 6);
    endian::write_uint16(malformed.data() + 0x0E, static_cast<uint16_t>(PAGE_HEADER_SIZE - 1));
    TablePage(malformed.data()).update_checksum();
    TEST_ASSERT(TablePage::validate(malformed.data(), 6, 10) == StorageResult::CORRUPTED_PAGE, "free_space_pointer < slot_dir_end rejected");

    // c. free_space_pointer > PAGE_SIZE
    TablePage::init(malformed.data(), 6);
    endian::write_uint16(malformed.data() + 0x0E, static_cast<uint16_t>(PAGE_SIZE + 1));
    TablePage(malformed.data()).update_checksum();
    TEST_ASSERT(TablePage::validate(malformed.data(), 6, 10) == StorageResult::CORRUPTED_PAGE, "free_space_pointer > PAGE_SIZE rejected");

    // d. Nonzero generation_id on table page
    TablePage::init(malformed.data(), 6);
    endian::write_uint64(malformed.data() + 0x10, 1);
    TablePage(malformed.data()).update_checksum();
    TEST_ASSERT(TablePage::validate(malformed.data(), 6, 10) == StorageResult::CORRUPTED_PAGE, "Nonzero generation_id on TablePage rejected");

    // e. Unknown flag bits set
    TablePage::init(malformed.data(), 6);
    endian::write_uint32(malformed.data() + 0x18, 0x02); // bit 1 set
    TablePage(malformed.data()).update_checksum();
    TEST_ASSERT(TablePage::validate(malformed.data(), 6, 10) == StorageResult::CORRUPTED_PAGE, "Unknown flags rejected");

    // f. Reserved slot bit set (bit 13)
    TablePage::init(malformed.data(), 6);
    TablePage(malformed.data()).insert_tuple(p_item.data(), p_item.size(), ps0);
    uint8_t* s_entry = malformed.data() + PAGE_HEADER_SIZE;
    uint16_t s_meta = endian::read_uint16(s_entry);
    s_meta |= (1u << 13); // set reserved bit 13
    endian::write_uint16(s_entry, s_meta);
    TablePage(malformed.data()).update_checksum();
    TEST_ASSERT(TablePage::validate(malformed.data(), 6, 10) == StorageResult::CORRUPTED_PAGE, "Reserved slot bit set rejected");

    // g. Overlapping live slot payloads
    TablePage::init(malformed.data(), 6);
    TablePage tp_overlap(malformed.data());
    tp_overlap.insert_tuple(p_item.data(), p_item.size(), ps0);
    tp_overlap.insert_tuple(p_item.data(), p_item.size(), ps1);
    // Force slot 1 to point to same offset as slot 0
    uint8_t* s1_entry = malformed.data() + PAGE_HEADER_SIZE + SLOT_ENTRY_SIZE;
    uint16_t s0_offset = tp_overlap.get_slot_offset(ps0);
    endian::write_uint16(s1_entry, static_cast<uint16_t>((static_cast<uint16_t>(SlotState::LIVE) << 14) | (s0_offset & 0x1FFFu)));
    tp_overlap.update_checksum();
    TEST_ASSERT(TablePage::validate(malformed.data(), 6, 10) == StorageResult::CORRUPTED_PAGE, "Overlapping live payloads rejected");

    // h. Invalid slot state (EMPTY or FORWARDED inside [0, slot_count))
    TablePage::init(malformed.data(), 6);
    TablePage tp_state(malformed.data());
    tp_state.insert_tuple(p_item.data(), p_item.size(), ps0);
    endian::write_uint16(malformed.data() + PAGE_HEADER_SIZE, static_cast<uint16_t>((static_cast<uint16_t>(SlotState::FORWARDED) << 14) | 4000u));
    tp_state.update_checksum();
    TEST_ASSERT(TablePage::validate(malformed.data(), 6, 10) == StorageResult::CORRUPTED_PAGE, "FORWARDED slot state rejected in Phase 1");

    // 10. Corrupted slot offset protection in update_tuple, get_tuple, and delete_tuple
    // Corrupt slot 0's offset in the slot directory to point below free_space_pointer
    uint8_t* slot0_ptr = buffer.data() + PAGE_HEADER_SIZE;
    endian::write_uint16(slot0_ptr, static_cast<uint16_t>((static_cast<uint16_t>(SlotState::LIVE) << 14) | 10u)); // offset = 10 (< free_space_pointer)

    auto bad_upd = page.update_tuple(slots[0], smaller_t1.data(), smaller_t1.size());
    TEST_ASSERT(bad_upd.status == StorageResult::CORRUPTED_PAGE, "update_tuple rejects corrupted slot offset");

    auto bad_get = page.get_tuple(slots[0], &out_p, out_len);
    TEST_ASSERT(bad_get == StorageResult::CORRUPTED_PAGE, "get_tuple rejects corrupted slot offset");

    auto bad_del = page.delete_tuple(slots[0]);
    TEST_ASSERT(bad_del == StorageResult::CORRUPTED_PAGE, "delete_tuple rejects corrupted slot offset");

    std::cout << "[PASSED] slotted-page layout and mutation tests" << std::endl;
}
#endif

#if defined(WEBDB_RUN_TUPLE)
void test_tuple_and_3vl() {
    std::cout << "[RUNNING] tuple serialization and three-valued logic tests..." << std::endl;

    // 1. 3VL Value comparisons
    Value v_null = Value::make_null(TypeId::INT);
    Value v_int10 = Value::make_int(10);
    Value v_int20 = Value::make_int(20);
    Value v_double10 = Value::make_double(10.0);
    Value v_double20 = Value::make_double(20.0);
    Value v_nan = Value::make_double(std::nan(""));
    Value v_str_a = Value::make_text("apple");
    Value v_str_b = Value::make_text("banana");

    // NULL comparisons must yield std::nullopt (UNKNOWN)
    TEST_ASSERT(!v_null.compare_equals(v_null).has_value(), "NULL = NULL is UNKNOWN");
    TEST_ASSERT(!v_null.compare_equals(v_int10).has_value(), "NULL = 10 is UNKNOWN");
    TEST_ASSERT(!v_int10.compare_equals(v_null).has_value(), "10 = NULL is UNKNOWN");
    TEST_ASSERT(!v_double10.compare_equals(v_nan).has_value(), "10.0 = NaN is UNKNOWN");

    // NaN compared with ANY value (including TEXT and INT) must yield UNKNOWN in 3VL
    TEST_ASSERT(!v_nan.compare_equals(v_nan).has_value(), "NaN = NaN is UNKNOWN");
    TEST_ASSERT(!v_nan.compare_equals(v_int10).has_value(), "NaN = INT is UNKNOWN");
    TEST_ASSERT(!v_int10.compare_equals(v_nan).has_value(), "INT = NaN is UNKNOWN");
    TEST_ASSERT(!v_nan.compare_equals(v_str_a).has_value(), "NaN = TEXT is UNKNOWN");
    TEST_ASSERT(!v_str_a.compare_equals(v_nan).has_value(), "TEXT = NaN is UNKNOWN");
    TEST_ASSERT(!v_nan.compare_less_than(v_str_a).has_value(), "NaN < TEXT is UNKNOWN");
    TEST_ASSERT(!v_str_a.compare_less_than(v_nan).has_value(), "TEXT < NaN is UNKNOWN");
    TEST_ASSERT(!v_nan.compare_less_than(v_int10).has_value(), "NaN < INT is UNKNOWN");
    TEST_ASSERT(!v_int10.compare_less_than(v_nan).has_value(), "INT < NaN is UNKNOWN");

    // Exact equality
    TEST_ASSERT(v_int10.compare_equals(v_int10) == true, "10 == 10");
    TEST_ASSERT(v_int10.compare_equals(v_int20) == false, "10 != 20");
    TEST_ASSERT(v_int10.compare_equals(v_double10) == true, "10 == 10.0");
    TEST_ASSERT(v_double10.compare_equals(v_int10) == true, "10.0 == 10");
    TEST_ASSERT(v_str_a.compare_less_than(v_str_b) == true, "apple < banana");

    // Negative zero vs positive zero: +0.0 == -0.0
    Value v_pos_zero = Value::make_double(+0.0);
    Value v_neg_zero = Value::make_double(-0.0);
    TEST_ASSERT(v_pos_zero.compare_equals(v_neg_zero) == true, "+0.0 == -0.0 in SQL");

    // Extreme numeric boundaries: INT64_MIN (-2^63) and INT64_MAX
    constexpr int64_t kInt64Min = std::numeric_limits<int64_t>::min();
    constexpr int64_t kInt64Max = std::numeric_limits<int64_t>::max();
    Value v_int_min = Value::make_int(kInt64Min);
    Value v_int_max = Value::make_int(kInt64Max);
    Value v_double_min = Value::make_double(-9223372036854775808.0); // exact -2^63
    Value v_double_past_max = Value::make_double(9223372036854775808.0); // 2^63 (cannot be cast to int64)
    TEST_ASSERT(v_int_min.compare_equals(v_double_min) == true, "INT64_MIN == -2^63");
    TEST_ASSERT(v_int_max.compare_equals(v_double_past_max) == false, "INT64_MAX != 2^63");
    TEST_ASSERT(v_int_max.compare_less_than(v_double_past_max) == true, "INT64_MAX < 2^63");
    TEST_ASSERT(v_double_past_max.compare_less_than(v_int_max) == false, "NOT (2^63 < INT64_MAX)");

    // Ordering behavior with finite vs infinities
    Value v_pos_inf = Value::make_double(std::numeric_limits<double>::infinity());
    Value v_neg_inf = Value::make_double(-std::numeric_limits<double>::infinity());
    TEST_ASSERT(v_int_max.compare_less_than(v_pos_inf) == true, "INT64_MAX < +inf");
    TEST_ASSERT(v_neg_inf.compare_less_than(v_int_min) == true, "-inf < INT64_MIN");
    TEST_ASSERT(v_neg_inf.compare_less_than(v_pos_inf) == true, "-inf < +inf");

    // Comparisons around 2^53 (9007199254740992) where double precision starts losing odd integer representation
    constexpr int64_t kTwo53 = 9007199254740992LL;
    Value v_int_2_53 = Value::make_int(kTwo53);
    Value v_int_2_53_plus1 = Value::make_int(kTwo53 + 1);
    Value v_double_2_53 = Value::make_double(static_cast<double>(kTwo53)); // exactly 9007199254740992.0
    TEST_ASSERT(v_int_2_53.compare_equals(v_double_2_53) == true, "2^53 == 2^53.0");
    TEST_ASSERT(v_int_2_53_plus1.compare_equals(v_double_2_53) == false, "2^53+1 != 2^53.0");
    TEST_ASSERT(v_double_2_53.compare_less_than(v_int_2_53_plus1) == true, "2^53.0 < 2^53+1");

    // Precision boundary: integer cannot equal double with fractional part
    Value v_double_frac = Value::make_double(10.5);
    TEST_ASSERT(v_int10.compare_equals(v_double_frac) == false, "10 != 10.5");
    TEST_ASSERT(v_int10.compare_less_than(v_double_frac) == true, "10 < 10.5");

    // 2. UTF-8 validation
    TEST_ASSERT(Value::is_valid_utf8("Hello, World!"), "ASCII is valid UTF-8");
    TEST_ASSERT(Value::is_valid_utf8("こんにちは"), "Japanese characters valid UTF-8");
    const char bad_utf8[] = { static_cast<char>(0xFF), static_cast<char>(0xFE), 0 };
    TEST_ASSERT(!Value::is_valid_utf8(std::string_view(bad_utf8, 2)), "Invalid UTF-8 rejected");

    // Test rejection of 4-byte sequences with lead bytes 0xF5..0xF7 (> U+10FFFF)
    const uint8_t bad_lead_f5[] = { 0xF5, 0x80, 0x80, 0x80 };
    TEST_ASSERT(!Value::is_valid_utf8(std::string_view(reinterpret_cast<const char*>(bad_lead_f5), 4)), "0xF5 lead byte rejected");
    const uint8_t bad_lead_f7[] = { 0xF7, 0xBF, 0xBF, 0xBF };
    TEST_ASSERT(!Value::is_valid_utf8(std::string_view(reinterpret_cast<const char*>(bad_lead_f7), 4)), "0xF7 lead byte rejected");
    const uint8_t max_valid_utf8[] = { 0xF4, 0x8F, 0xBF, 0xBF }; // U+10FFFF
    TEST_ASSERT(Value::is_valid_utf8(std::string_view(reinterpret_cast<const char*>(max_valid_utf8), 4)), "U+10FFFF is valid UTF-8");
    const uint8_t just_above_max[] = { 0xF4, 0x90, 0x80, 0x80 }; // U+110000
    TEST_ASSERT(!Value::is_valid_utf8(std::string_view(reinterpret_cast<const char*>(just_above_max), 4)), "U+110000 is rejected");

    // 3. Schema and Tuple serialization
    Schema schema({
        Column{"id", TypeId::INT, false},
        Column{"name", TypeId::TEXT, false},
        Column{"score", TypeId::DOUBLE, true} // Nullable
    });
    TEST_ASSERT(schema.is_valid(), "Schema is valid");

    std::vector<Value> row1 = {
        Value::make_int(101),
        Value::make_text("Alice"),
        Value::make_double(98.5)
    };

    std::vector<uint8_t> tuple_bytes;
    auto ser_res = Tuple::serialize(row1, schema, tuple_bytes);
    TEST_ASSERT(ser_res == StorageResult::SUCCESS, "Serialize row 1");

    // Deserialize and check
    std::vector<Value> decoded_row1;
    auto deser_res = Tuple::deserialize(tuple_bytes.data(), tuple_bytes.size(), schema, decoded_row1);
    TEST_ASSERT(deser_res == StorageResult::SUCCESS, "Deserialize row 1");
    TEST_ASSERT(decoded_row1.size() == 3, "Decoded 3 columns");
    TEST_ASSERT(decoded_row1[0].as_int() == 101, "Col 0 is 101");
    TEST_ASSERT(decoded_row1[1].as_text() == "Alice", "Col 1 is Alice");
    TEST_ASSERT(decoded_row1[2].as_double() == 98.5, "Col 2 is 98.5");

    // Row with NULL value
    std::vector<Value> row2 = {
        Value::make_int(102),
        Value::make_text("Bob"),
        Value::make_null(TypeId::DOUBLE)
    };
    std::vector<uint8_t> tuple_bytes_null;
    ser_res = Tuple::serialize(row2, schema, tuple_bytes_null);
    TEST_ASSERT(ser_res == StorageResult::SUCCESS, "Serialize row with NULL");

    std::vector<Value> decoded_row2;
    deser_res = Tuple::deserialize(tuple_bytes_null.data(), tuple_bytes_null.size(), schema, decoded_row2);
    TEST_ASSERT(deser_res == StorageResult::SUCCESS, "Deserialize row with NULL");
    TEST_ASSERT(decoded_row2[2].is_null(), "Col 2 is NULL");

    // Attempting NULL in a non-nullable column must be rejected
    std::vector<Value> bad_row = {
        Value::make_null(TypeId::INT), // Non-nullable!
        Value::make_text("Charlie"),
        Value::make_double(50.0)
    };
    std::vector<uint8_t> bad_bytes;
    ser_res = Tuple::serialize(bad_row, schema, bad_bytes);
    TEST_ASSERT(ser_res == StorageResult::SCHEMA_MISMATCH, "NULL in non-nullable column rejected");

    // Typed NULLs must still match the declared nullable column type.
    std::vector<Value> mismatched_null_row = {
        Value::make_int(103),
        Value::make_text("Dana"),
        Value::make_null(TypeId::TEXT)
    };
    TEST_ASSERT(Tuple::serialize(mismatched_null_row, schema, bad_bytes) == StorageResult::SCHEMA_MISMATCH,
                "Typed NULL with the wrong column type rejected");

    // 4. Alignment testing with 1-column, 3-column, and 5-column schemas
    // 1-column schema: tests odd header boundary (FormatVersion 1B + Flags 1B + NumCols 2B + NullBitmap 1B = 5 bytes offset)
    Schema schema_1({
        Column{"single_int", TypeId::INT, false}
    });
    std::vector<Value> row_1 = { Value::make_int(123456789012345678LL) };
    std::vector<uint8_t> bytes_1;
    TEST_ASSERT(Tuple::serialize(row_1, schema_1, bytes_1) == StorageResult::SUCCESS, "Serialize 1-column");
    std::vector<Value> decoded_1;
    TEST_ASSERT(Tuple::deserialize(bytes_1.data(), bytes_1.size(), schema_1, decoded_1) == StorageResult::SUCCESS, "Deserialize 1-column");
    TEST_ASSERT(decoded_1[0].as_int() == 123456789012345678LL, "1-column int matches");

    // 5-column schema: NullBitmap = 1B, total fixed header = 4 + 1 + (5 * 8) = 45 bytes
    Schema schema_5({
        Column{"c0", TypeId::INT, false},
        Column{"c1", TypeId::DOUBLE, false},
        Column{"c2", TypeId::TEXT, true},
        Column{"c3", TypeId::INT, true},
        Column{"c4", TypeId::TEXT, false}
    });
    std::vector<Value> row_5 = {
        Value::make_int(42),
        Value::make_double(3.14159),
        Value::make_null(TypeId::TEXT), // empty/null text
        Value::make_int(-999),
        Value::make_text("") // empty string
    };
    std::vector<uint8_t> bytes_5;
    TEST_ASSERT(Tuple::serialize(row_5, schema_5, bytes_5) == StorageResult::SUCCESS, "Serialize 5-column with empty/null text");
    std::vector<Value> decoded_5;
    TEST_ASSERT(Tuple::deserialize(bytes_5.data(), bytes_5.size(), schema_5, decoded_5) == StorageResult::SUCCESS, "Deserialize 5-column");
    TEST_ASSERT(decoded_5[0].as_int() == 42, "Col 0 matches");
    TEST_ASSERT(decoded_5[1].as_double() == 3.14159, "Col 1 matches");
    TEST_ASSERT(decoded_5[2].is_null(), "Col 2 is NULL");
    TEST_ASSERT(decoded_5[3].as_int() == -999, "Col 3 matches");
    TEST_ASSERT(decoded_5[4].as_text().empty(), "Col 4 is empty string");

    // 5. Tuple deserialization rejections for malformed inputs
    // a. Wrong format version
    std::vector<uint8_t> malformed_t = bytes_1;
    malformed_t[0] = 2; // version 2 != 1
    TEST_ASSERT(Tuple::deserialize(malformed_t.data(), malformed_t.size(), schema_1, decoded_1) == StorageResult::VERSION_MISMATCH, "Bad tuple version rejected");

    // b. Nonzero flags
    malformed_t = bytes_1;
    malformed_t[1] = 0x01; // flags must be 0
    TEST_ASSERT(Tuple::deserialize(malformed_t.data(), malformed_t.size(), schema_1, decoded_1) == StorageResult::CORRUPTED_PAGE, "Nonzero tuple flags rejected");

    // c. Wrong column count
    TEST_ASSERT(Tuple::deserialize(bytes_1.data(), bytes_1.size(), schema, decoded_1) == StorageResult::SCHEMA_MISMATCH, "Wrong column count rejected");

    // d. Nonzero fixed-width field for NULL column
    std::vector<uint8_t> malformed_null_t = tuple_bytes_null;
    // For schema (3 cols), null_bitmap is 1B. Fixed array starts at offset 5.
    // Col 2 fixed field is at 5 + 2 * 8 = 21. Set a nonzero byte in col 2's fixed field.
    malformed_null_t[21] = 0x01;
    TEST_ASSERT(Tuple::deserialize(malformed_null_t.data(), malformed_null_t.size(), schema, decoded_row2) == StorageResult::CORRUPTED_PAGE, "Nonzero NULL field rejected");

    // e. Non-monotonic/overlapping text offset
    // In row1 (id, name: 'Alice' (5B), score), text section starts after fixed header (4 + 1 + 24 = 29)
    // Name text offset is at 5 + 1 * 8 = 13.
    std::vector<uint8_t> malformed_text_t = tuple_bytes;
    endian::write_uint32(malformed_text_t.data() + 13, 10); // var_offset = 10 instead of expected 0
    TEST_ASSERT(Tuple::deserialize(malformed_text_t.data(), malformed_text_t.size(), schema, decoded_row1) == StorageResult::CORRUPTED_PAGE, "Non-monotonic text offset rejected");

    std::cout << "[PASSED] tuple serialization and three-valued logic tests" << std::endl;
}
#endif

#if defined(WEBDB_RUN_TABLE_HEAP)
void test_table_heap() {
    std::cout << "[RUNNING] table-heap allocation, iteration, and recovery tests..." << std::endl;
    InMemoryPageAccessor accessor;

    // 1. Initialize master pages
    MasterPageManager::init_new_database(accessor);
    page_id_t active_id = INVALID_PAGE_ID;
    MasterData master{};
    MasterPageManager::load_active_master(accessor, active_id, master);

    MasterData create_limit_master = master;
    create_limit_master.page_count = static_cast<uint32_t>(std::numeric_limits<page_id_t>::max());
    TableHeap create_limit_heap;
    TEST_ASSERT(TableHeap::create(accessor, create_limit_master, create_limit_heap) == StorageResult::CORRUPTED_PAGE,
                "TableHeap creation rejects the maximum signed page ID as an allocation cursor");

    InMemoryPageAccessor append_limit_accessor;
    uint8_t* append_limit_buf = nullptr;
    TEST_ASSERT(append_limit_accessor.allocate_page(FIRST_DATA_PAGE_ID, &append_limit_buf) == StorageResult::SUCCESS,
                "Allocate the append-boundary test page");
    TablePage::init(append_limit_buf, FIRST_DATA_PAGE_ID);
    TEST_ASSERT(append_limit_accessor.mark_dirty(FIRST_DATA_PAGE_ID) == StorageResult::SUCCESS,
                "Mark the append-boundary test page dirty");
    MasterData append_limit_master = master;
    append_limit_master.page_count = static_cast<uint32_t>(std::numeric_limits<page_id_t>::max());
    TableHeap append_limit_heap(&append_limit_accessor, &append_limit_master,
                                FIRST_DATA_PAGE_ID, FIRST_DATA_PAGE_ID);
    const Tuple full_boundary_tuple(std::vector<uint8_t>(MAX_TUPLE_SIZE, 0xA5));
    RID boundary_rid{};
    TEST_ASSERT(append_limit_heap.insert_tuple(full_boundary_tuple, boundary_rid) == StorageResult::SUCCESS,
                "Fill the append-boundary test page");
    const uint32_t append_count_before = append_limit_master.page_count;
    TEST_ASSERT(append_limit_heap.insert_tuple(Tuple(std::vector<uint8_t>(8, 0x5A)), boundary_rid) == StorageResult::CORRUPTED_PAGE,
                "Append rejects the maximum signed page ID as an allocation cursor");
    TEST_ASSERT(append_limit_master.page_count == append_count_before,
                "Rejected append leaves the page-count cursor unchanged");

    // Exercise failure at both publication points: marking the new page and marking the old tail.
    for (const page_id_t failed_page_id : {3, 2}) {
        InMemoryPageAccessor failing_accessor;
        TEST_ASSERT(MasterPageManager::init_new_database(failing_accessor) == StorageResult::SUCCESS,
                    "Initialize failure-injection database");
        page_id_t failing_active_id = INVALID_PAGE_ID;
        MasterData failing_master{};
        TEST_ASSERT(MasterPageManager::load_active_master(failing_accessor, failing_active_id, failing_master) == StorageResult::SUCCESS,
                    "Load failure-injection master");
        TableHeap failing_heap;
        TEST_ASSERT(TableHeap::create(failing_accessor, failing_master, failing_heap) == StorageResult::SUCCESS,
                    "Create failure-injection heap");

        const Tuple full_tuple(std::vector<uint8_t>(MAX_TUPLE_SIZE, 0xA5));
        RID full_rid{};
        TEST_ASSERT(failing_heap.insert_tuple(full_tuple, full_rid) == StorageResult::SUCCESS,
                    "Fill failure-injection page");
        const uint32_t page_count_before = failing_master.page_count;
        failing_accessor.fail_mark_dirty_page = failed_page_id;

        RID failed_rid{};
        const auto failed_insert = failing_heap.insert_tuple(Tuple(std::vector<uint8_t>(8, 0x5A)), failed_rid);
        TEST_ASSERT(failed_insert == StorageResult::IO_ERROR,
                "Append reports a dirty-mark failure at either publication point");
        TEST_ASSERT(failing_master.page_count == page_count_before,
                "Failed append leaves the allocation cursor unchanged");
        TEST_ASSERT(!failing_accessor.has_page(3),
                "Failed append discards the newly allocated page");

        uint8_t* surviving_buf = nullptr;
        TEST_ASSERT(failing_accessor.fetch_page(failing_heap.get_last_page_id(), &surviving_buf) == StorageResult::SUCCESS,
                    "Fetch surviving tail page");
        TEST_ASSERT(TablePage::validate(surviving_buf, failing_heap.get_last_page_id(), failing_master.page_count) == StorageResult::SUCCESS,
                    "Surviving tail remains valid after failed append");
        TEST_ASSERT(TablePage(surviving_buf).get_next_page_id() == INVALID_PAGE_ID,
                    "Failed append leaves no dangling forward link");
    }

    // 2. Create TableHeap
    TableHeap heap;
    auto create_res = TableHeap::create(accessor, master, heap);
    TEST_ASSERT(create_res == StorageResult::SUCCESS, "Create TableHeap");
    TEST_ASSERT(heap.get_first_page_id() == 2, "First page is 2");

    Schema schema({
        Column{"id", TypeId::INT, false},
        Column{"payload", TypeId::TEXT, false}
    });

    // Test empty tuple insertion rejection
    Tuple empty_tuple;
    RID empty_rid{};
    TEST_ASSERT(heap.insert_tuple(empty_tuple, empty_rid) == StorageResult::INVALID_ARGUMENT, "Heap rejects empty tuple insert");

    // 3. Insert enough rows to span multiple pages (each row ~500 bytes -> ~8 rows per page)
    const std::string large_str(500, 'X');
    constexpr size_t NUM_ROWS = 40; // Should span ~5 pages
    std::vector<RID> inserted_rids;

    for (size_t i = 0; i < NUM_ROWS; ++i) {
        std::vector<Value> row = {
            Value::make_int(static_cast<int64_t>(i)),
            Value::make_text(large_str + std::to_string(i))
        };
        std::vector<uint8_t> bytes;
        Tuple::serialize(row, schema, bytes);
        Tuple tuple(bytes);

        RID rid{};
        auto ins_res = heap.insert_tuple(tuple, rid);
        TEST_ASSERT(ins_res == StorageResult::SUCCESS, "Insert row into heap");
        inserted_rids.push_back(rid);
    }
    TEST_ASSERT(heap.update_tuple(inserted_rids[0], empty_tuple).status == StorageResult::INVALID_ARGUMENT, "Heap rejects empty tuple update");
    TEST_ASSERT(heap.get_last_page_id() >= 5, "Heap spans across at least 4 pages");

    // 4. Sequential scan via TableIterator
    size_t scanned_count = 0;
    for (auto it = heap.begin(); !it.is_end(); it.advance()) {
        TEST_ASSERT(it.is_valid(), "Iterator is valid at live record");
        Tuple t;
        auto get_res = it.get_current_tuple(t);
        TEST_ASSERT(get_res == StorageResult::SUCCESS, "Fetch tuple from iterator");

        std::vector<Value> vals;
        Tuple::deserialize(t.data(), t.size(), schema, vals);
        TEST_ASSERT(vals[0].as_int() == static_cast<int64_t>(scanned_count), "Scanned tuple matches order");
        scanned_count++;
    }
    TEST_ASSERT(scanned_count == NUM_ROWS, "All inserted rows scanned");

    // 5. Update tuple with relocation
    const std::string massive_str(2500, 'Y'); // Too big for existing page with other rows
    std::vector<Value> big_row = {
        Value::make_int(999),
        Value::make_text(massive_str)
    };
    std::vector<uint8_t> big_bytes;
    Tuple::serialize(big_row, schema, big_bytes);
    Tuple big_tuple(big_bytes);

    auto upd_res = heap.update_tuple(inserted_rids[0], big_tuple);
    TEST_ASSERT(upd_res.success(), "Update with enlargement succeeds");
    TEST_ASSERT(upd_res.rid_changed, "Enlarged tuple relocated to new RID");
    TEST_ASSERT(upd_res.new_rid != inserted_rids[0], "New RID differs from old RID");

    // Verify old RID is now dead/not found
    Tuple dead_t;
    auto get_res = heap.get_tuple(inserted_rids[0], dead_t);
    TEST_ASSERT(get_res == StorageResult::SLOT_NOT_FOUND, "Old RID is dead");

    // Verify new RID holds updated data
    Tuple read_back;
    get_res = heap.get_tuple(upd_res.new_rid, read_back);
    TEST_ASSERT(get_res == StorageResult::SUCCESS, "Fetch relocated tuple");
    std::vector<Value> read_vals;
    Tuple::deserialize(read_back.data(), read_back.size(), schema, read_vals);
    TEST_ASSERT(read_vals[0].as_int() == 999, "Relocated tuple value matches");

    // 6. Delete tuple
    auto del_res = heap.delete_tuple(inserted_rids[1]);
    TEST_ASSERT(del_res == StorageResult::SUCCESS, "Delete tuple");
    get_res = heap.get_tuple(inserted_rids[1], dead_t);
    TEST_ASSERT(get_res == StorageResult::SLOT_NOT_FOUND, "Deleted tuple not found");

    // 7. Commit with dirty data pages and verify flush ordering & sync barriers
    accessor.flush_history.clear();
    accessor.events.clear();
    TEST_ASSERT(accessor.dirty_count() > 0, "Dirty data pages exist before commit");
    master.system_tables_root = heap.get_first_page_id();
    const page_id_t master_to_be_written = (active_id == MASTER_PAGE_A_ID) ? MASTER_PAGE_B_ID : MASTER_PAGE_A_ID;
    auto commit_res = MasterPageManager::commit_master(accessor, active_id, master);
    TEST_ASSERT(commit_res == StorageResult::SUCCESS, "Commit master with dirty heap pages");
    TEST_ASSERT(accessor.dirty_count() == 0, "All dirty data and master pages flushed after commit");
    TEST_ASSERT(active_id == master_to_be_written, "active_id updated to the newly committed master");

    // Verify ordering: data pages must be flushed before the newly committed master page
    auto master_flush_it = std::find(accessor.flush_history.begin(), accessor.flush_history.end(), master_to_be_written);
    TEST_ASSERT(master_flush_it != accessor.flush_history.end(), "Inactive master was flushed");
    // All items before master_flush_it must be data pages (page_id >= FIRST_DATA_PAGE_ID)
    for (auto it = accessor.flush_history.begin(); it != master_flush_it; ++it) {
        TEST_ASSERT(*it >= FIRST_DATA_PAGE_ID, "Data pages flushed before master metadata");
    }

    // Verify exact sequence of events:
    // [1..N data page FLUSHes] -> [SYNC 1 (durability barrier for data)] -> [FLUSH master page] -> [SYNC 2 (final commit barrier)]
    auto first_sync_it = std::find_if(accessor.events.begin(), accessor.events.end(), [](const InMemoryPageAccessor::Event& e) {
        return e.type == InMemoryPageAccessor::EventType::SYNC;
    });
    TEST_ASSERT(first_sync_it != accessor.events.end(), "First sync barrier occurred");

    // All events before first sync barrier must be data page flushes
    size_t data_flush_count = 0;
    for (auto it = accessor.events.begin(); it != first_sync_it; ++it) {
        TEST_ASSERT(it->type == InMemoryPageAccessor::EventType::FLUSH, "Pre-sync event is a page flush");
        TEST_ASSERT(it->page_id >= FIRST_DATA_PAGE_ID, "Pre-sync flush is a data page");
        data_flush_count++;
    }
    TEST_ASSERT(data_flush_count > 0, "At least one data page was flushed before first sync barrier");

    // After first sync, exactly one master flush followed by the final sync barrier
    auto after_first_sync = first_sync_it + 1;
    TEST_ASSERT(after_first_sync != accessor.events.end(), "Event exists after first sync");
    TEST_ASSERT(after_first_sync->type == InMemoryPageAccessor::EventType::FLUSH, "Event after first sync is master page flush");
    TEST_ASSERT(after_first_sync->page_id == master_to_be_written, "Flushed page after first sync is the newly committed master");

    auto final_sync_it = after_first_sync + 1;
    TEST_ASSERT(final_sync_it != accessor.events.end(), "Final sync barrier exists");
    TEST_ASSERT(final_sync_it->type == InMemoryPageAccessor::EventType::SYNC, "Event after master flush is final sync barrier");
    TEST_ASSERT(final_sync_it + 1 == accessor.events.end(), "No further events after final sync barrier");

    // 8. Test TableHeap::open with mutable pending_master
    TableHeap reopened_heap;
    auto open_res = TableHeap::open(accessor, master, heap.get_first_page_id(), reopened_heap);
    TEST_ASSERT(open_res == StorageResult::SUCCESS, "Reopen TableHeap successfully");
    TEST_ASSERT(reopened_heap.get_first_page_id() == heap.get_first_page_id(), "Reopened first page matches");
    TEST_ASSERT(reopened_heap.get_last_page_id() == heap.get_last_page_id(), "Reopened last page matches reconstructed tail");

    // Verify append on reopened heap updates master.page_count without UB
    const uint32_t count_before = master.page_count;
    std::vector<Value> extra_row = {
        Value::make_int(12345),
        Value::make_text(std::string(3500, 'Z')) // Force allocation of another page
    };
    std::vector<uint8_t> extra_bytes;
    Tuple::serialize(extra_row, schema, extra_bytes);
    RID extra_rid{};
    auto reopen_ins = reopened_heap.insert_tuple(Tuple(extra_bytes), extra_rid);
    TEST_ASSERT(reopen_ins == StorageResult::SUCCESS, "Insert on reopened heap succeeds");
    TEST_ASSERT(master.page_count > count_before, "pending_master.page_count modified through mutable reference");

    // 9. Cycle detection and backward-link validation in TableIterator
    // Manually create a link cycle: page 3 next_page_id points back to page 2
    uint8_t* p3_buf = accessor.raw_buffer(3);
    TablePage p3(p3_buf);
    p3.set_next_page_id(2);

    auto it = heap.begin();
    while (!it.is_end() && it.status() == IteratorStatus::AT_RECORD) {
        it.advance();
    }
    TEST_ASSERT(it.status() == IteratorStatus::CYCLE_DETECTED, "Iterator caught link cycle");

    // Test first page backward link corruption: first page must have prev_page_id == INVALID_PAGE_ID
    // Create a new heap whose first page has an invalid backward link
    TableHeap bad_head_heap;
    TableHeap::create(accessor, master, bad_head_heap);
    uint8_t* bad_head_buf = accessor.raw_buffer(bad_head_heap.get_first_page_id());
    TablePage bad_head_page(bad_head_buf);
    bad_head_page.set_prev_page_id(2); // Points backward to page 2 instead of INVALID_PAGE_ID
    auto bad_it = bad_head_heap.begin();
    TEST_ASSERT(bad_it.status() == IteratorStatus::CORRUPTED_PAGE, "Iterator catches corrupted first page prev_page_id");

    // 10. Corrupt tail page protection on insert_tuple
    // Corrupt the tail page of reopened_heap
    const page_id_t tail_id = reopened_heap.get_last_page_id();
    uint8_t* tail_buf = accessor.raw_buffer(tail_id);
    tail_buf[15] ^= 0xFF; // Invalidate checksum / structure

    std::vector<Value> test_row = {
        Value::make_int(9999),
        Value::make_text("will fail")
    };
    std::vector<uint8_t> test_bytes;
    Tuple::serialize(test_row, schema, test_bytes);
    RID fail_rid{};
    auto corrupt_ins = reopened_heap.insert_tuple(Tuple(test_bytes), fail_rid);
    TEST_ASSERT(corrupt_ins == StorageResult::CORRUPTED_PAGE, "insert_tuple rejects corrupt tail page");

    // Corrupted page on get_tuple, update_tuple, and delete_tuple
    Tuple dummy_tuple;
    auto corrupt_get = reopened_heap.get_tuple(RID{tail_id, 0}, dummy_tuple);
    TEST_ASSERT(corrupt_get == StorageResult::CORRUPTED_PAGE, "get_tuple rejects corrupt page");

    auto corrupt_upd = reopened_heap.update_tuple(RID{tail_id, 0}, Tuple(test_bytes));
    TEST_ASSERT(corrupt_upd.status == StorageResult::CORRUPTED_PAGE, "update_tuple rejects corrupt page");

    auto corrupt_del = reopened_heap.delete_tuple(RID{tail_id, 0});
    TEST_ASSERT(corrupt_del == StorageResult::CORRUPTED_PAGE, "delete_tuple rejects corrupt page");

    // 11. Iterator error differentiation tests
    // a. Normal end-of-scan: empty heap
    TableHeap empty_heap;
    TableHeap::create(accessor, master, empty_heap);
    auto empty_it = empty_heap.begin();
    TEST_ASSERT(empty_it.status() == IteratorStatus::END_OF_SCAN, "Empty heap iterator yields END_OF_SCAN");
    TEST_ASSERT(empty_it.is_end(), "Empty heap iterator is_end() == true");
    TEST_ASSERT(!empty_it.is_valid(), "Empty heap iterator is_valid() == false");

    // b. Corrupted page link detection
    TableHeap corrupted_link_heap;
    TableHeap::create(accessor, master, corrupted_link_heap);
    RID ins_rid{};
    corrupted_link_heap.insert_tuple(Tuple(test_bytes), ins_rid);
    uint8_t* cl_buf = accessor.raw_buffer(corrupted_link_heap.get_first_page_id());
    TablePage cl_page(cl_buf);
    cl_page.set_next_page_id(master.page_count + 10); // out of range link
    auto cl_it = corrupted_link_heap.begin();
    TEST_ASSERT(cl_it.status() == IteratorStatus::CORRUPTED_PAGE, "Iterator catches corrupted page with invalid link");

    // c. Self-link corruption (page points to itself)
    TableHeap self_link_heap;
    TableHeap::create(accessor, master, self_link_heap);
    const page_id_t sl_id = self_link_heap.get_first_page_id();
    self_link_heap.insert_tuple(Tuple(test_bytes), ins_rid);
    uint8_t* sl_buf = accessor.raw_buffer(sl_id);
    TablePage sl_page(sl_buf);
    sl_page.set_next_page_id(sl_id); // points to itself
    auto sl_it = self_link_heap.begin();
    TEST_ASSERT(sl_it.status() == IteratorStatus::CORRUPTED_PAGE, "Iterator catches self-link corruption");

    std::cout << "[PASSED] table-heap allocation, iteration, and recovery tests" << std::endl;
}
#endif

} // namespace webdb::test
