import { describe, it, expect } from "vitest";
import {
  PAGE_SIZE,
  PAGE_HEADER_SIZE,
  PAGE_HEADER_OFFSET_TYPE,
  PAGE_HEADER_OFFSET_FLAGS,
  PAGE_HEADER_OFFSET_CELL_COUNT,
  PAGE_HEADER_OFFSET_CONTENT_OFFSET,
  PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
  PAGE_HEADER_OFFSET_FREE_BYTES,
  PAGE_HEADER_OFFSET_CHECKSUM,
  TABLE_INTERIOR_CELL_SIZE,
  TABLE_INTERIOR_CELL_OFFSET_CHILD_PAGE_ID,
  TABLE_INTERIOR_CELL_OFFSET_ROWID,
  FILE_HEADER_SIZE,
  HEADER_OFFSET_MAGIC,
  HEADER_OFFSET_PAGE_SIZE,
  HEADER_OFFSET_FILE_FORMAT_VERSION,
  HEADER_OFFSET_MIN_READ_VERSION,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  HEADER_OFFSET_SCHEMA_VERSION,
  HEADER_OFFSET_CHANGE_COUNTER,
  HEADER_OFFSET_PAGE_CHECKSUM,
  HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
  HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
  HEADER_OFFSET_RESERVED,
  MASTER_TABLE_OFFSET,
  TABLE_DESCRIPTOR_SIZE,
  INDEX_CATALOG_OFFSET,
  INDEX_DESCRIPTOR_SIZE,
  NEXT_DESCRIPTOR_CATALOG_PAGE_OFFSET,
  SYSPAGE_RESERVED_OFFSET,
  SYSPAGE_RESERVED_SIZE,
  CATALOG_PAGE_HEADER_SIZE,
  COLUMN_META_SIZE,
  DEFAULT_SLOT_COUNT,
  WASM_STACK_TOP,
  WASM_REGION_SIZE,
  SLOTS_BASE_OFFSET,
  SLOT_TO_PAGE_OFFSET,
  PAGE_TO_SLOT_OFFSET,
  DIRTY_MASK_OFFSET,
  VM_CONTEXT_OFFSET,
  RESULT_BUFFER_OFFSET,
  BYTECODE_OFFSET,
  PAGE_SCRATCHPAD_OFFSET,
  TRANSIENT_ARENA_OFFSET,
  computeBufferPoolOffsets,
} from "../src/layouts/index.ts";

describe("Layout Architecture Tests (tests/layouts.test.ts)", () => {
  it("1. Slotted Page Header Layout matches 16-byte specification", () => {
    expect(PAGE_HEADER_SIZE).toBe(16);
    expect(PAGE_HEADER_OFFSET_TYPE).toBe(0);
    expect(PAGE_HEADER_OFFSET_FLAGS).toBe(1);
    expect(PAGE_HEADER_OFFSET_CELL_COUNT).toBe(2);
    expect(PAGE_HEADER_OFFSET_CONTENT_OFFSET).toBe(4);
    expect(PAGE_HEADER_OFFSET_NEXT_PAGE_ID).toBe(6);
    expect(PAGE_HEADER_OFFSET_FREE_BYTES).toBe(10);
    expect(PAGE_HEADER_OFFSET_CHECKSUM).toBe(12);
  });

  it("2. Table Interior Cell Layout matches 12-byte routing cell specification", () => {
    expect(TABLE_INTERIOR_CELL_SIZE).toBe(12);
    expect(TABLE_INTERIOR_CELL_OFFSET_CHILD_PAGE_ID).toBe(0);
    expect(TABLE_INTERIOR_CELL_OFFSET_ROWID).toBe(4);
  });

  it("3. Page 1 File Header Layout matches exact 100-byte specification", () => {
    expect(FILE_HEADER_SIZE).toBe(100);
    expect(HEADER_OFFSET_MAGIC).toBe(0);
    expect(HEADER_OFFSET_PAGE_SIZE).toBe(6);
    expect(HEADER_OFFSET_FILE_FORMAT_VERSION).toBe(8);
    expect(HEADER_OFFSET_MIN_READ_VERSION).toBe(10);
    expect(HEADER_OFFSET_TOTAL_PAGES).toBe(12);
    expect(HEADER_OFFSET_FREE_PAGE_HEAD).toBe(16);
    expect(HEADER_OFFSET_SCHEMA_VERSION).toBe(20);
    expect(HEADER_OFFSET_CHANGE_COUNTER).toBe(24);
    expect(HEADER_OFFSET_PAGE_CHECKSUM).toBe(28);
    expect(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID).toBe(32);
    expect(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID).toBe(36);
    expect(HEADER_OFFSET_RESERVED).toBe(40);
  });

  it("4. Page 1 Master Catalog space partition accounts for all 4096 bytes", () => {
    expect(MASTER_TABLE_OFFSET).toBe(100);
    expect(TABLE_DESCRIPTOR_SIZE).toBe(128);
    expect(INDEX_CATALOG_OFFSET).toBe(2148);
    expect(INDEX_DESCRIPTOR_SIZE).toBe(128);
    expect(NEXT_DESCRIPTOR_CATALOG_PAGE_OFFSET).toBe(3172);
    expect(SYSPAGE_RESERVED_OFFSET).toBe(3176);
    expect(SYSPAGE_RESERVED_SIZE).toBe(920);

    // Sum of all System Page regions must equal PAGE_SIZE exactly
    expect(SYSPAGE_RESERVED_OFFSET + SYSPAGE_RESERVED_SIZE).toBe(PAGE_SIZE);
  });

  it("5. Catalog structures match fixed binary sizes", () => {
    expect(CATALOG_PAGE_HEADER_SIZE).toBe(16);
    expect(COLUMN_META_SIZE).toBe(72);
  });

  it("6. Buffer Pool memory layout aligns with fixed low engine block + default 1024-slot (4MB) specification", () => {
    expect(DEFAULT_SLOT_COUNT).toBe(1024);
    expect(WASM_STACK_TOP).toBe(0x00c000);
    expect(WASM_REGION_SIZE).toBe(0x010000);
    expect(VM_CONTEXT_OFFSET).toBe(0x010000);
    expect(RESULT_BUFFER_OFFSET).toBe(0x013000);
    expect(BYTECODE_OFFSET).toBe(0x023000);
    expect(PAGE_SCRATCHPAD_OFFSET).toBe(0x02b000);
    expect(SLOTS_BASE_OFFSET).toBe(0x030000);
    expect(SLOT_TO_PAGE_OFFSET).toBe(0x430000);
    expect(PAGE_TO_SLOT_OFFSET).toBe(0x431000);
    expect(DIRTY_MASK_OFFSET).toBe(0x435000);
    expect(TRANSIENT_ARENA_OFFSET).toBe(0x440000);
  });

  it("7. Dynamic buffer pool offset computation correctly offsets non-default slot counts", () => {
    const custom = computeBufferPoolOffsets(64);
    expect(custom.slotsBaseOffset).toBe(SLOTS_BASE_OFFSET);
    expect(custom.slotsEndOffset).toBe(SLOTS_BASE_OFFSET + 64 * PAGE_SIZE);
    expect(custom.slotToPageOffset).toBe(custom.slotsEndOffset);
    // 64 slots * 4 bytes = 256 bytes (8-byte aligned)
    expect(custom.pageToSlotOffset).toBe(custom.slotToPageOffset + 256);
    // 64 slots -> 128 buckets * 8 bytes = 1024 bytes
    expect(custom.dirtyMaskOffset).toBe(custom.pageToSlotOffset + 1024);
    expect(custom.transientArenaOffset % 65536).toBe(0);

    // Large slotCount (e.g. 8192 = 32 MB) scales cleanly without overlapping fixed engine block
    const large = computeBufferPoolOffsets(8192);
    expect(large.slotsBaseOffset).toBe(SLOTS_BASE_OFFSET);
    expect(large.slotsEndOffset).toBe(SLOTS_BASE_OFFSET + 8192 * PAGE_SIZE);
    expect(large.slotToPageOffset).toBe(large.slotsEndOffset);
    expect(large.pageToSlotBuckets).toBe(16384);
    expect(large.pageToSlotOffset).toBe(large.slotToPageOffset + 8192 * 4);
    expect(large.dirtyMaskOffset).toBe(large.pageToSlotOffset + 16384 * 8);
    expect(large.transientArenaOffset % 65536).toBe(0);
    expect(large.transientArenaOffset).toBeGreaterThanOrEqual(
      large.dirtyMaskOffset + 1024,
    );
  });
});
