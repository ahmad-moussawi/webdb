import { describe, it, expect, beforeEach } from "vitest";
import {
  createWasmCore,
  getWebDbCoreWasmBytes,
  PAGE_SIZE,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_FREE,
  PAGE_TO_SLOT_OFFSET,
  DEFAULT_PAGE_TO_SLOT_BUCKETS,
  SLOT_TO_PAGE_OFFSET,
  DIRTY_MASK_OFFSET,
  createWasmMemory,
  WebDB,
  DataType,
} from "../src/index.ts";
import * as jsCore from "../src/core/js/index.ts";

describe("C Core (Compiled WebAssembly) Parity & Execution", () => {
  let memory: WebAssembly.Memory;
  let wasmCore: ReturnType<typeof createWasmCore>;

  beforeEach(() => {
    memory = createWasmMemory();
    wasmCore = createWasmCore(memory);
  });

  describe("1. Slotted Page Headers & Primitives", () => {
    it("initializes slotted pages bit-for-bit identical to JS core", () => {
      const jsMem = createWasmMemory();
      const jsView = new DataView(jsMem.buffer);
      const wasmView = new DataView(memory.buffer);

      jsCore.page_init(jsView, 0, PAGE_TYPE_LEAF_DATA, 42);
      wasmCore.page_init(wasmView, 0, PAGE_TYPE_LEAF_DATA, 42);

      const jsBytes = new Uint8Array(jsMem.buffer, 0, PAGE_SIZE);
      const wasmBytes = new Uint8Array(memory.buffer, 0, PAGE_SIZE);

      expect(wasmBytes).toEqual(jsBytes);
      expect(wasmCore.page_get_type(wasmView, 0)).toBe(PAGE_TYPE_LEAF_DATA);
      expect(wasmCore.page_get_cell_count(wasmView, 0)).toBe(0);
      expect(wasmCore.page_get_cell_content_offset(wasmView, 0)).toBe(PAGE_SIZE);
      expect(wasmCore.page_get_next_page_id(wasmView, 0)).toBe(42);
      expect(wasmCore.page_get_contiguous_free_space(wasmView, 0)).toBe(PAGE_SIZE - 16);
    });

    it("initializes free-list pages identical to JS core", () => {
      const jsMem = createWasmMemory();
      const jsView = new DataView(jsMem.buffer);
      const wasmView = new DataView(memory.buffer);

      jsCore.page_init_free(jsView, 4096, 99);
      wasmCore.page_init_free(wasmView, 4096, 99);

      const jsBytes = new Uint8Array(jsMem.buffer, 4096, PAGE_SIZE);
      const wasmBytes = new Uint8Array(memory.buffer, 4096, PAGE_SIZE);

      expect(wasmBytes).toEqual(jsBytes);
      expect(wasmCore.page_get_type(wasmView, 4096)).toBe(PAGE_TYPE_FREE);
      expect(wasmCore.page_get_next_page_id(wasmView, 4096)).toBe(99);
    });

    it("sets and gets checksum, cell offsets, and cell counts", () => {
      const view = new DataView(memory.buffer);
      wasmCore.page_init(view, 0);

      wasmCore.page_set_checksum(view, 0, 0x12345678);
      expect(wasmCore.page_get_checksum(view, 0)).toBe(0x12345678);

      wasmCore.page_set_cell_count(view, 0, 5);
      expect(wasmCore.page_get_cell_count(view, 0)).toBe(5);

      wasmCore.page_set_cell_offset(view, 0, 0, 3900);
      wasmCore.page_set_cell_offset(view, 0, 4, 3500);
      expect(wasmCore.page_get_cell_offset(view, 0, 0)).toBe(3900);
      expect(wasmCore.page_get_cell_offset(view, 0, 4)).toBe(3500);
    });
  });

  describe("2. Binary Hash Table (Robin Hood Open Addressing)", () => {
    it("hashes page IDs identically to JS core", () => {
      const mask = 2047;
      for (const pageId of [1, 2, 10, 42, 1024, 99999]) {
        expect(wasmCore.page_table_hash(pageId, mask)).toBe(jsCore.page_table_hash(pageId, mask));
      }
    });

    it("inserts, looks up, and deletes entries using backward shift", () => {
      const view = new DataView(memory.buffer);
      const base = PAGE_TO_SLOT_OFFSET;
      const buckets = DEFAULT_PAGE_TO_SLOT_BUCKETS;

      expect(wasmCore.page_table_get(view, base, buckets, 100)).toBe(-1);

      wasmCore.page_table_set(view, base, buckets, 100, 3);
      wasmCore.page_table_set(view, base, buckets, 200, 5);
      wasmCore.page_table_set(view, base, buckets, 300, 7);

      expect(wasmCore.page_table_get(view, base, buckets, 100)).toBe(3);
      expect(wasmCore.page_table_get(view, base, buckets, 200)).toBe(5);
      expect(wasmCore.page_table_get(view, base, buckets, 300)).toBe(7);

      expect(wasmCore.page_table_delete(view, base, buckets, 200)).toBe(true);
      expect(wasmCore.page_table_get(view, base, buckets, 200)).toBe(-1);
      expect(wasmCore.page_table_get(view, base, buckets, 100)).toBe(3);
      expect(wasmCore.page_table_get(view, base, buckets, 300)).toBe(7);
    });
  });

  describe("3. Buffer Pool Operations", () => {
    it("assigns, retrieves, and unassigns slots", () => {
      const view = new DataView(memory.buffer);
      const slotToPage = SLOT_TO_PAGE_OFFSET;
      const pageToSlot = PAGE_TO_SLOT_OFFSET;
      const buckets = DEFAULT_PAGE_TO_SLOT_BUCKETS;

      wasmCore.buf_pool_assign_slot(view, slotToPage, pageToSlot, buckets, 2, 42);
      expect(wasmCore.buf_pool_read_slot_to_page(view, slotToPage, 2)).toBe(42);
      expect(wasmCore.buf_pool_get_resident_slot(view, pageToSlot, buckets, 42)).toBe(2);

      wasmCore.buf_pool_unassign_slot(view, slotToPage, pageToSlot, buckets, 2);
      expect(wasmCore.buf_pool_read_slot_to_page(view, slotToPage, 2)).toBe(0);
      expect(wasmCore.buf_pool_get_resident_slot(view, pageToSlot, buckets, 42)).toBe(-1);
    });

    it("tracks dirty bits correctly", () => {
      const view = new DataView(memory.buffer);
      const dirtyOffset = DIRTY_MASK_OFFSET;

      expect(wasmCore.buf_pool_is_dirty(view, dirtyOffset, 3)).toBe(false);
      wasmCore.buf_pool_mark_dirty(view, dirtyOffset, 3);
      expect(wasmCore.buf_pool_is_dirty(view, dirtyOffset, 3)).toBe(true);
      wasmCore.buf_pool_clear_dirty(view, dirtyOffset, 3);
      expect(wasmCore.buf_pool_is_dirty(view, dirtyOffset, 3)).toBe(false);
    });
  });

  describe("4. Schema Catalog Page 1 Header Operations", () => {
    it("initializes Page 1 with matching magic bytes and checksum", () => {
      const view = new DataView(memory.buffer);
      wasmCore.catalog_init_page1(view);

      const header = wasmCore.catalog_read_page1_header(view, true);
      expect(header.pageSize).toBe(4096);
      expect(header.fileFormatVersion).toBe(1);
      expect(header.totalPages).toBe(1);
      expect(header.schemaVersion).toBe(1);

      expect(wasmCore.catalog_increment_schema_version(view)).toBe(2);
      expect(wasmCore.catalog_get_schema_version(view)).toBe(2);

      expect(wasmCore.catalog_increment_change_counter(view)).toBe(1);
      expect(wasmCore.catalog_get_change_counter(view)).toBe(1);

      const chk = wasmCore.catalog_update_page1_checksum(view);
      expect(chk).toBeGreaterThan(0);
    });
  });

  describe("5. End-to-End WebDB with core: 'wasm'", () => {
    it("opens WebDB with C/WASM core and executes queries", async () => {
      const db = await WebDB.open({
        name: "wasm_test_db",
        storage: "memory",
        core: "wasm",
      });

      expect(db.coreMode).toBe("wasm");
      expect(db.wasmCore).toBeDefined();

      await db.createTable("users", [
        { name: "id", type: DataType.INT32, flags: { primaryKey: true } },
        { name: "name", type: DataType.TEXT, flags: { notNull: true } },
      ]);

      await db.insert("users", { id: 1, name: "Alice" });
      await db.insert("users", { id: 2, name: "Bob" });

      const results = await db.from("users").toArray();
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: 1, name: "Alice" });
      expect(results[1]).toEqual({ id: 2, name: "Bob" });
    });

    it("provides valid embedded WASM binary bytes", () => {
      const bytes = getWebDbCoreWasmBytes();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(1000);
      // WASM magic header "\0asm" = 0x00, 0x61, 0x73, 0x6D
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x61);
      expect(bytes[2]).toBe(0x73);
      expect(bytes[3]).toBe(0x6d);
    });
  });
});
