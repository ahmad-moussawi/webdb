#include "test_async_page_store.hpp"
#include "test_support.hpp"

namespace webdb::test {

void test_async_page_store() {
    std::cout << "[RUNNING] in-memory async page-store durability tests..." << std::endl;

    InMemoryAsyncPageStore store({{2, std::vector<uint8_t>(PAGE_SIZE, 0x11)},
                                  {3, std::vector<uint8_t>(PAGE_SIZE, 0x22)}});

    std::vector<PageData> read_pages;
    TEST_ASSERT(store.read_pages({2, 3}, read_pages) == StorageResult::SUCCESS,
                "Durable pages can be read as a batch");
    TEST_ASSERT(read_pages.size() == 2 && read_pages[0].bytes[0] == 0x11 && read_pages[1].bytes[0] == 0x22,
                "Batch reads preserve durable page values");
    read_pages[0].bytes[0] = 0x00;
    TEST_ASSERT(store.read_pages({2}, read_pages) == StorageResult::SUCCESS && read_pages[0].bytes[0] == 0x11,
                "Read callers cannot mutate the durable image by aliasing");

    const std::vector<PageData> valid_batch = {{2, std::vector<uint8_t>(PAGE_SIZE, 0x33)},
                                               {3, std::vector<uint8_t>(PAGE_SIZE, 0x44)}};
    TEST_ASSERT(store.write_pages(valid_batch) == StorageResult::SUCCESS,
                "A valid page batch replaces durable values");
    TEST_ASSERT(store.read_pages({2, 3}, read_pages) == StorageResult::SUCCESS &&
                    read_pages[0].bytes[0] == 0x33 && read_pages[1].bytes[0] == 0x44,
                "A successful batch persists every supplied page");

    const auto before_rejected_write = store.durable_snapshot();
    TEST_ASSERT(store.write_pages({PageData{2, std::vector<uint8_t>(PAGE_SIZE, 0x55)},
                                   PageData{3, std::vector<uint8_t>(PAGE_SIZE - 1, 0x66)}}) ==
                    StorageResult::INVALID_ARGUMENT,
                "Invalid pages reject the complete write batch");
    TEST_ASSERT(store.durable_snapshot() == before_rejected_write,
                "A rejected batch leaves every durable page unchanged");

    store.fail_writes = true;
    TEST_ASSERT(store.write_pages({PageData{2, std::vector<uint8_t>(PAGE_SIZE, 0x77)}}) == StorageResult::IO_ERROR,
                "Injected host write failures are reported");
    TEST_ASSERT(store.durable_snapshot() == before_rejected_write,
                "A failed host write leaves the durable image unchanged");
    store.fail_writes = false;

    InMemoryAsyncPageStore restarted_store(store.durable_snapshot());
    TEST_ASSERT(restarted_store.read_pages({2, 3}, read_pages) == StorageResult::SUCCESS &&
                    read_pages[0].bytes[0] == 0x33 && read_pages[1].bytes[0] == 0x44,
                "A fresh store instance sees only the durable image");

    OperationScheduler scheduler;
    operation_id_t operation_id = 0;
    constexpr std::string_view plan =
        R"({"version":1,"reads":[2],"writes":[{"page_id":2,"byte_offset":7,"value":99}]})";
    TEST_ASSERT(scheduler.start_operation(plan, operation_id) == StorageResult::SUCCESS,
                "A scheduler operation for host-store integration starts");
    TEST_ASSERT(scheduler.step_operation(operation_id) == SchedulerStatus::PAGE_FAULT,
                "The integration operation requests its input page");
    TEST_ASSERT(store.read_pages({2}, read_pages) == StorageResult::SUCCESS,
                "The host store provides the requested durable page");
    TEST_ASSERT(scheduler.provide_pages(operation_id, read_pages) == StorageResult::SUCCESS,
                "The scheduler accepts the host page copy");
    TEST_ASSERT(scheduler.step_operation(operation_id) == SchedulerStatus::FLUSHING,
                "The write operation produces a dirty-page flush batch");
    TEST_ASSERT(store.write_pages(scheduler.get_dirty_pages_for_flush(operation_id)) == StorageResult::SUCCESS,
                "The host durably writes the scheduler dirty snapshot");
    TEST_ASSERT(scheduler.finish_flush(operation_id, true) == StorageResult::SUCCESS &&
                    scheduler.step_operation(operation_id) == SchedulerStatus::COMPLETE,
                "The scheduler completes after durable host acknowledgement");
    TEST_ASSERT(restarted_store.read_pages({2}, read_pages) == StorageResult::SUCCESS,
                "The earlier restart snapshot remains independent from later writes");
    InMemoryAsyncPageStore committed_store(store.durable_snapshot());
    TEST_ASSERT(committed_store.read_pages({2}, read_pages) == StorageResult::SUCCESS && read_pages[0].bytes[7] == 99,
                "A post-flush restart observes the scheduler mutation");
    TEST_ASSERT(scheduler.release_operation(operation_id) == StorageResult::SUCCESS,
                "The integration operation releases after completion");

    std::cout << "[PASSED] in-memory async page-store durability tests" << std::endl;
}

} // namespace webdb::test
