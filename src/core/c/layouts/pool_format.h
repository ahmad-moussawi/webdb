/**
 * AUTO-GENERATED FROM src/layouts/schemas/pool_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

#ifndef WEBDB_POOL_FORMAT_H
#define WEBDB_POOL_FORMAT_H

#include <stdint.h>
#include "page_format.h"

// Default cache buffer pool size in bytes (4 MB = 1024 * 4096).
#define DEFAULT_CACHE_SIZE_BYTES 4194304

// Default number of page cache slots in the buffer pool (1024).
#define DEFAULT_SLOT_COUNT 1024

// Alias for DEFAULT_SLOT_COUNT (1024).
#define DEFAULT_PAGE_SLOTS 1024

// Default number of hash table buckets for page-to-slot mapping (2048, load fac...
#define DEFAULT_PAGE_TO_SLOT_BUCKETS 2048

// Size in bytes of each hash table bucket (uint32 page_id + uint32 slot_idx = 8...
#define PAGE_TO_SLOT_BUCKET_SIZE 8

// Total size in bytes of the page-to-slot hash table (2048 * 8 = 16 KB).
#define PAGE_TO_SLOT_SIZE 16384

// Size in bytes allocated for VM execution context state (12 KB).
#define VM_CONTEXT_SIZE 12288

// Size in bytes allocated for SQL result row serialization buffer (64 KB).
#define RESULT_BUFFER_SIZE 65536

// Size in bytes allocated for compiled query bytecode instructions (32 KB).
#define BYTECODE_SIZE 32768

// Size in bytes allocated for temporary single-page staging / decompression (4 ...
#define PAGE_SCRATCHPAD_SIZE 4096

// Padding bytes to align transient execution arena at boundary 0x430000 (61,312...
#define ALIGNMENT_PADDING_SIZE 61312

// Maximum memory limit in bytes for transient query execution arena (16 MB).
#define DEFAULT_MAX_QUERY_MEMORY 16777216

// Buffer Pool Region Offsets
#define SLOT_TO_PAGE_OFFSET 4194304
#define PAGE_TO_SLOT_OFFSET 4198400
#define DIRTY_MASK_OFFSET 4214784
#define VM_CONTEXT_OFFSET 4214912
#define RESULT_BUFFER_OFFSET 4227200
#define BYTECODE_OFFSET 4292736
#define PAGE_SCRATCHPAD_OFFSET 4325504
#define ALIGNMENT_PADDING_OFFSET 4329600
#define TRANSIENT_ARENA_OFFSET 4390912

// Total buffer pool and shared Wasm memory allocation in bytes (20.1875 MB).
#define TOTAL_MEMORY_BYTES 21168128

#endif /* WEBDB_POOL_FORMAT_H */
