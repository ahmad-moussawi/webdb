#include "storage/operation_scheduler.hpp"

#include <new>
#include <unordered_map>
#include <utility>

namespace webdb {

OperationScheduler::Operation* OperationScheduler::find_operation(operation_id_t operation_id) noexcept {
    auto it = operations_.find(operation_id);
    return it == operations_.end() ? nullptr : &it->second;
}

const OperationScheduler::Operation* OperationScheduler::find_operation(operation_id_t operation_id) const noexcept {
    auto it = operations_.find(operation_id);
    return it == operations_.end() ? nullptr : &it->second;
}

StorageResult OperationScheduler::start_operation(std::string_view plan, operation_id_t& out_operation_id) noexcept {
    if (plan.size() > MAX_OPERATION_PLAN_SIZE || operations_.size() >= MAX_SCHEDULER_OPERATIONS ||
        next_operation_id_ == 0) {
        return StorageResult::INVALID_ARGUMENT;
    }

    try {
        // Copy the plan into scheduler-owned memory before returning the operation ID to the caller.
        const operation_id_t operation_id = next_operation_id_++;
        Operation operation{};
        operation.plan = plan;
        auto [it, inserted] = operations_.emplace(operation_id, std::move(operation));
        if (!inserted) {
            return StorageResult::IO_ERROR;
        }
        out_operation_id = it->first;
        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        return StorageResult::IO_ERROR;
    }
}

SchedulerStatus OperationScheduler::step_operation(operation_id_t operation_id) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation) {
        return SchedulerStatus::ERROR;
    }

    if (operation->status == SchedulerStatus::READY) {
        // Step 1 establishes lifecycle semantics only. Page faults and mutations arrive with the
        // resident-page cache in the next step, so this placeholder operation completes directly.
        operation->result = "{}";
        operation->status = SchedulerStatus::COMPLETE;
    }
    return operation->status;
}

StorageResult OperationScheduler::request_page(operation_id_t operation_id,
                                                page_id_t page_id,
                                                bool is_write) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::READY || page_id < FIRST_DATA_PAGE_ID) {
        return StorageResult::INVALID_ARGUMENT;
    }
    if (operation->resident_pages.find(page_id) != operation->resident_pages.end()) {
        return StorageResult::SUCCESS;
    }
    if (operation->resident_pages.size() >= MAX_RESIDENT_PAGES_PER_OPERATION) {
        operation->status = SchedulerStatus::ERROR;
        operation->error = "The resident-page limit was reached.";
        return StorageResult::IO_ERROR;
    }

    // Phase 2 intentionally permits one outstanding fault. Later phases may batch requests.
    operation->pending_page_request = PageRequest{page_id, is_write};
    operation->status = SchedulerStatus::PAGE_FAULT;
    return StorageResult::SUCCESS;
}

std::vector<PageRequest> OperationScheduler::get_pending_page_requests(operation_id_t operation_id) const noexcept {
    const Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::PAGE_FAULT) {
        return {};
    }
    return {*operation->pending_page_request};
}

StorageResult OperationScheduler::provide_pages(operation_id_t operation_id,
                                                const std::vector<PageData>& pages) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::PAGE_FAULT || pages.size() != 1 ||
        !operation->pending_page_request.has_value()) {
        return StorageResult::INVALID_ARGUMENT;
    }

    const PageData& page = pages.front();
    const PageRequest request = *operation->pending_page_request;
    if (page.page_id != request.page_id || page.bytes.size() != PAGE_SIZE) {
        return StorageResult::INVALID_ARGUMENT;
    }

    try {
        auto [it, inserted] = operation->resident_pages.emplace(page.page_id, page.bytes);
        if (!inserted) {
            return StorageResult::INVALID_ARGUMENT;
        }
        operation->pending_page_request.reset();
        operation->status = SchedulerStatus::READY;
        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        operation->status = SchedulerStatus::ERROR;
        operation->error = "Insufficient memory to copy the supplied page.";
        return StorageResult::IO_ERROR;
    }
}

std::vector<uint8_t> OperationScheduler::copy_resident_page(operation_id_t operation_id,
                                                             page_id_t page_id) const {
    const Operation* operation = find_operation(operation_id);
    if (!operation) {
        return {};
    }
    auto page_it = operation->resident_pages.find(page_id);
    return page_it == operation->resident_pages.end() ? std::vector<uint8_t>{} : page_it->second;
}

std::vector<PageData> OperationScheduler::get_dirty_pages_for_flush(operation_id_t operation_id) const noexcept {
    const Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::FLUSHING) {
        return {};
    }
    return {};
}

StorageResult OperationScheduler::finish_flush(operation_id_t operation_id, bool success) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::FLUSHING) {
        return StorageResult::INVALID_ARGUMENT;
    }

    operation->status = success ? SchedulerStatus::READY : SchedulerStatus::ERROR;
    if (!success) {
        operation->error = "The host failed to flush dirty pages.";
    }
    return StorageResult::SUCCESS;
}

void OperationScheduler::cancel_operation(operation_id_t operation_id) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation || operation->status == SchedulerStatus::COMPLETE ||
        operation->status == SchedulerStatus::CANCELLED || operation->status == SchedulerStatus::ERROR) {
        return;
    }

    operation->status = SchedulerStatus::CANCELLED;
    operation->error = "Operation cancelled.";
}

StorageResult OperationScheduler::release_operation(operation_id_t operation_id) noexcept {
    const Operation* operation = find_operation(operation_id);
    if (!operation || (operation->status != SchedulerStatus::COMPLETE &&
                       operation->status != SchedulerStatus::CANCELLED &&
                       operation->status != SchedulerStatus::ERROR)) {
        return StorageResult::INVALID_ARGUMENT;
    }

    // Explicit release makes result/error inspection possible without retaining operations forever.
    operations_.erase(operation_id);
    return StorageResult::SUCCESS;
}

std::string OperationScheduler::get_execution_results(operation_id_t operation_id) const {
    const Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::COMPLETE) {
        return {};
    }
    return operation->result;
}

std::string OperationScheduler::get_execution_error(operation_id_t operation_id) const {
    const Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::ERROR) {
        return {};
    }
    return operation->error;
}

} // namespace webdb
