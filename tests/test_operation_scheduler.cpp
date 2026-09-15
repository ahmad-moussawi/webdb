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
