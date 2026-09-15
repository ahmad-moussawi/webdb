#pragma once

#include "common/types.hpp"

namespace webdb {

/**
 * @brief Synchronous abstract page accessor for Phase 1 storage components.
 * Decouples table pages and heaps from future buffer pool eviction mechanics.
 */
class IPageAccessor {
public:
    virtual ~IPageAccessor() = default;

    /**
     * @brief Retrieves a mutable pointer to exactly PAGE_SIZE bytes.
     * @param page_id Target page ID.
     * @param out_page Pointer to receive the buffer.
     * @return StorageResult::SUCCESS on success, or StorageResult::IO_ERROR if unallocated/out of range.
     */
    virtual StorageResult fetch_page(page_id_t page_id, uint8_t** out_page) noexcept = 0;

    /**
     * @brief Allocates and zero-initializes the specified append-only page ID.
     * @param expected_page_id Must match pending MasterData.page_count.
     * @param out_page Pointer to receive the newly allocated zero-initialized buffer.
     * @return StorageResult::SUCCESS or StorageResult::INVALID_ARGUMENT.
     */
    virtual StorageResult allocate_page(page_id_t expected_page_id, uint8_t** out_page) noexcept = 0;

    /**
     * @brief Discards a page allocated during a failed pending operation.
     */
    virtual StorageResult discard_page(page_id_t page_id) noexcept = 0;

    /**
     * @brief Marks a page dirty after byte modification.
     */
    virtual StorageResult mark_dirty(page_id_t page_id) noexcept = 0;

    /**
     * @brief Flushes a dirty page to the underlying storage backend.
     */
    virtual StorageResult flush_page(page_id_t page_id) noexcept = 0;

    /**
     * @brief Flushes all currently dirty pages to the underlying storage backend.
     */
    virtual StorageResult flush_dirty_pages() noexcept = 0;

    /**
     * @brief Requests a durable storage sync barrier from the backend.
     */
    virtual StorageResult sync() noexcept = 0;
};

} // namespace webdb
