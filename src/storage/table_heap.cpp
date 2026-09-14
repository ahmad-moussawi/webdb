#include "storage/table_heap.hpp"

#include <vector>

namespace webdb {

StorageResult TableHeap::create(IPageAccessor& accessor,
                                MasterData& pending_master,
                                TableHeap& out_heap) noexcept {
    const page_id_t new_page_id = static_cast<page_id_t>(pending_master.page_count);
    uint8_t* page_buf = nullptr;
    auto alloc_res = accessor.allocate_page(new_page_id, &page_buf);
    if (alloc_res != StorageResult::SUCCESS) {
        return alloc_res;
    }

    TablePage::init(page_buf, new_page_id, INVALID_PAGE_ID, INVALID_PAGE_ID);
    auto mark_res = accessor.mark_dirty(new_page_id);
    if (mark_res != StorageResult::SUCCESS) {
        return mark_res;
    }
    pending_master.page_count++;

    out_heap = TableHeap(&accessor, &pending_master, new_page_id, new_page_id);
    return StorageResult::SUCCESS;
}

StorageResult TableHeap::open(IPageAccessor& accessor,
                              MasterData& pending_master,
                              page_id_t first_page_id,
                              TableHeap& out_heap) noexcept {
    if (first_page_id < FIRST_DATA_PAGE_ID || static_cast<uint32_t>(first_page_id) >= pending_master.page_count) {
        return StorageResult::CORRUPTED_PAGE;
    }

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
            return StorageResult::CORRUPTED_PAGE; // Broken backward link
        }

        prev = curr;
        curr = page.get_next_page_id();
    }

    out_heap = TableHeap(&accessor, &pending_master, first_page_id, prev);
    return StorageResult::SUCCESS;
}

StorageResult TableHeap::insert_tuple(const Tuple& tuple, RID& out_rid) noexcept {
    if (!accessor_ || !master_ptr_) {
        return StorageResult::INVALID_ARGUMENT;
    }
    if (tuple.size() > MAX_TUPLE_SIZE) {
        return StorageResult::TUPLE_TOO_LARGE;
    }

    // 1. Try to insert into last_page_id
    uint8_t* last_buf = nullptr;
    auto fetch_res = accessor_->fetch_page(last_page_id_, &last_buf);
    if (fetch_res != StorageResult::SUCCESS) {
        return fetch_res;
    }

    auto val_res = TablePage::validate(last_buf, last_page_id_, master_ptr_->page_count);
    if (val_res != StorageResult::SUCCESS) {
        return val_res;
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
    const page_id_t new_page_id = static_cast<page_id_t>(master_ptr_->page_count);
    uint8_t* new_buf = nullptr;
    auto alloc_res = accessor_->allocate_page(new_page_id, &new_buf);
    if (alloc_res != StorageResult::SUCCESS) {
        return alloc_res;
    }

    // Initialize new page linked to old last page
    TablePage::init(new_buf, new_page_id, last_page_id_, INVALID_PAGE_ID);

    // Link old last page forward to new page
    last_page.set_next_page_id(new_page_id);
    auto mark_old = accessor_->mark_dirty(last_page_id_);
    if (mark_old != StorageResult::SUCCESS) {
        return mark_old;
    }

    // Insert tuple into the fresh page
    TablePage new_page(new_buf);
    ins_res = new_page.insert_tuple(tuple.data(), tuple.size(), slot_num);
    if (ins_res != StorageResult::SUCCESS) {
        return ins_res;
    }

    auto mark_new = accessor_->mark_dirty(new_page_id);
    if (mark_new != StorageResult::SUCCESS) {
        return mark_new;
    }
    master_ptr_->page_count++;
    last_page_id_ = new_page_id;

    out_rid = RID{new_page_id, slot_num};
    return StorageResult::SUCCESS;
}

StorageResult TableHeap::get_tuple(const RID& rid, Tuple& out_tuple) const noexcept {
    if (!accessor_ || !rid.is_valid()) {
        return StorageResult::INVALID_ARGUMENT;
    }

    uint8_t* buf = nullptr;
    auto fetch_res = accessor_->fetch_page(rid.page_id, &buf);
    if (fetch_res != StorageResult::SUCCESS) {
        return fetch_res;
    }

    const uint32_t page_count = master_ptr_ ? master_ptr_->page_count : static_cast<uint32_t>(rid.page_id + 1);
    auto val_res = TablePage::validate(buf, rid.page_id, page_count);
    if (val_res != StorageResult::SUCCESS) {
        return val_res;
    }

    TablePage page(buf);
    const uint8_t* tuple_bytes = nullptr;
    size_t tuple_size = 0;

    auto get_res = page.get_tuple(rid.slot_num, &tuple_bytes, tuple_size);
    if (get_res != StorageResult::SUCCESS) {
        return get_res;
    }

    out_tuple = Tuple(std::vector<uint8_t>(tuple_bytes, tuple_bytes + tuple_size));
    return StorageResult::SUCCESS;
}

UpdateResult TableHeap::update_tuple(const RID& rid, const Tuple& new_tuple) noexcept {
    UpdateResult result{};
    result.old_rid = rid;
    result.new_rid = rid;
    result.rid_changed = false;

    if (!accessor_ || !rid.is_valid()) {
        result.status = StorageResult::INVALID_ARGUMENT;
        return result;
    }

    uint8_t* buf = nullptr;
    auto fetch_res = accessor_->fetch_page(rid.page_id, &buf);
    if (fetch_res != StorageResult::SUCCESS) {
        result.status = fetch_res;
        return result;
    }

    const uint32_t page_count = master_ptr_ ? master_ptr_->page_count : static_cast<uint32_t>(rid.page_id + 1);
    auto val_res = TablePage::validate(buf, rid.page_id, page_count);
    if (val_res != StorageResult::SUCCESS) {
        result.status = val_res;
        return result;
    }

    TablePage page(buf);
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

    // Cannot fit on current page: Relocate to table heap tail
    RID new_rid{};
    auto ins_res = insert_tuple(new_tuple, new_rid);
    if (ins_res != StorageResult::SUCCESS) {
        result.status = ins_res;
        return result;
    }

    // Mark old slot DEAD
    page.delete_tuple(rid.slot_num);
    auto mark_res = accessor_->mark_dirty(rid.page_id);
    if (mark_res != StorageResult::SUCCESS) {
        result.status = mark_res;
        return result;
    }

    result.status = StorageResult::SUCCESS;
    result.new_rid = new_rid;
    result.rid_changed = true;
    return result;
}

StorageResult TableHeap::delete_tuple(const RID& rid) noexcept {
    if (!accessor_ || !rid.is_valid()) {
        return StorageResult::INVALID_ARGUMENT;
    }

    uint8_t* buf = nullptr;
    auto fetch_res = accessor_->fetch_page(rid.page_id, &buf);
    if (fetch_res != StorageResult::SUCCESS) {
        return fetch_res;
    }

    const uint32_t page_count = master_ptr_ ? master_ptr_->page_count : static_cast<uint32_t>(rid.page_id + 1);
    auto val_res = TablePage::validate(buf, rid.page_id, page_count);
    if (val_res != StorageResult::SUCCESS) {
        return val_res;
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

        const uint32_t page_count = heap_->get_master() ? heap_->get_master()->page_count : (current_rid_.page_id + 1);
        auto val_res = TablePage::validate(buf, current_rid_.page_id, page_count);
        if (val_res != StorageResult::SUCCESS) {
            status_ = IteratorStatus::CORRUPTED_PAGE;
            return;
        }

        TablePage page(buf);
        if (prev_page_id_ != INVALID_PAGE_ID && page.get_prev_page_id() != prev_page_id_) {
            status_ = IteratorStatus::CORRUPTED_PAGE;
            return;
        }

        const uint16_t slots = page.get_slot_count();
        while (current_rid_.slot_num < slots) {
            if (page.get_slot_state(current_rid_.slot_num) == SlotState::LIVE) {
                status_ = IteratorStatus::AT_RECORD;
                return; // Found next valid LIVE tuple
            }
            current_rid_.slot_num++;
        }

        // Exhausted slots on this page, move to next page
        prev_page_id_ = current_rid_.page_id;
        current_rid_.page_id = page.get_next_page_id();
        current_rid_.slot_num = 0;

        if (current_rid_.page_id != INVALID_PAGE_ID && visited_pages_.find(current_rid_.page_id) != visited_pages_.end()) {
            status_ = IteratorStatus::CYCLE_DETECTED;
            return;
        }
    }

    status_ = IteratorStatus::END_OF_SCAN;
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

} // namespace webdb
