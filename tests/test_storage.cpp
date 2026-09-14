#include "common/types.hpp"
#include "common/checksum.hpp"
#include "common/endian.hpp"
#include "storage/page_accessor.hpp"
#include "storage/master_page.hpp"
#include "storage/slotted_page.hpp"
#include "storage/tuple.hpp"
#include "storage/value.hpp"
#include "storage/table_heap.hpp"

#include <iostream>
#include <vector>
#include <string>
#include <cassert>
#include <unordered_map>
#include <cmath>

namespace webdb::test {

/**
 * @brief In-memory implementation of IPageAccessor for Phase 1 verification.
 */
class InMemoryPageAccessor final : public IPageAccessor {
public:
    StorageResult fetch_page(page_id_t page_id, uint8_t** out_page) override {
        auto it = pages_.find(page_id);
        if (it == pages_.end()) {
            return StorageResult::IO_ERROR;
        }
        *out_page = it->second.data();
        return StorageResult::SUCCESS;
    }

    StorageResult allocate_page(page_id_t expected_page_id, uint8_t** out_page) override {
        if (pages_.find(expected_page_id) != pages_.end()) {
            return StorageResult::INVALID_ARGUMENT;
        }
        pages_[expected_page_id] = std::vector<uint8_t>(PAGE_SIZE, 0);
        *out_page = pages_[expected_page_id].data();
        return StorageResult::SUCCESS;
    }

    StorageResult mark_dirty(page_id_t page_id) override {
        if (fail_mark_dirty) return StorageResult::IO_ERROR;
        if (pages_.find(page_id) == pages_.end()) return StorageResult::IO_ERROR;
        dirty_pages_.insert(page_id);
        return StorageResult::SUCCESS;
    }

    StorageResult flush_page(page_id_t page_id) override {
        if (fail_flush) return StorageResult::IO_ERROR;
        if (pages_.find(page_id) == pages_.end()) return StorageResult::IO_ERROR;
        dirty_pages_.erase(page_id);
        flush_history.push_back(page_id);
        return StorageResult::SUCCESS;
    }

    StorageResult flush_dirty_pages() override {
        if (fail_flush) return StorageResult::IO_ERROR;
        std::vector<page_id_t> to_flush(dirty_pages_.begin(), dirty_pages_.end());
        for (page_id_t pid : to_flush) {
            auto res = flush_page(pid);
            if (res != StorageResult::SUCCESS) return res;
        }
        return StorageResult::SUCCESS;
    }

    StorageResult sync() override {
        if (fail_sync) return StorageResult::IO_ERROR;
        sync_call_count++;
        return StorageResult::SUCCESS;
    }

    bool fail_flush{false};
    bool fail_sync{false};
    bool fail_mark_dirty{false};
    size_t sync_call_count{0};
    std::vector<page_id_t> flush_history;

    size_t dirty_count() const noexcept {
        return dirty_pages_.size();
    }

    bool has_page(page_id_t page_id) const {
        return pages_.find(page_id) != pages_.end();
    }

    uint8_t* raw_buffer(page_id_t page_id) {
        return pages_.at(page_id).data();
    }

private:
    std::unordered_map<page_id_t, std::vector<uint8_t>> pages_;
    std::unordered_set<page_id_t> dirty_pages_;
};

#define TEST_ASSERT(cond, msg) \
    do { \
        if (!(cond)) { \
            std::cerr << "FAILED: " << msg << " at " << __FILE__ << ":" << __LINE__ << std::endl; \
            std::exit(1); \
        } \
    } while (0)

void test_checksums() {
    std::cout << "[RUNNING] test_checksums..." << std::endl;

    // 1. Known CRC32 test vector
    const std::string text = "123456789";
    const uint32_t csum = checksum::crc32(reinterpret_cast<const uint8_t*>(text.data()), text.size());
    // Known standard CRC-32 IEEE 802.3 for "123456789" is 0xCBF43926
    TEST_ASSERT(csum == 0xCBF43926u, "CRC-32 IEEE 802.3 standard vector check");

    // 2. Page checksum masking verification
    std::vector<uint8_t> page(PAGE_SIZE, 0xAB);
    // Set dummy checksum field
    endian::write_uint32(page.data() + 0x20, 0x12345678u);
    const uint32_t page_csum1 = checksum::compute_page_checksum(page.data(), 0x20);

    // Modify the checksum field itself; computed checksum must remain identical because it is zero-masked
    endian::write_uint32(page.data() + 0x20, 0xDEADBEEFu);
    const uint32_t page_csum2 = checksum::compute_page_checksum(page.data(), 0x20);
    TEST_ASSERT(page_csum1 == page_csum2, "Checksum field zero-masking invariance");

    // Mutating any other byte MUST change the checksum
    page[0] ^= 0x01;
    const uint32_t page_csum3 = checksum::compute_page_checksum(page.data(), 0x20);
    TEST_ASSERT(page_csum1 != page_csum3, "Byte flip changes CRC");

    std::cout << "[PASSED] test_checksums" << std::endl;
}

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

    // 4. Reload active master -> should now be Master B with generation 2
    res = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Reload master");
    TEST_ASSERT(active_id == MASTER_PAGE_B_ID, "Master B is now active");
    TEST_ASSERT(active_data.generation_id == 2, "Generation incremented to 2");
    TEST_ASSERT(active_data.system_tables_root == 2, "System tables root matches");
    TEST_ASSERT(active_data.page_count == 3, "Page count updated");

    // 5. Interrupted write simulation: Corrupt Master B and reload -> falls back to Master A
    uint8_t* master_b_buf = accessor.raw_buffer(MASTER_PAGE_B_ID);
    master_b_buf[10] ^= 0xFF; // Corrupt byte
    res = MasterPageManager::load_active_master(accessor, active_id, active_data);
    TEST_ASSERT(res == StorageResult::SUCCESS, "Fall back to valid master");
    TEST_ASSERT(active_id == MASTER_PAGE_A_ID, "Master A selected after Master B corrupted");
    TEST_ASSERT(active_data.generation_id == 1, "Fallback generation is 1");

    // 6. Total corruption: Corrupt Master A too -> returns CORRUPTED_PAGE
    uint8_t* master_a_buf = accessor.raw_buffer(MASTER_PAGE_A_ID);
    master_a_buf[10] ^= 0xFF;
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

    std::cout << "[PASSED] test_master_page_dual" << std::endl;
}

void test_slotted_page() {
    std::cout << "[RUNNING] test_slotted_page..." << std::endl;
    std::vector<uint8_t> buffer(PAGE_SIZE, 0);

    TablePage::init(buffer.data(), 2, INVALID_PAGE_ID, INVALID_PAGE_ID);
    auto val_res = TablePage::validate(buffer.data(), 2, 10);
    TEST_ASSERT(val_res == StorageResult::SUCCESS, "Fresh TablePage validates");

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
    while (true) {
        uint16_t s = 0;
        if (page.insert_tuple(chunk.data(), chunk.size(), s) == StorageResult::SUCCESS) {
            slots.push_back(s);
        } else {
            break;
        }
    }
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

    // 6. In-place update
    const std::vector<uint8_t> smaller_t1(50, 0x33);
    auto upd_res = page.update_tuple(slots[0], smaller_t1.data(), smaller_t1.size());
    TEST_ASSERT(upd_res.success(), "In-place shrink update succeeds");
    TEST_ASSERT(!upd_res.rid_changed, "RID does not change on in-place shrink");
    get_res = page.get_tuple(slots[0], &out_p, out_len);
    TEST_ASSERT(out_len == 50 && out_p[0] == 0x33, "Shrunk tuple payload matches");

    // 7. Corrupted slot offset protection in update_tuple, get_tuple, and delete_tuple
    // Corrupt slot 0's offset in the slot directory to point below free_space_pointer
    uint8_t* slot0_ptr = buffer.data() + PAGE_HEADER_SIZE;
    endian::write_uint16(slot0_ptr, static_cast<uint16_t>((static_cast<uint16_t>(SlotState::LIVE) << 14) | 10u)); // offset = 10 (< free_space_pointer)

    auto bad_upd = page.update_tuple(slots[0], smaller_t1.data(), smaller_t1.size());
    TEST_ASSERT(bad_upd.status == StorageResult::CORRUPTED_PAGE, "update_tuple rejects corrupted slot offset");

    auto bad_get = page.get_tuple(slots[0], &out_p, out_len);
    TEST_ASSERT(bad_get == StorageResult::CORRUPTED_PAGE, "get_tuple rejects corrupted slot offset");

    auto bad_del = page.delete_tuple(slots[0]);
    TEST_ASSERT(bad_del == StorageResult::CORRUPTED_PAGE, "delete_tuple rejects corrupted slot offset");

    std::cout << "[PASSED] test_slotted_page" << std::endl;
}

void test_tuple_and_3vl() {
    std::cout << "[RUNNING] test_tuple_and_3vl..." << std::endl;

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

    // Exact equality
    TEST_ASSERT(v_int10.compare_equals(v_int10) == true, "10 == 10");
    TEST_ASSERT(v_int10.compare_equals(v_int20) == false, "10 != 20");
    TEST_ASSERT(v_int10.compare_equals(v_double10) == true, "10 == 10.0");
    TEST_ASSERT(v_double10.compare_equals(v_int10) == true, "10.0 == 10");
    TEST_ASSERT(v_str_a.compare_less_than(v_str_b) == true, "apple < banana");

    // Precision boundary: integer cannot equal double with fractional part
    Value v_double_frac = Value::make_double(10.5);
    TEST_ASSERT(v_int10.compare_equals(v_double_frac) == false, "10 != 10.5");
    TEST_ASSERT(v_int10.compare_less_than(v_double_frac) == true, "10 < 10.5");

    // 2. UTF-8 validation
    TEST_ASSERT(Value::is_valid_utf8("Hello, World!"), "ASCII is valid UTF-8");
    TEST_ASSERT(Value::is_valid_utf8("こんにちは"), "Japanese characters valid UTF-8");
    const char bad_utf8[] = { static_cast<char>(0xFF), static_cast<char>(0xFE), 0 };
    TEST_ASSERT(!Value::is_valid_utf8(std::string_view(bad_utf8, 2)), "Invalid UTF-8 rejected");

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

    std::cout << "[PASSED] test_tuple_and_3vl" << std::endl;
}

void test_table_heap() {
    std::cout << "[RUNNING] test_table_heap..." << std::endl;
    InMemoryPageAccessor accessor;

    // 1. Initialize master pages
    MasterPageManager::init_new_database(accessor);
    page_id_t active_id = INVALID_PAGE_ID;
    MasterData master{};
    MasterPageManager::load_active_master(accessor, active_id, master);

    // 2. Create TableHeap
    TableHeap heap;
    auto create_res = TableHeap::create(accessor, master, heap);
    TEST_ASSERT(create_res == StorageResult::SUCCESS, "Create TableHeap");
    TEST_ASSERT(heap.get_first_page_id() == 2, "First page is 2");

    Schema schema({
        Column{"id", TypeId::INT, false},
        Column{"payload", TypeId::TEXT, false}
    });

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

    // 7. Commit with dirty data pages and verify flush ordering
    accessor.flush_history.clear();
    TEST_ASSERT(accessor.dirty_count() > 0, "Dirty data pages exist before commit");
    master.system_tables_root = heap.get_first_page_id();
    auto commit_res = MasterPageManager::commit_master(accessor, active_id, master);
    TEST_ASSERT(commit_res == StorageResult::SUCCESS, "Commit master with dirty heap pages");
    TEST_ASSERT(accessor.dirty_count() == 0, "All dirty data and master pages flushed after commit");

    // Verify ordering: data pages must be flushed before the inactive master page
    const page_id_t expected_inactive_master = (active_id == MASTER_PAGE_A_ID) ? MASTER_PAGE_B_ID : MASTER_PAGE_A_ID;
    auto master_flush_it = std::find(accessor.flush_history.begin(), accessor.flush_history.end(), expected_inactive_master);
    TEST_ASSERT(master_flush_it != accessor.flush_history.end(), "Inactive master was flushed");
    // All items before master_flush_it must be data pages (page_id >= FIRST_DATA_PAGE_ID)
    for (auto it = accessor.flush_history.begin(); it != master_flush_it; ++it) {
        TEST_ASSERT(*it >= FIRST_DATA_PAGE_ID, "Data pages flushed before master metadata");
    }

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

    std::cout << "[PASSED] test_table_heap" << std::endl;
}

} // namespace webdb::test

int main() {
    std::cout << "========================================" << std::endl;
    std::cout << "  WebDB Storage Engine Unit Tests (Phase 1)" << std::endl;
    std::cout << "========================================" << std::endl;

    webdb::test::test_checksums();
    webdb::test::test_master_page_dual();
    webdb::test::test_slotted_page();
    webdb::test::test_tuple_and_3vl();
    webdb::test::test_table_heap();

    std::cout << "\nALL PHASE 1 STORAGE ENGINE TESTS PASSED!" << std::endl;
    return 0;
}
