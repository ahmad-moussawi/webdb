#include "test_support.hpp"

namespace webdb::test {

void test_operation_scheduler() {
    std::cout << "[RUNNING] operation scheduler lifecycle tests..." << std::endl;

    OperationScheduler scheduler;
    operation_id_t first_id = 0;
    TEST_ASSERT(scheduler.start_operation("{}", first_id) == StorageResult::SUCCESS,
                "A bounded operation plan creates an operation");
    TEST_ASSERT(first_id != 0, "Operation IDs never use zero");
    TEST_ASSERT(scheduler.step_operation(first_id) == SchedulerStatus::COMPLETE,
                "Step 1 scheduler completes an operation without page work");
    TEST_ASSERT(scheduler.get_execution_results(first_id) == "{}",
                "Completed operations retain their result until release");
    TEST_ASSERT(scheduler.release_operation(first_id) == StorageResult::SUCCESS,
                "Completed operations can be released");
    TEST_ASSERT(scheduler.step_operation(first_id) == SchedulerStatus::ERROR,
                "Released operations cannot be stepped");

    operation_id_t cancelled_id = 0;
    TEST_ASSERT(scheduler.start_operation("{}", cancelled_id) == StorageResult::SUCCESS,
                "A second operation creates successfully");
    scheduler.cancel_operation(cancelled_id);
    TEST_ASSERT(scheduler.step_operation(cancelled_id) == SchedulerStatus::CANCELLED,
                "Cancellation prevents further execution");
    TEST_ASSERT(scheduler.release_operation(cancelled_id) == StorageResult::SUCCESS,
                "Cancelled operations can be released");

    operation_id_t active_id = 0;
    TEST_ASSERT(scheduler.start_operation("{}", active_id) == StorageResult::SUCCESS,
                "An active operation creates successfully");
    TEST_ASSERT(scheduler.release_operation(active_id) == StorageResult::INVALID_ARGUMENT,
                "Active operations cannot be released without cancellation");
    TEST_ASSERT(scheduler.get_pending_page_requests(active_id).empty(),
                "Step 1 operations have no page requests before the page-cache step");
    TEST_ASSERT(scheduler.get_dirty_pages_for_flush(active_id).empty(),
                "Step 1 operations have no dirty-page snapshots before the page-cache step");
    TEST_ASSERT(scheduler.provide_pages(active_id, {}) == StorageResult::INVALID_ARGUMENT,
                "Pages cannot be supplied outside a page fault");
    TEST_ASSERT(scheduler.finish_flush(active_id, true) == StorageResult::INVALID_ARGUMENT,
                "Flush completion is rejected outside flushing state");
    scheduler.cancel_operation(active_id);
    TEST_ASSERT(scheduler.release_operation(active_id) == StorageResult::SUCCESS,
                "Cancelled active operations release their memory");

    operation_id_t page_id = 0;
    TEST_ASSERT(scheduler.start_operation("{}", page_id) == StorageResult::SUCCESS,
                "A page-cache test operation creates successfully");
    TEST_ASSERT(scheduler.request_page(page_id, FIRST_DATA_PAGE_ID, true) == StorageResult::SUCCESS,
                "Ready operations can request an absent data page");
    TEST_ASSERT(scheduler.step_operation(page_id) == SchedulerStatus::PAGE_FAULT,
                "A requested page pauses the operation at a page fault");
    const auto requests = scheduler.get_pending_page_requests(page_id);
    TEST_ASSERT(requests.size() == 1 && requests.front().page_id == FIRST_DATA_PAGE_ID && requests.front().is_write,
                "The scheduler exposes the exact pending page request");

    PageData wrong_size{FIRST_DATA_PAGE_ID, std::vector<uint8_t>(PAGE_SIZE - 1, 0)};
    TEST_ASSERT(scheduler.provide_pages(page_id, {wrong_size}) == StorageResult::INVALID_ARGUMENT,
                "Wrong-sized pages cannot resume a page fault");
    PageData wrong_id{FIRST_DATA_PAGE_ID + 1, std::vector<uint8_t>(PAGE_SIZE, 0)};
    TEST_ASSERT(scheduler.provide_pages(page_id, {wrong_id}) == StorageResult::INVALID_ARGUMENT,
                "Unexpected page IDs cannot resume a page fault");
    TEST_ASSERT(scheduler.get_pending_page_requests(page_id).size() == 1,
                "Invalid supplied pages preserve the outstanding request");

    PageData supplied_page{FIRST_DATA_PAGE_ID, std::vector<uint8_t>(PAGE_SIZE, 0x3C)};
    TEST_ASSERT(scheduler.provide_pages(page_id, {supplied_page}) == StorageResult::SUCCESS,
                "The requested 4 KiB page resumes the operation");
    supplied_page.bytes[0] = 0x00;
    const auto resident_copy = scheduler.copy_resident_page(page_id, FIRST_DATA_PAGE_ID);
    TEST_ASSERT(resident_copy.size() == PAGE_SIZE && resident_copy[0] == 0x3C,
                "The scheduler owns a copy of supplied page bytes");
    TEST_ASSERT(scheduler.request_page(page_id, FIRST_DATA_PAGE_ID, false) == StorageResult::SUCCESS,
                "Requesting an already resident page does not create another fault");
    TEST_ASSERT(scheduler.step_operation(page_id) == SchedulerStatus::COMPLETE,
                "A resumed operation can make forward progress");
    TEST_ASSERT(scheduler.release_operation(page_id) == StorageResult::SUCCESS,
                "Completed page-cache operations release successfully");

    operation_id_t fault_cancel_id = 0;
    TEST_ASSERT(scheduler.start_operation("{}", fault_cancel_id) == StorageResult::SUCCESS,
                "A fault-cancellation test operation creates successfully");
    TEST_ASSERT(scheduler.request_page(fault_cancel_id, FIRST_DATA_PAGE_ID, false) == StorageResult::SUCCESS,
                "The operation enters a page fault before cancellation");
    scheduler.cancel_operation(fault_cancel_id);
    TEST_ASSERT(scheduler.provide_pages(fault_cancel_id, {supplied_page}) == StorageResult::INVALID_ARGUMENT,
                "Cancelled operations reject late page responses");
    TEST_ASSERT(scheduler.release_operation(fault_cancel_id) == StorageResult::SUCCESS,
                "Cancelled page-fault operations release successfully");

    operation_id_t invalid_plan_id = 0;
    const std::string oversized_plan(MAX_OPERATION_PLAN_SIZE + 1, 'x');
    TEST_ASSERT(scheduler.start_operation(oversized_plan, invalid_plan_id) == StorageResult::INVALID_ARGUMENT,
                "Plans above the configured limit are rejected");

    std::vector<operation_id_t> operation_ids;
    operation_ids.reserve(MAX_SCHEDULER_OPERATIONS);
    for (size_t index = 0; index < MAX_SCHEDULER_OPERATIONS; ++index) {
        operation_id_t operation_id = 0;
        TEST_ASSERT(scheduler.start_operation("{}", operation_id) == StorageResult::SUCCESS,
                    "Operation creation succeeds up to the configured limit");
        operation_ids.push_back(operation_id);
    }
    operation_id_t overflow_id = 0;
    TEST_ASSERT(scheduler.start_operation("{}", overflow_id) == StorageResult::INVALID_ARGUMENT,
                "Operation creation rejects requests above the configured limit");
    for (const operation_id_t operation_id : operation_ids) {
        scheduler.cancel_operation(operation_id);
        TEST_ASSERT(scheduler.release_operation(operation_id) == StorageResult::SUCCESS,
                    "Cancelled limit-test operations release successfully");
    }

    std::cout << "[PASSED] operation scheduler lifecycle tests" << std::endl;
}

} // namespace webdb::test
