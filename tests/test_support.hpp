#pragma once

#include "common/types.hpp"
#include "common/checksum.hpp"
#include "common/endian.hpp"
#include "storage/page_accessor.hpp"
#include "storage/master_page.hpp"
#include "storage/operation_scheduler.hpp"
#include "storage/slotted_page.hpp"
#include "storage/tuple.hpp"
#include "storage/value.hpp"
#include "storage/table_heap.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace webdb::test {

class InMemoryPageAccessor final : public IPageAccessor {
public:
    enum class EventType { FLUSH, SYNC };

    struct Event {
        EventType type;
        page_id_t page_id{INVALID_PAGE_ID};
    };

    StorageResult fetch_page(page_id_t page_id, uint8_t** out_page) noexcept override {
        auto it = pages_.find(page_id);
        if (it == pages_.end()) return StorageResult::IO_ERROR;
        *out_page = it->second.data();
        return StorageResult::SUCCESS;
    }

    StorageResult allocate_page(page_id_t expected_page_id, uint8_t** out_page) noexcept override {
        if (!out_page || pages_.find(expected_page_id) != pages_.end()) return StorageResult::INVALID_ARGUMENT;
        try {
            auto [it, inserted] = pages_.try_emplace(expected_page_id, PAGE_SIZE, 0);
            if (!inserted) return StorageResult::INVALID_ARGUMENT;
            *out_page = it->second.data();
            return StorageResult::SUCCESS;
        } catch (const std::bad_alloc&) {
            return StorageResult::IO_ERROR;
        }
    }

    StorageResult discard_page(page_id_t page_id) noexcept override {
        if (pages_.erase(page_id) == 0) return StorageResult::IO_ERROR;
        dirty_pages_.erase(page_id);
        return StorageResult::SUCCESS;
    }

    StorageResult mark_dirty(page_id_t page_id) noexcept override {
        if (fail_mark_dirty || page_id == fail_mark_dirty_page) return StorageResult::IO_ERROR;
        if (pages_.find(page_id) == pages_.end()) return StorageResult::IO_ERROR;
        try {
            dirty_pages_.insert(page_id);
            return StorageResult::SUCCESS;
        } catch (const std::bad_alloc&) {
            return StorageResult::IO_ERROR;
        }
    }

    StorageResult flush_page(page_id_t page_id) noexcept override {
        if (fail_flush || pages_.find(page_id) == pages_.end()) return StorageResult::IO_ERROR;
        try {
            dirty_pages_.erase(page_id);
            flush_history.push_back(page_id);
            events.push_back(Event{EventType::FLUSH, page_id});
            return StorageResult::SUCCESS;
        } catch (const std::bad_alloc&) {
            return StorageResult::IO_ERROR;
        }
    }

    StorageResult flush_dirty_pages() noexcept override {
        if (fail_flush) return StorageResult::IO_ERROR;
        try {
            const auto to_flush = dirty_pages_;
            for (const page_id_t page_id : to_flush) {
                const auto result = flush_page(page_id);
                if (result != StorageResult::SUCCESS) return result;
            }
            return StorageResult::SUCCESS;
        } catch (const std::bad_alloc&) {
            return StorageResult::IO_ERROR;
        }
    }

    StorageResult sync() noexcept override {
        if (fail_sync) return StorageResult::IO_ERROR;
        try {
            ++sync_call_count;
            events.push_back(Event{EventType::SYNC, INVALID_PAGE_ID});
            return StorageResult::SUCCESS;
        } catch (const std::bad_alloc&) {
            return StorageResult::IO_ERROR;
        }
    }

    bool fail_flush{false};
    bool fail_sync{false};
    bool fail_mark_dirty{false};
    page_id_t fail_mark_dirty_page{INVALID_PAGE_ID};
    size_t sync_call_count{0};
    std::vector<page_id_t> flush_history;
    std::vector<Event> events;

    size_t dirty_count() const noexcept { return dirty_pages_.size(); }
    bool has_page(page_id_t page_id) const { return pages_.find(page_id) != pages_.end(); }
    uint8_t* raw_buffer(page_id_t page_id) { return pages_.at(page_id).data(); }

private:
    std::unordered_map<page_id_t, std::vector<uint8_t>> pages_;
    std::unordered_set<page_id_t> dirty_pages_;
};

#define TEST_ASSERT(condition, message) \
    do { \
        if (!(condition)) { \
            std::cerr << "FAILED: " << message << " at " << __FILE__ << ":" << __LINE__ << std::endl; \
            std::exit(1); \
        } \
    } while (0)

} // namespace webdb::test
