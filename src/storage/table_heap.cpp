#include "storage/table_heap.hpp"

#include <limits>
#include <new>
#include <vector>

namespace webdb {

StorageResult TableHeap::fetch_validated_page(page_id_t page_id, uint8_t*& out_page) const noexcept {
    auto fetch_res = accessor_->fetch_page(page_id, &out_page);
    if (fetch_res != StorageResult::SUCCESS) {
        return fetch_res;
    }
    return TablePage::validate(out_page, page_id, master_ptr_->page_count);
}

UpdateResult TableHeap::relocate_tuple(const RID& old_rid, TablePage& old_page, const Tuple& new_tuple,
                                       const std::vector<uint8_t>& old_tuple, uint16_t old_offset,
                                       uint16_t old_size) noexcept {
    UpdateResult result{};
    result.old_rid = old_rid;
    result.new_rid = old_rid;

    const uint32_t page_count_before_insert = master_ptr_->page_count;
    RID new_rid{};
    auto insert_res = insert_tuple(new_tuple, new_rid);
    if (insert_res != StorageResult::SUCCESS) {
        result.status = insert_res;
        return result;
    }
    const bool allocated_new_page = master_ptr_->page_count > page_count_before_insert;

    auto rollback_new_tuple = [&]() noexcept {
        if (allocated_new_page) {
            --master_ptr_->page_count;
            (void)accessor_->discard_page(new_rid.page_id);
            return;
        }

        uint8_t* new_buf = nullptr;
        if (accessor_->fetch_page(new_rid.page_id, &new_buf) == StorageResult::SUCCESS) {
            TablePage new_page(new_buf);
            if (new_page.delete_tuple(new_rid.slot_num) == StorageResult::SUCCESS) {
                (void)accessor_->mark_dirty(new_rid.page_id);
            }
        }
    };

    auto delete_res = old_page.delete_tuple(old_rid.slot_num);
    if (delete_res != StorageResult::SUCCESS) {
        rollback_new_tuple();
        result.status = delete_res;
        return result;
    }
    auto mark_res = accessor_->mark_dirty(old_rid.page_id);
    if (mark_res != StorageResult::SUCCESS) {
        (void)old_page.restore_tuple(old_rid.slot_num, old_tuple.data(), old_size, old_offset);
        (void)accessor_->mark_dirty(old_rid.page_id);
        rollback_new_tuple();
        result.status = mark_res;
        return result;
    }

    result.status = StorageResult::SUCCESS;
    result.new_rid = new_rid;
    result.rid_changed = true;
    return result;
}

StorageResult TableHeap::create(IPageAccessor& accessor, MasterData& pending_master, TableHeap& out_heap) noexcept {
    if (pending_master.page_count < FIRST_DATA_PAGE_ID ||
        pending_master.page_count >= static_cast<uint32_t>(std::numeric_limits<page_id_t>::max())) {
        return StorageResult::CORRUPTED_PAGE;
    }
    const page_id_t new_page_id = static_cast<page_id_t>(pending_master.page_count);
    uint8_t* page_buf = nullptr;
    auto alloc_res = accessor.allocate_page(new_page_id, &page_buf);
    if (alloc_res != StorageResult::SUCCESS) {
        return alloc_res;
    }

    TablePage::init(page_buf, new_page_id, INVALID_PAGE_ID, INVALID_PAGE_ID);
    auto mark_res = accessor.mark_dirty(new_page_id);
    if (mark_res != StorageResult::SUCCESS) {
        (void)accessor.discard_page(new_page_id);
        return mark_res;
    }
    pending_master.page_count++;

    out_heap = TableHeap(&accessor, &pending_master, new_page_id, new_page_id);
    return StorageResult::SUCCESS;
}

StorageResult TableHeap::open(IPageAccessor& accessor, MasterData& pending_master, page_id_t first_page_id,
                              TableHeap& out_heap) noexcept {
    if (first_page_id < FIRST_DATA_PAGE_ID || static_cast<uint32_t>(first_page_id) >= pending_master.page_count) {
        return StorageResult::CORRUPTED_PAGE;
    }

    try {
        // Walk chain to validate links, protect against cycles, and reconstruct last_page_id
        std::unordered_set<page_id_t> visited;
        page_id_t curr = first_page_id;
        page_id_t prev = INVALID_PAGE_ID;

        while (curr != INVALID_PAGE_ID) {
            if (visited.find(curr) != visited.end() || visited.size() >= MAX_PAGES) {
                return StorageResult::CYCLE_DETECTED;
            }
            visited.insert(curr);

            uint8_t* buf = nullptr;
            auto fetch_res = accessor.fetch_page(curr, &buf);
            if (fetch_res != StorageResult::SUCCESS) {
                return fetch_res;
            }

            auto val_res = TablePage::validate(buf, curr, pending_master.page_count);
            if (val_res != StorageResult::SUCCESS) {
                return val_res;
            }

            TablePage page(buf);
            if (page.get_prev_page_id() != prev) {
                return StorageResult::CORRUPTED_PAGE;  // Broken backward link
            }

            prev = curr;
            curr = page.get_next_page_id();
        }

        out_heap = TableHeap(&accessor, &pending_master, first_page_id, prev);
        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        return StorageResult::IO_ERROR;
    }
}

StorageResult TableHeap::insert_tuple(const Tuple& tuple, RID& out_rid) noexcept {
    if (!accessor_ || !master_ptr_ || !tuple.data() || tuple.size() == 0) {
        return StorageResult::INVALID_ARGUMENT;
    }
    if (tuple.size() > MAX_TUPLE_SIZE) {
        return StorageResult::TUPLE_TOO_LARGE;
    }

    // 1. Try to insert into last_page_id
    uint8_t* last_buf = nullptr;
    auto last_page_res = fetch_validated_page(last_page_id_, last_buf);
    if (last_page_res != StorageResult::SUCCESS) {
        return last_page_res;
    }

    TablePage last_page(last_buf);
    uint16_t slot_num = 0;
    auto ins_res = last_page.insert_tuple(tuple.data(), tuple.size(), slot_num);

    if (ins_res == StorageResult::SUCCESS) {
        auto mark_res = accessor_->mark_dirty(last_page_id_);
        if (mark_res != StorageResult::SUCCESS) {
            return mark_res;
        }
        out_rid = RID{last_page_id_, slot_num};
        return StorageResult::SUCCESS;
    }

    if (ins_res != StorageResult::PAGE_FULL) {
        return ins_res;
    }

    // 2. Last page is full: allocate a new append-only page
    if (master_ptr_->page_count < FIRST_DATA_PAGE_ID ||
        master_ptr_->page_count >= static_cast<uint32_t>(std::numeric_limits<page_id_t>::max())) {
        return StorageResult::CORRUPTED_PAGE;
    }
    const page_id_t new_page_id = static_cast<page_id_t>(master_ptr_->page_count);
    uint8_t* new_buf = nullptr;
    auto alloc_res = accessor_->allocate_page(new_page_id, &new_buf);
    if (alloc_res != StorageResult::SUCCESS) {
        return alloc_res;
    }

    // Build the new page completely before publishing the forward link.
    TablePage::init(new_buf, new_page_id, last_page_id_, INVALID_PAGE_ID);
    TablePage new_page(new_buf);
    ins_res = new_page.insert_tuple(tuple.data(), tuple.size(), slot_num);
    if (ins_res != StorageResult::SUCCESS) {
        (void)accessor_->discard_page(new_page_id);
        return ins_res;
    }

    auto mark_new = accessor_->mark_dirty(new_page_id);
    if (mark_new != StorageResult::SUCCESS) {
        (void)accessor_->discard_page(new_page_id);
        return mark_new;
    }

    last_page.set_next_page_id(new_page_id);
    auto mark_old = accessor_->mark_dirty(last_page_id_);
    if (mark_old != StorageResult::SUCCESS) {
        last_page.set_next_page_id(INVALID_PAGE_ID);
        (void)accessor_->discard_page(new_page_id);
        return mark_old;
    }

    master_ptr_->page_count++;
    last_page_id_ = new_page_id;

    out_rid = RID{new_page_id, slot_num};
    return StorageResult::SUCCESS;
}

StorageResult TableHeap::get_tuple(const RID& rid, Tuple& out_tuple) const noexcept {
    if (!accessor_ || !master_ptr_ || !rid.is_valid()) {
        return StorageResult::INVALID_ARGUMENT;
    }

    uint8_t* buf = nullptr;
    auto page_res = fetch_validated_page(rid.page_id, buf);
    if (page_res != StorageResult::SUCCESS) {
        return page_res;
    }

    TablePage page(buf);
    const uint8_t* tuple_bytes = nullptr;
    size_t tuple_size = 0;

    auto get_res = page.get_tuple(rid.slot_num, &tuple_bytes, tuple_size);
    if (get_res != StorageResult::SUCCESS) {
        return get_res;
    }

    try {
        out_tuple = Tuple(std::vector<uint8_t>(tuple_bytes, tuple_bytes + tuple_size));
        return StorageResult::SUCCESS;
    } catch (const std::bad_alloc&) {
        return StorageResult::IO_ERROR;
    }
}

UpdateResult TableHeap::update_tuple(const RID& rid, const Tuple& new_tuple) noexcept {
    UpdateResult result{};
    result.old_rid = rid;
    result.new_rid = rid;
    result.rid_changed = false;

    if (!accessor_ || !master_ptr_ || !rid.is_valid() || !new_tuple.data() || new_tuple.size() == 0) {
        result.status = StorageResult::INVALID_ARGUMENT;
        return result;
    }
    if (new_tuple.size() > MAX_TUPLE_SIZE) {
        result.status = StorageResult::TUPLE_TOO_LARGE;
        return result;
    }

    uint8_t* buf = nullptr;
    auto page_res = fetch_validated_page(rid.page_id, buf);
    if (page_res != StorageResult::SUCCESS) {
        result.status = page_res;
        return result;
    }

    TablePage page(buf);
    const uint16_t old_offset = page.get_slot_offset(rid.slot_num);
    const uint16_t old_size = page.get_slot_length(rid.slot_num);
    const uint8_t* old_data = nullptr;
    size_t old_data_size = 0;
    auto old_get = page.get_tuple(rid.slot_num, &old_data, old_data_size);
    if (old_get != StorageResult::SUCCESS || old_data_size != old_size) {
        result.status = old_get == StorageResult::SUCCESS ? StorageResult::CORRUPTED_PAGE : old_get;
        return result;
    }
    std::vector<uint8_t> old_copy;
    try {
        old_copy.assign(old_data, old_data + old_data_size);
    } catch (const std::bad_alloc&) {
        result.status = StorageResult::IO_ERROR;
        return result;
    }
    auto page_update = page.update_tuple(rid.slot_num, new_tuple.data(), new_tuple.size());
    if (page_update.status == StorageResult::SUCCESS) {
        auto mark_res = accessor_->mark_dirty(rid.page_id);
        if (mark_res != StorageResult::SUCCESS) {
            result.status = mark_res;
            return result;
        }
        return page_update;
    }

    if (page_update.status != StorageResult::PAGE_FULL) {
        return page_update;
    }

    // Relocation requires compensating writes if retiring the old tuple fails.
    return relocate_tuple(rid, page, new_tuple, old_copy, old_offset, old_size);
}

StorageResult TableHeap::delete_tuple(const RID& rid) noexcept {
    if (!accessor_ || !master_ptr_ || !rid.is_valid()) {
        return StorageResult::INVALID_ARGUMENT;
    }

    uint8_t* buf = nullptr;
    auto page_res = fetch_validated_page(rid.page_id, buf);
    if (page_res != StorageResult::SUCCESS) {
        return page_res;
    }

    TablePage page(buf);
    auto del_res = page.delete_tuple(rid.slot_num);
    if (del_res == StorageResult::SUCCESS) {
        auto mark_res = accessor_->mark_dirty(rid.page_id);
        if (mark_res != StorageResult::SUCCESS) {
            return mark_res;
        }
    }
    return del_res;
}

TableIterator::TableIterator(TableHeap* heap, page_id_t start_page_id, uint16_t start_slot)
    : heap_(heap), current_rid_{start_page_id, start_slot}, status_(IteratorStatus::AT_RECORD) {
    if (!heap_ || start_page_id == INVALID_PAGE_ID) {
        status_ = IteratorStatus::END_OF_SCAN;
        return;
    }
    locate_next_live_tuple();
}

TableIterator TableHeap::begin() noexcept {
    return TableIterator(this, first_page_id_, 0);
}

void TableIterator::locate_next_live_tuple() noexcept {
    try {
        while (current_rid_.page_id != INVALID_PAGE_ID) {
            if (visited_pages_.find(current_rid_.page_id) == visited_pages_.end()) {
                if (visited_pages_.size() >= MAX_PAGES) {
                    status_ = IteratorStatus::CYCLE_DETECTED;
                    return;
                }
                visited_pages_.insert(current_rid_.page_id);
            }

            uint8_t* buf = nullptr;
            auto fetch_res = heap_->get_accessor()->fetch_page(current_rid_.page_id, &buf);
            if (fetch_res != StorageResult::SUCCESS) {
                status_ = IteratorStatus::PAGE_NOT_FOUND;
                return;
            }

            const uint32_t page_count =
                heap_->get_master() ? heap_->get_master()->page_count : (current_rid_.page_id + 1);
            auto val_res = TablePage::validate(buf, current_rid_.page_id, page_count);
            if (val_res != StorageResult::SUCCESS) {
                status_ = IteratorStatus::CORRUPTED_PAGE;
                return;
            }

            TablePage page(buf);
            if (page.get_prev_page_id() != prev_page_id_) {
                status_ = IteratorStatus::CORRUPTED_PAGE;
                return;
            }

            const uint16_t slots = page.get_slot_count();
            while (current_rid_.slot_num < slots) {
                if (page.get_slot_state(current_rid_.slot_num) == SlotState::LIVE) {
                    status_ = IteratorStatus::AT_RECORD;
                    return;  // Found next valid LIVE tuple
                }
                current_rid_.slot_num++;
            }

            // Exhausted slots on this page, move to next page
            prev_page_id_ = current_rid_.page_id;
            current_rid_.page_id = page.get_next_page_id();
            current_rid_.slot_num = 0;

            if (current_rid_.page_id != INVALID_PAGE_ID &&
                visited_pages_.find(current_rid_.page_id) != visited_pages_.end()) {
                status_ = IteratorStatus::CYCLE_DETECTED;
                return;
            }
        }

        status_ = IteratorStatus::END_OF_SCAN;
    } catch (const std::bad_alloc&) {
        status_ = IteratorStatus::OUT_OF_MEMORY;
    }
}

void TableIterator::advance() noexcept {
    if (!is_valid()) return;
    current_rid_.slot_num++;
    locate_next_live_tuple();
}

StorageResult TableIterator::get_current_tuple(Tuple& out_tuple) const noexcept {
    if (!is_valid()) {
        return StorageResult::INVALID_ARGUMENT;
    }
    return heap_->get_tuple(current_rid_, out_tuple);
}

}  // namespace webdb
