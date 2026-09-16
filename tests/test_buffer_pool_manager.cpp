#include "test_support.hpp"

#include "storage/buffer_pool_manager.hpp"

namespace webdb::test {

void test_buffer_pool_manager() {
    std::cout << "[RUNNING] buffer pool frame table tests..." << std::endl;

    BufferPoolManager pool(BufferPoolConfig{4, 2, 2});
    TEST_ASSERT(pool.frame_count() == 4, "Configured frame count is retained");
    TEST_ASSERT(pool.free_frame_count() == 4, "All frames begin on the free list");
    TEST_ASSERT(pool.resident_count() == 0 && pool.dirty_count() == 0,
                "A new pool has no resident or dirty pages");
    TEST_ASSERT(pool.loading_count() == 0 && pool.flushing_count() == 0,
                "A new pool has no in-flight page operations");
    TEST_ASSERT(pool.get_clock_hand() == 0, "Clock hand starts at frame zero");
    TEST_ASSERT(!pool.find_frame_by_page_id(FIRST_DATA_PAGE_ID).has_value(),
                "Absent pages have no frame mapping");
    TEST_ASSERT(!pool.get_frame_descriptor(4).has_value(),
                "Invalid frame IDs return no descriptor");

    for (frame_id_t frame_id = 0; frame_id < 4; ++frame_id) {
        const auto descriptor = pool.get_frame_descriptor(frame_id);
        TEST_ASSERT(descriptor.has_value() && descriptor->frame_id == frame_id &&
                        descriptor->page_id == INVALID_PAGE_ID &&
                        descriptor->state == BufferFrameState::ABSENT && descriptor->pin_count == 0 &&
                        !descriptor->ref_bit && descriptor->dirty_generation == 0 &&
                        descriptor->flushing_generation == 0,
                    "Every frame starts with a clean ABSENT descriptor");
    }

    bool rejected_zero_frames = false;
    try {
        BufferPoolManager invalid_pool(BufferPoolConfig{0, 1, 1});
    } catch (const std::invalid_argument&) {
        rejected_zero_frames = true;
    }
    TEST_ASSERT(rejected_zero_frames, "Zero-sized buffer pools are rejected");

    bool rejected_oversized_pool = false;
    try {
        BufferPoolManager oversized_pool(
            BufferPoolConfig{BufferPoolManager::MAX_FRAME_COUNT + 1, 1, 1});
    } catch (const std::invalid_argument&) {
        rejected_oversized_pool = true;
    }
    TEST_ASSERT(rejected_oversized_pool, "Frame counts above the configured maximum are rejected");

    bool rejected_zero_load_limit = false;
    try {
        BufferPoolManager invalid_load_limit(BufferPoolConfig{4, 0, 2});
    } catch (const std::invalid_argument&) {
        rejected_zero_load_limit = true;
    }
    TEST_ASSERT(rejected_zero_load_limit, "Zero pending-load limits are rejected");

    bool rejected_oversized_flush_limit = false;
    try {
        BufferPoolManager invalid_flush_limit(BufferPoolConfig{4, 2, 5});
    } catch (const std::invalid_argument&) {
        rejected_oversized_flush_limit = true;
    }
    TEST_ASSERT(rejected_oversized_flush_limit,
                "Flush batches larger than the frame budget are rejected");

    frame_id_t resident_frame = 0;
    TEST_ASSERT(pool.load_page(FIRST_DATA_PAGE_ID, resident_frame) == StorageResult::SUCCESS,
                "The synchronous test backend assigns an ABSENT frame as RESIDENT");
    TEST_ASSERT(pool.is_page_resident(FIRST_DATA_PAGE_ID) && pool.resident_count() == 1 &&
                    pool.free_frame_count() == 3,
                "A loaded page is mapped and removed from the free list");
    frame_id_t duplicate_frame = 0;
    TEST_ASSERT(pool.load_page(FIRST_DATA_PAGE_ID, duplicate_frame) == StorageResult::INVALID_ARGUMENT,
                "A page cannot be assigned to a second frame");
    TEST_ASSERT(pool.find_frame_by_page_id(FIRST_DATA_PAGE_ID).value() == resident_frame,
                "Duplicate assignment preserves the original page mapping");

    frame_id_t loading_frame = 0;
    TEST_ASSERT(pool.begin_page_load(FIRST_DATA_PAGE_ID + 1, loading_frame) == StorageResult::SUCCESS,
                "An ABSENT frame can enter LOADING");
    TEST_ASSERT(pool.is_page_loading(FIRST_DATA_PAGE_ID + 1) && pool.loading_count() == 1,
                "LOADING pages are visible to inspection methods");
    frame_id_t joined_frame = 0;
    TEST_ASSERT(pool.begin_page_load(FIRST_DATA_PAGE_ID + 1, joined_frame) == StorageResult::LOAD_IN_PROGRESS,
                "A duplicate load joins the existing page load");
    TEST_ASSERT(pool.complete_page_load(FIRST_DATA_PAGE_ID + 1) == StorageResult::SUCCESS,
                "A synchronous page supply transitions LOADING to RESIDENT");
    TEST_ASSERT(pool.is_page_resident(FIRST_DATA_PAGE_ID + 1) && pool.loading_count() == 0,
                "Completed loads leave no LOADING frame behind");

    TEST_ASSERT(pool.mark_page_dirty(FIRST_DATA_PAGE_ID) == StorageResult::SUCCESS,
                "A resident page can transition to DIRTY");
    auto dirty_descriptor = pool.get_frame_descriptor(resident_frame);
    TEST_ASSERT(dirty_descriptor.has_value() && dirty_descriptor->state == BufferFrameState::DIRTY &&
                    dirty_descriptor->dirty_generation == 1 && pool.dirty_count() == 1,
                "Dirty transitions initialize the mutation generation");
    TEST_ASSERT(pool.begin_page_flush(FIRST_DATA_PAGE_ID) == StorageResult::SUCCESS,
                "An unpinned DIRTY page can enter FLUSHING");
    TEST_ASSERT(pool.flushing_count() == 1 && pool.dirty_count() == 0,
                "FLUSHING pages leave the DIRTY count while the snapshot is active");
    TEST_ASSERT(pool.complete_page_flush(FIRST_DATA_PAGE_ID, true) == StorageResult::SUCCESS,
                "A successful flush returns a page to RESIDENT");
    TEST_ASSERT(pool.is_page_resident(FIRST_DATA_PAGE_ID) && pool.flushing_count() == 0,
                "Successful flush completion clears FLUSHING state");

    TEST_ASSERT(pool.mark_page_dirty(FIRST_DATA_PAGE_ID + 1) == StorageResult::SUCCESS &&
                    pool.begin_page_flush(FIRST_DATA_PAGE_ID + 1) == StorageResult::SUCCESS &&
                    pool.complete_page_flush(FIRST_DATA_PAGE_ID + 1, false) == StorageResult::SUCCESS,
                "A failed flush returns the page to DIRTY");
    auto failed_descriptor = pool.get_frame_descriptor(loading_frame);
    TEST_ASSERT(failed_descriptor.has_value() && failed_descriptor->state == BufferFrameState::DIRTY &&
                    pool.dirty_count() == 1,
                "Failed flushes preserve dirty in-memory state");

    TEST_ASSERT(pool.release_page(FIRST_DATA_PAGE_ID) == StorageResult::SUCCESS,
                "A clean unpinned page can be released");
    TEST_ASSERT(!pool.find_frame_by_page_id(FIRST_DATA_PAGE_ID).has_value() &&
                    pool.free_frame_count() == 3,
                "Released pages return their frame to the free list");
    TEST_ASSERT(pool.release_page(FIRST_DATA_PAGE_ID + 1) == StorageResult::INVALID_ARGUMENT,
                "Dirty pages cannot be released without a flush");

    std::cout << "[PASSED] buffer pool frame table tests" << std::endl;
}

} // namespace webdb::test