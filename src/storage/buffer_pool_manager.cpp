#include "storage/buffer_pool_manager.hpp"

#include <limits>
#include <stdexcept>

namespace webdb {

namespace {

bool is_resident_state(BufferFrameState state) noexcept {
    return state == BufferFrameState::RESIDENT || state == BufferFrameState::DIRTY ||
           state == BufferFrameState::FLUSHING;
}

} // namespace

BufferPoolManager::BufferPoolManager(BufferPoolConfig config) : config_(config) {
    if (config_.frame_count == 0 || config_.frame_count > MAX_FRAME_COUNT ||
        config_.max_pending_loads == 0 || config_.max_pending_loads > config_.frame_count ||
        config_.max_flush_batch_pages == 0 || config_.max_flush_batch_pages > config_.frame_count) {
        throw std::invalid_argument("Buffer pool configuration is outside the supported range");
    }

    const auto frame_count = static_cast<size_t>(config_.frame_count);
    if (frame_count > std::numeric_limits<size_t>::max() / DATABASE_PAGE_SIZE) {
        throw std::invalid_argument("Buffer pool storage size overflows size_t");
    }

    pool_storage_ = std::make_unique<uint8_t[]>(frame_count * DATABASE_PAGE_SIZE);
    frames_.resize(frame_count);
    free_frames_.reserve(frame_count);
    page_to_frame_.reserve(frame_count);

    for (frame_id_t frame_id = 0; frame_id < config_.frame_count; ++frame_id) {
        frames_[frame_id].descriptor.frame_id = frame_id;
        free_frames_.push_back(frame_id);
    }
}

BufferPoolManager::~BufferPoolManager() = default;

size_t BufferPoolManager::frame_count() const noexcept { return frames_.size(); }

size_t BufferPoolManager::resident_count() const noexcept {
    size_t count = 0;
    for (const Frame& frame : frames_) {
        if (is_resident_state(frame.descriptor.state)) ++count;
    }
    return count;
}

size_t BufferPoolManager::dirty_count() const noexcept {
    size_t count = 0;
    for (const Frame& frame : frames_) {
        if (frame.descriptor.state == BufferFrameState::DIRTY) ++count;
    }
    return count;
}

size_t BufferPoolManager::loading_count() const noexcept {
    size_t count = 0;
    for (const Frame& frame : frames_) {
        if (frame.descriptor.state == BufferFrameState::LOADING) ++count;
    }
    return count;
}

size_t BufferPoolManager::flushing_count() const noexcept {
    size_t count = 0;
    for (const Frame& frame : frames_) {
        if (frame.descriptor.state == BufferFrameState::FLUSHING) ++count;
    }
    return count;
}

size_t BufferPoolManager::free_frame_count() const noexcept { return free_frames_.size(); }

frame_id_t BufferPoolManager::get_clock_hand() const noexcept { return clock_hand_; }

std::optional<frame_id_t> BufferPoolManager::find_frame_by_page_id(page_id_t page_id) const noexcept {
    const auto it = page_to_frame_.find(page_id);
    if (it == page_to_frame_.end()) return std::nullopt;
    return it->second;
}

std::optional<FrameDescriptor> BufferPoolManager::get_frame_descriptor(frame_id_t frame_id) const noexcept {
    if (static_cast<size_t>(frame_id) >= frames_.size()) return std::nullopt;
    return frames_[frame_id].descriptor;
}

bool BufferPoolManager::is_page_resident(page_id_t page_id) const noexcept {
    const auto frame_id = find_frame_by_page_id(page_id);
    return frame_id.has_value() && is_resident_state(frames_[*frame_id].descriptor.state);
}

bool BufferPoolManager::is_page_loading(page_id_t page_id) const noexcept {
    const auto frame_id = find_frame_by_page_id(page_id);
    return frame_id.has_value() && frames_[*frame_id].descriptor.state == BufferFrameState::LOADING;
}

uint32_t BufferPoolManager::get_pin_count(page_id_t page_id) const noexcept {
    const auto frame_id = find_frame_by_page_id(page_id);
    return frame_id.has_value() ? frames_[*frame_id].descriptor.pin_count : 0;
}

uint8_t* BufferPoolManager::get_frame_bytes(frame_id_t frame_id) noexcept {
    // Frame IDs are validated by the owning operation before this private helper
    // is called. Keeping the offset calculation here prevents future page-handle
    // code from duplicating the storage-layout arithmetic.
    return pool_storage_.get() + static_cast<size_t>(frame_id) * DATABASE_PAGE_SIZE;
}

const uint8_t* BufferPoolManager::get_frame_bytes(frame_id_t frame_id) const noexcept {
    return pool_storage_.get() + static_cast<size_t>(frame_id) * DATABASE_PAGE_SIZE;
}

bool BufferPoolManager::is_valid_page_id(page_id_t page_id) noexcept {
    return page_id >= 0 && page_id <= MAX_DATA_PAGE_ID;
}

BufferPoolManager::Frame* BufferPoolManager::find_frame(page_id_t page_id) noexcept {
    const auto frame_id = find_frame_by_page_id(page_id);
    return frame_id.has_value() ? &frames_[*frame_id] : nullptr;
}

const BufferPoolManager::Frame* BufferPoolManager::find_frame(page_id_t page_id) const noexcept {
    const auto frame_id = find_frame_by_page_id(page_id);
    return frame_id.has_value() ? &frames_[*frame_id] : nullptr;
}

// Assigns one currently ABSENT frame to a new logical page mapping. This is the
// common reservation path for both begin_page_load() and the synchronous
// load_page() test helper: the former requests LOADING and the latter requests
// RESIDENT. For example, when page 42 is absent and frame 3 is the last free
// frame, this method removes frame 3 from free_frames_, records 42 -> 3 in
// page_to_frame_, initializes the descriptor, and returns frame 3 to the caller.
//
// The operation is deliberately limited to LOADING and RESIDENT. DIRTY and
// FLUSHING are reached only through their lifecycle transitions so mutation and
// flush-generation invariants cannot be bypassed by a caller assigning a frame
// directly. Duplicate page IDs are rejected before the free list is changed,
// and a full free list returns BUFFER_FULL without modifying the frame table.
StorageResult BufferPoolManager::assign_frame(page_id_t page_id,
                                               BufferFrameState state,
                                               frame_id_t& out_frame_id) {
    if (!is_valid_page_id(page_id) || (state != BufferFrameState::LOADING &&
                                       state != BufferFrameState::RESIDENT)) {
        return StorageResult::INVALID_ARGUMENT;
    }
    if (page_to_frame_.find(page_id) != page_to_frame_.end()) {
        return StorageResult::INVALID_ARGUMENT;
    }
    if (free_frames_.empty()) return StorageResult::BUFFER_FULL;

    const frame_id_t frame_id = free_frames_.back();
    // Insert first: unordered_map::emplace may allocate and throw. Keeping the
    // free list and descriptor untouched until insertion succeeds preserves the
    // frame-table invariants if allocation fails.
    const auto insertion = page_to_frame_.emplace(page_id, frame_id);
    if (!insertion.second) return StorageResult::INVALID_ARGUMENT;

    FrameDescriptor& descriptor = frames_[frame_id].descriptor;
    descriptor.page_id = page_id;
    descriptor.state = state;
    descriptor.pin_count = 0;
    descriptor.ref_bit = false;
    descriptor.dirty_generation = 0;
    descriptor.flushing_generation = 0;
    free_frames_.pop_back();
    out_frame_id = frame_id;
    return StorageResult::SUCCESS;
}

StorageResult BufferPoolManager::begin_page_load(page_id_t page_id, frame_id_t& out_frame_id) {
    if (!is_valid_page_id(page_id)) return StorageResult::INVALID_ARGUMENT;
    const Frame* existing = find_frame(page_id);
    if (existing != nullptr) {
        if (existing->descriptor.state == BufferFrameState::LOADING) {
            return StorageResult::LOAD_IN_PROGRESS;
        }
        return existing->descriptor.state == BufferFrameState::FLUSHING ? StorageResult::BUSY
                                                                          : StorageResult::INVALID_ARGUMENT;
    }
    return assign_frame(page_id, BufferFrameState::LOADING, out_frame_id);
}

StorageResult BufferPoolManager::complete_page_load(page_id_t page_id) {
    Frame* frame = find_frame(page_id);
    if (frame == nullptr) return StorageResult::INVALID_ARGUMENT;
    if (frame->descriptor.state != BufferFrameState::LOADING) return StorageResult::INVALID_ARGUMENT;
    frame->descriptor.state = BufferFrameState::RESIDENT;
    return StorageResult::SUCCESS;
}

StorageResult BufferPoolManager::load_page(page_id_t page_id, frame_id_t& out_frame_id) {
    return assign_frame(page_id, BufferFrameState::RESIDENT, out_frame_id);
}

StorageResult BufferPoolManager::mark_page_dirty(page_id_t page_id) {
    Frame* frame = find_frame(page_id);
    if (frame == nullptr || frame->descriptor.state != BufferFrameState::RESIDENT) {
        return StorageResult::INVALID_ARGUMENT;
    }
    frame->descriptor.state = BufferFrameState::DIRTY;
    frame->descriptor.dirty_generation = 1;
    return StorageResult::SUCCESS;
}

StorageResult BufferPoolManager::begin_page_flush(page_id_t page_id) {
    Frame* frame = find_frame(page_id);
    if (frame == nullptr || frame->descriptor.state != BufferFrameState::DIRTY ||
        frame->descriptor.pin_count != 0) {
        return StorageResult::INVALID_ARGUMENT;
    }
    frame->descriptor.state = BufferFrameState::FLUSHING;
    frame->descriptor.flushing_generation = frame->descriptor.dirty_generation;
    return StorageResult::SUCCESS;
}

StorageResult BufferPoolManager::complete_page_flush(page_id_t page_id, bool success) {
    Frame* frame = find_frame(page_id);
    if (frame == nullptr || frame->descriptor.state != BufferFrameState::FLUSHING) {
        return StorageResult::INVALID_ARGUMENT;
    }
    frame->descriptor.state = success ? BufferFrameState::RESIDENT : BufferFrameState::DIRTY;
    if (success) frame->descriptor.flushing_generation = 0;
    return StorageResult::SUCCESS;
}

StorageResult BufferPoolManager::release_page(page_id_t page_id) {
    const auto frame_id = find_frame_by_page_id(page_id);
    if (!frame_id.has_value()) return StorageResult::INVALID_ARGUMENT;
    FrameDescriptor& descriptor = frames_[*frame_id].descriptor;
    if (descriptor.pin_count != 0 || descriptor.state == BufferFrameState::LOADING ||
        descriptor.state == BufferFrameState::DIRTY || descriptor.state == BufferFrameState::FLUSHING) {
        return StorageResult::INVALID_ARGUMENT;
    }
    page_to_frame_.erase(page_id);
    descriptor = FrameDescriptor{};
    descriptor.frame_id = *frame_id;
    free_frames_.push_back(*frame_id);
    return StorageResult::SUCCESS;
}

} // namespace webdb