#include "storage/operation_scheduler.hpp"

#include <algorithm>
#include <charconv>
#include <limits>
#include <new>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace webdb {

namespace {

class JsonCursor {
   public:
    explicit JsonCursor(std::string_view input) : input_(input) {}

    void skip_whitespace() noexcept {
        while (position_ < input_.size() && (input_[position_] == ' ' || input_[position_] == '\n' ||
                                             input_[position_] == '\r' || input_[position_] == '\t')) {
            ++position_;
        }
    }

    bool consume(char expected) noexcept {
        skip_whitespace();
        if (position_ == input_.size() || input_[position_] != expected) return false;
        ++position_;
        return true;
    }

    bool string(std::string_view& output) noexcept {
        skip_whitespace();
        if (position_ == input_.size() || input_[position_++] != '"') return false;
        const size_t start = position_;
        while (position_ < input_.size() && input_[position_] != '"') {
            if (input_[position_] == '\\') return false;
            ++position_;
        }
        if (position_ == input_.size()) return false;
        output = input_.substr(start, position_ - start);
        ++position_;
        return true;
    }

    bool unsigned_integer(uint64_t& output) noexcept {
        skip_whitespace();
        const char* begin = input_.data() + position_;
        const char* end = input_.data() + input_.size();
        const auto [parsed_end, error] = std::from_chars(begin, end, output);
        if (error != std::errc{} || parsed_end == begin) return false;
        position_ = static_cast<size_t>(parsed_end - input_.data());
        return true;
    }

    bool at_end() noexcept {
        skip_whitespace();
        return position_ == input_.size();
    }

   private:
    std::string_view input_;
    size_t position_{0};
};

} // namespace

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
        Operation operation{};
        const auto parse_res = parse_test_operation(plan, operation.read_page_ids, operation.writes);
        if (parse_res != StorageResult::SUCCESS) {
            return parse_res;
        }

        const operation_id_t operation_id = next_operation_id_++;
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
        while (operation->next_read_index < operation->read_page_ids.size()) {
            const page_id_t page_id = operation->read_page_ids[operation->next_read_index];
            if (operation->resident_pages.find(page_id) == operation->resident_pages.end()) {
                const bool is_write = std::any_of(operation->writes.begin(), operation->writes.end(),
                                                  [page_id](const Operation::Write& write) {
                                                      return write.page_id == page_id;
                                                  });
                return request_page(operation_id, page_id, is_write) == StorageResult::SUCCESS
                           ? SchedulerStatus::PAGE_FAULT
                           : operation->status;
            }
            ++operation->next_read_index;
        }

        if (!operation->writes_applied) {
            for (const Operation::Write& write : operation->writes) {
                auto page_it = operation->resident_pages.find(write.page_id);
                if (page_it == operation->resident_pages.end()) {
                    operation->status = SchedulerStatus::ERROR;
                    operation->error = "A write references a missing resident page.";
                    return operation->status;
                }
                page_it->second[write.byte_offset] = write.value;
            }
            operation->writes_applied = true;

            if (!operation->writes.empty()) {
                try {
                    for (const Operation::Write& write : operation->writes) {
                        operation->dirty_pages.emplace(write.page_id, operation->resident_pages.at(write.page_id));
                    }
                } catch (const std::bad_alloc&) {
                    operation->status = SchedulerStatus::ERROR;
                    operation->error = "Insufficient memory to snapshot dirty pages.";
                    return operation->status;
                }
                operation->status = SchedulerStatus::FLUSHING;
                return operation->status;
            }
        }

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

std::vector<page_id_t> OperationScheduler::get_pending_page_ids(operation_id_t operation_id) const noexcept {
    const auto requests = get_pending_page_requests(operation_id);
    if (requests.empty()) {
        return {};
    }
    return {requests.front().page_id};
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
    if (page.page_id != request.page_id || page.bytes.size() != DATABASE_PAGE_SIZE) {
        return StorageResult::INVALID_ARGUMENT;
    }

    try {
        auto [it, inserted] = operation->resident_pages.emplace(page.page_id, page.bytes);
        if (!inserted) {
            return StorageResult::INVALID_ARGUMENT;
        }
        operation->pending_page_request.reset();
        ++operation->next_read_index;
        operation->status = SchedulerStatus::READY;
        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        operation->status = SchedulerStatus::ERROR;
        operation->error = "Insufficient memory to copy the supplied page.";
        return StorageResult::IO_ERROR;
    }
}

StorageResult OperationScheduler::provide_page(operation_id_t operation_id,
                                               page_id_t page_id,
                                               const std::vector<uint8_t>& bytes) noexcept {
    try {
        std::vector<PageData> pages;
        pages.push_back(PageData{page_id, bytes});
        return provide_pages(operation_id, pages);
    } catch (const std::bad_alloc&) {
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

std::vector<PageData> OperationScheduler::get_dirty_pages_for_flush(operation_id_t operation_id) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::FLUSHING) {
        return {};
    }
    std::vector<PageData> pages;
    try {
        pages.reserve(operation->dirty_pages.size());
        for (const auto& [page_id, bytes] : operation->dirty_pages) {
            pages.push_back(PageData{page_id, bytes});
        }
    } catch (const std::bad_alloc&) {
        operation->status = SchedulerStatus::ERROR;
        try {
            operation->error = "Insufficient memory to copy dirty-page snapshots.";
        } catch (const std::bad_alloc&) {
            operation->error.clear();
        }
        return {};
    }
    return pages;
}

std::vector<page_id_t> OperationScheduler::get_dirty_page_ids(operation_id_t operation_id) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::FLUSHING) {
        return {};
    }

    std::vector<page_id_t> page_ids;
    try {
        page_ids.reserve(operation->dirty_pages.size());
        for (const auto& [page_id, bytes] : operation->dirty_pages) {
            (void)bytes;
            page_ids.push_back(page_id);
        }
    } catch (const std::bad_alloc&) {
        operation->status = SchedulerStatus::ERROR;
        try {
            operation->error = "Insufficient memory to copy dirty-page IDs.";
        } catch (const std::bad_alloc&) {
            operation->error.clear();
        }
        return {};
    }
    return page_ids;
}

std::vector<uint8_t> OperationScheduler::copy_dirty_page(operation_id_t operation_id, page_id_t page_id) const {
    const Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::FLUSHING) {
        return {};
    }
    const auto page_it = operation->dirty_pages.find(page_id);
    return page_it == operation->dirty_pages.end() ? std::vector<uint8_t>{} : page_it->second;
}

StorageResult OperationScheduler::finish_flush(operation_id_t operation_id, bool success) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation || operation->status != SchedulerStatus::FLUSHING) {
        return StorageResult::INVALID_ARGUMENT;
    }

    if (success) {
        operation->dirty_pages.clear();
        operation->status = SchedulerStatus::READY;
    } else {
        operation->status = SchedulerStatus::ERROR;
        operation->error = "The host failed to flush dirty pages.";
    }
    return StorageResult::SUCCESS;
}

StorageResult OperationScheduler::fail_operation(operation_id_t operation_id, std::string_view message) noexcept {
    Operation* operation = find_operation(operation_id);
    if (!operation || operation->status == SchedulerStatus::COMPLETE ||
        operation->status == SchedulerStatus::CANCELLED || operation->status == SchedulerStatus::ERROR) {
        return StorageResult::INVALID_ARGUMENT;
    }

    try {
        operation->error = message;
        operation->status = SchedulerStatus::ERROR;
        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        operation->status = SchedulerStatus::ERROR;
        operation->error.clear();
        return StorageResult::IO_ERROR;
    }
}

StorageResult OperationScheduler::parse_test_operation(std::string_view plan,
                                                       std::vector<page_id_t>& out_read_page_ids,
                                                       std::vector<Operation::Write>& out_writes) {
    JsonCursor cursor(plan);
    std::unordered_set<page_id_t> read_page_ids;
    bool saw_version = false;
    bool saw_reads = false;
    bool saw_writes = false;

    if (!cursor.consume('{')) return StorageResult::INVALID_ARGUMENT;
    if (cursor.consume('}')) return StorageResult::INVALID_ARGUMENT;
    while (true) {
        std::string_view key;
        if (!cursor.string(key) || !cursor.consume(':')) return StorageResult::INVALID_ARGUMENT;

        if (key == "version") {
            uint64_t version = 0;
            if (saw_version || !cursor.unsigned_integer(version) || version != 1) return StorageResult::INVALID_ARGUMENT;
            saw_version = true;
        } else if (key == "reads") {
            if (saw_reads || !cursor.consume('[')) return StorageResult::INVALID_ARGUMENT;
            saw_reads = true;
            if (!cursor.consume(']')) {
                do {
                    uint64_t page_id = 0;
                    if (!cursor.unsigned_integer(page_id) || page_id < FIRST_DATA_PAGE_ID ||
                        page_id > static_cast<uint64_t>(std::numeric_limits<page_id_t>::max()) ||
                        !read_page_ids.insert(static_cast<page_id_t>(page_id)).second ||
                        out_read_page_ids.size() >= MAX_PENDING_PAGE_REQUESTS) {
                        return StorageResult::INVALID_ARGUMENT;
                    }
                    out_read_page_ids.push_back(static_cast<page_id_t>(page_id));
                } while (cursor.consume(','));
                if (!cursor.consume(']')) return StorageResult::INVALID_ARGUMENT;
            }
        } else if (key == "writes") {
            if (saw_writes || !cursor.consume('[')) return StorageResult::INVALID_ARGUMENT;
            saw_writes = true;
            if (!cursor.consume(']')) {
                do {
                    if (!cursor.consume('{')) return StorageResult::INVALID_ARGUMENT;
                    Operation::Write write{};
                    bool saw_page_id = false;
                    bool saw_offset = false;
                    bool saw_value = false;
                    while (true) {
                        std::string_view write_key;
                        uint64_t number = 0;
                        if (!cursor.string(write_key) || !cursor.consume(':') || !cursor.unsigned_integer(number)) {
                            return StorageResult::INVALID_ARGUMENT;
                        }
                        if (write_key == "page_id" && !saw_page_id && number >= FIRST_DATA_PAGE_ID &&
                            number <= static_cast<uint64_t>(std::numeric_limits<page_id_t>::max())) {
                            write.page_id = static_cast<page_id_t>(number);
                            saw_page_id = true;
                        } else if (write_key == "byte_offset" && !saw_offset && number < DATABASE_PAGE_SIZE) {
                            write.byte_offset = static_cast<size_t>(number);
                            saw_offset = true;
                        } else if (write_key == "value" && !saw_value && number <= UINT8_MAX) {
                            write.value = static_cast<uint8_t>(number);
                            saw_value = true;
                        } else {
                            return StorageResult::INVALID_ARGUMENT;
                        }
                        if (cursor.consume('}')) break;
                        if (!cursor.consume(',')) return StorageResult::INVALID_ARGUMENT;
                    }
                    if (!saw_page_id || !saw_offset || !saw_value ||
                        out_writes.size() >= MAX_DIRTY_PAGES_PER_OPERATION) {
                        return StorageResult::INVALID_ARGUMENT;
                    }
                    out_writes.push_back(write);
                } while (cursor.consume(','));
                if (!cursor.consume(']')) return StorageResult::INVALID_ARGUMENT;
            }
        } else {
            return StorageResult::INVALID_ARGUMENT;
        }

        if (!cursor.consume(',')) {
            if (!cursor.consume('}')) return StorageResult::INVALID_ARGUMENT;
            break;
        }
    }
    if (!saw_version || !saw_reads || !cursor.at_end()) {
        return StorageResult::INVALID_ARGUMENT;
    }
    for (const Operation::Write& write : out_writes) {
        if (read_page_ids.find(write.page_id) == read_page_ids.end()) {
            return StorageResult::INVALID_ARGUMENT;
        }
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
