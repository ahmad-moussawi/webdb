#pragma once

#include "storage/operation_scheduler.hpp"

#include <new>
#include <unordered_map>
#include <vector>

namespace webdb::test {

// Test-only host store. Unlike the scheduler's resident cache, this map represents bytes that
// survived a restart. Every API copies page data so test callers cannot mutate durable storage.
class InMemoryAsyncPageStore {
   public:
    explicit InMemoryAsyncPageStore(std::unordered_map<page_id_t, std::vector<uint8_t>> durable_pages = {})
        : durable_pages_(std::move(durable_pages)) {}

    StorageResult read_pages(const std::vector<page_id_t>& page_ids, std::vector<PageData>& out_pages) const noexcept {
        try {
            std::vector<PageData> pages;
            pages.reserve(page_ids.size());
            for (const page_id_t page_id : page_ids) {
                const auto page_it = durable_pages_.find(page_id);
                if (page_id < FIRST_DATA_PAGE_ID || page_it == durable_pages_.end()) {
                    return StorageResult::IO_ERROR;
                }
                pages.push_back(PageData{page_id, page_it->second});
            }
            out_pages = std::move(pages);
            return StorageResult::SUCCESS;
        } catch (const std::bad_alloc&) {
            return StorageResult::IO_ERROR;
        }
    }

    StorageResult write_pages(const std::vector<PageData>& pages) noexcept {
        if (fail_writes || pages.empty()) return StorageResult::IO_ERROR;

        try {
            auto candidate = durable_pages_;
            for (const PageData& page : pages) {
                if (page.page_id < FIRST_DATA_PAGE_ID || page.bytes.size() != DATABASE_PAGE_SIZE) {
                    return StorageResult::INVALID_ARGUMENT;
                }
                candidate[page.page_id] = page.bytes;
            }
            durable_pages_ = std::move(candidate);
            return StorageResult::SUCCESS;
        } catch (const std::bad_alloc&) {
            return StorageResult::IO_ERROR;
        }
    }

    // Returns an independent durable snapshot for constructing a fresh store after a restart.
    std::unordered_map<page_id_t, std::vector<uint8_t>> durable_snapshot() const { return durable_pages_; }

    bool fail_writes{false};

   private:
    std::unordered_map<page_id_t, std::vector<uint8_t>> durable_pages_;
};

} // namespace webdb::test
