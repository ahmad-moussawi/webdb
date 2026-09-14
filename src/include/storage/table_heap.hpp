#pragma once

#include "common/types.hpp"
#include "storage/page_accessor.hpp"
#include "storage/master_page.hpp"
#include "storage/slotted_page.hpp"
#include "storage/tuple.hpp"

#include <vector>
#include <unordered_set>

namespace webdb {

enum class IteratorStatus : uint8_t {
    AT_RECORD = 0,
    END_OF_SCAN,
    CORRUPTED_PAGE,
    CYCLE_DETECTED,
    PAGE_NOT_FOUND,
};

class TableHeap;

class TableIterator {
public:
    TableIterator() = default;
    TableIterator(TableHeap* heap, page_id_t start_page_id, uint16_t start_slot);

    IteratorStatus status() const noexcept { return status_; }
    bool is_end() const noexcept { return status_ == IteratorStatus::END_OF_SCAN; }
    bool is_valid() const noexcept { return status_ == IteratorStatus::AT_RECORD; }

    RID get_current_rid() const noexcept { return current_rid_; }
    StorageResult get_current_tuple(Tuple& out_tuple) const noexcept;

    // Advances iterator to the next LIVE tuple in the chain
    void advance() noexcept;

private:
    TableHeap* heap_{nullptr};
    RID current_rid_{};
    IteratorStatus status_{IteratorStatus::END_OF_SCAN};
    std::unordered_set<page_id_t> visited_pages_{};
    page_id_t prev_page_id_{INVALID_PAGE_ID};

    void locate_next_live_tuple() noexcept;
};

class TableHeap {
public:
    /**
     * @brief Creates a TableHeap over an IPageAccessor and coordinates allocation via pending_master.
     */
    static StorageResult create(IPageAccessor& accessor,
                                MasterData& pending_master,
                                TableHeap& out_heap) noexcept;

    /**
     * @brief Reopens an existing TableHeap, validating chain links and reconstructing last_page_id.
     */
    static StorageResult open(IPageAccessor& accessor,
                              MasterData& pending_master,
                              page_id_t first_page_id,
                              TableHeap& out_heap) noexcept;

    TableHeap() = default;
    TableHeap(IPageAccessor* accessor, MasterData* master_ptr, page_id_t first_page_id, page_id_t last_page_id)
        : accessor_(accessor), master_ptr_(master_ptr), first_page_id_(first_page_id), last_page_id_(last_page_id) {}

    page_id_t get_first_page_id() const noexcept { return first_page_id_; }
    page_id_t get_last_page_id() const noexcept { return last_page_id_; }
    IPageAccessor* get_accessor() const noexcept { return accessor_; }
    const MasterData* get_master() const noexcept { return master_ptr_; }

    StorageResult insert_tuple(const Tuple& tuple, RID& out_rid) noexcept;
    StorageResult get_tuple(const RID& rid, Tuple& out_tuple) const noexcept;
    UpdateResult update_tuple(const RID& rid, const Tuple& new_tuple) noexcept;
    StorageResult delete_tuple(const RID& rid) noexcept;

    TableIterator begin() noexcept;
    TableIterator end() noexcept { return TableIterator(); }

private:
    IPageAccessor* accessor_{nullptr};
    MasterData* master_ptr_{nullptr};
    page_id_t first_page_id_{INVALID_PAGE_ID};
    page_id_t last_page_id_{INVALID_PAGE_ID};
};

} // namespace webdb
