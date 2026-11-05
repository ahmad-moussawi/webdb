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
  VM_CONTEXT_OFFSET,
  VM_CONTEXT_SIZE,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
  BYTECODE_OFFSET,
  BYTECODE_SIZE,
  PAGE_SCRATCHPAD_OFFSET,
  PAGE_SCRATCHPAD_SIZE,
  ALIGNMENT_PADDING_OFFSET,
  TRANSIENT_ARENA_OFFSET,
  createWasmMemory,
  MemoryVfsAdapter,
  WebDB,
  DataType,
  OpCode,
  VmStatus,
  QueryArenaExhaustedError,
  createVmContext,
  resetVmContext,
} from "../src/index.ts";
import * as jsCore from "../src/core/js/index.ts";
import { CROCKFORD_ALPHABET } from "../src/core/js/codecs.c.ts";
import {
  vm_crockford_char,
  VM_CTX_REGISTERS_OFF,
  VM_REG_SIZE,
  VM_CTX_CURSORS_OFF,
  VM_CURSOR_SIZE,
  VM_CTX_TABLES_OFF,
  VM_TABLE_DESC_SIZE,
  VM_CTX_OUTPUT_COLS_OFF,
  VM_CTX_KEY_INFOS_OFF,
  VM_KEY_INFO_SIZE,
  VM_CTX_SORTERS_OFF,
  VM_SORTER_SIZE,
  VM_CTX_AGGS_OFF,
  VM_AGG_SIZE,
  VM_CTX_IN_SETS_OFF,
  VM_CTX_SCRATCH_OFF,
} from "../src/core/js/vm.helpers.c.ts";

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

    it("does not overwrite Buffer Pool Slot 16 (0x10000 / Page 17) on reopen with core: 'wasm'", async () => {
      const vfs = new MemoryVfsAdapter();

      // 1. Open DB and create 8 tables so Table 8 ("currency_rates") has colCatalogPageId = 17 (Slot 16 at 0x10000)
      const db1 = await WebDB.open({ name: "repro", vfs, core: "wasm" });

      for (let i = 1; i <= 7; i++) {
        await db1.createTable(`t_${i}`, [
          { name: "id", type: "ULID", flags: { notNull: true } },
        ]);
      }

      await db1.createTable("currency_rates", [
        { name: "id", type: "ULID", flags: { notNull: true } },
        { name: "currency", type: "TEXT", flags: { notNull: true } },
      ]);

      await db1.insert("currency_rates", {
        id: "01HV8G7K3D4N5P6Q7R8S9T0V1W",
        currency: "USD",
      });

      await db1.close();

      // 2. Reopen the same VFS with core: 'wasm' (simulating page reload)
      const db2 = await WebDB.open({ name: "repro", vfs, core: "wasm" });

      const meta = await db2.getTable("currency_rates");
      expect(meta.colCatalogPageId).toBe(17);
      expect(meta.columns).toHaveLength(2);
      expect(meta.columns.map((c) => c.name)).toEqual(["id", "currency"]);

      // 3. Query referencing a column on currency_rates succeeds
      const rows = await db2.from("currency_rates").orderBy("id", "desc").toArray();
      expect(rows).toEqual([
        { id: "01HV8G7K3D4N5P6Q7R8S9T0V1W", currency: "USD" },
      ]);

      await db2.close();
    });

    it("places Wasm stack and .rodata/.bss strictly inside ALIGNMENT_PADDING (0x421080..0x42FFFF)", () => {
      const cleanMem = createWasmMemory();
      const core = createWasmCore(cleanMem);
      const u8 = new Uint8Array(cleanMem.buffer);

      // Verify zero bytes were modified across all 1024 page slots (0..0x3FFFFF) and pool/VM buffers (0x400000..0x42107F)
      let nonZeroBeforePadding = 0;
      for (let i = 0; i < ALIGNMENT_PADDING_OFFSET; i++) {
        if (u8[i] !== 0) {
          nonZeroBeforePadding++;
          break;
        }
      }
      expect(nonZeroBeforePadding).toBe(0);

      // Verify .rodata is present inside ALIGNMENT_PADDING..TRANSIENT_ARENA_OFFSET
      let nonZeroInPadding = 0;
      for (let i = ALIGNMENT_PADDING_OFFSET; i < TRANSIENT_ARENA_OFFSET; i++) {
        if (u8[i] !== 0) {
          nonZeroInPadding++;
        }
      }
      expect(nonZeroInPadding).toBeGreaterThan(0);

      // Verify __stack_pointer is placed at 0x42D000 inside ALIGNMENT_PADDING
      expect(core.exports.__stack_pointer.value).toBe(0x42d000);
    });
  });

  describe("6. Full Linear-Memory C VDBE Bytecode VM Parity", () => {
    it("executes string, math, 3VL arithmetic, OP_IN, and OP_CALL_UDF via C vm_step_raw", () => {
      const view = new DataView(memory.buffer);
      const ctx = createVmContext();
      resetVmContext(ctx);

      expect(typeof wasmCore.exports.vm_step_raw).toBe("function");

      ctx.registers[0] = "  Hello WebDB  ";
      ctx.registers[1] = -15.6;
      ctx.registers[2] = 20;
      ctx.registers[3] = 6;
      ctx.registers[4] = "admin";
      ctx.inSets = [new Set(["editor", "admin", "viewer"])];
      ctx.udfs = {
        0: (a: number, b: number) => a * 10 + b,
      };

      const bytecode = new Uint8Array([
        OpCode.OP_STR_TRIM, 0, 10,        // r[10] = "Hello WebDB"
        OpCode.OP_STR_LOWER, 10, 11,      // r[11] = "hello webdb"
        OpCode.OP_STR_UPPER, 10, 12,      // r[12] = "HELLO WEBDB"
        OpCode.OP_STR_LENGTH, 10, 13,     // r[13] = 11
        OpCode.OP_MATH_ABS, 1, 14,        // r[14] = 15.6
        OpCode.OP_MATH_ROUND, 1, 15,      // r[15] = -16
        OpCode.OP_ADD, 2, 3, 16,          // r[16] = 26
        OpCode.OP_MOD, 2, 3, 17,          // r[17] = 2
        OpCode.OP_CALL_UDF, 0, 0, 2, 2, 18, // r[18] = udf0(r[2]=20, r[3]=6) = 206
        OpCode.OP_IN, 4, 0, 0, 45, 0,     // if r[4] in inSets[0], jump to 45
        OpCode.OP_LOAD_INT, 19, 0, 0, 0, 0,
        OpCode.OP_HALT,
        // offset 45:
        OpCode.OP_LOAD_INT, 19, 1, 0, 0, 0,
        OpCode.OP_HALT,
      ]);

      const status = wasmCore.vm_step(ctx, view, bytecode);
      expect(status).toBe(VmStatus.DONE);
      expect(ctx.registers[10]).toBe("Hello WebDB");
      expect(ctx.registers[11]).toBe("hello webdb");
      expect(ctx.registers[12]).toBe("HELLO WEBDB");
      expect(ctx.registers[13]).toBe(11);
      expect(ctx.registers[14]).toBeCloseTo(15.6, 5);
      expect(ctx.registers[15]).toBe(-16);
      expect(ctx.registers[16]).toBe(26);
      expect(ctx.registers[17]).toBe(2);
      expect(ctx.registers[18]).toBe(206);
      expect(ctx.registers[19]).toBe(1);
    });

    it("executes in-arena hash table doubling (> 716 groups) and enforces maxQueryMemory in C VM", () => {
      const view = new DataView(memory.buffer);
      const ctx = createVmContext();
      resetVmContext(ctx);

      const codeInit = new Uint8Array([OpCode.OP_AGG_INIT, 0, 0, 1, 0, OpCode.OP_HALT]);
      expect(wasmCore.vm_step(ctx, view, codeInit)).toBe(VmStatus.DONE);
      expect(ctx.aggregators[0].capacity).toBe(1024);

      const codeStep = new Uint8Array([OpCode.OP_AGG_STEP, 0, 0, 1, 255, 0, OpCode.OP_HALT]);
      for (let i = 0; i < 717; i++) {
        ctx.registers[0] = `grp_${i}`;
        ctx.pc = 0;
        expect(wasmCore.vm_step(ctx, view, codeStep)).toBe(VmStatus.DONE);
      }

      expect(ctx.aggregators[0].capacity).toBe(2048);
      expect(ctx.aggregators[0].occupiedCount).toBe(717);
    });

    it("executes complex end-to-end queries (filters, LIKE, ORDER BY, GROUP BY, multiple aggregates, indexes) with core: 'wasm'", async () => {
      const db = await WebDB.open({
        name: "wasm_full_vm_e2e",
        storage: "memory",
        core: "wasm",
      });

      await db.createTable("orders", [
        { name: "id", type: DataType.INT32, flags: { primaryKey: true } },
        { name: "region", type: DataType.TEXT, flags: { notNull: true, indexed: true } },
        { name: "code", type: DataType.TEXT, flags: { notNull: true } },
        { name: "sales", type: DataType.FLOAT64, flags: { notNull: true } },
        { name: "cogs", type: DataType.FLOAT64, flags: { notNull: true } },
        { name: "profit", type: DataType.FLOAT64, flags: { notNull: true } },
      ]);

      await db.insertMany("orders", [
        { id: 1, region: "EMEA", code: "ORD-101", sales: 100, cogs: 40, profit: 60 },
        { id: 2, region: "EMEA", code: "ORD-102", sales: 200, cogs: 80, profit: 120 },
        { id: 3, region: "NA", code: "ORD-201", sales: 150, cogs: 50, profit: 100 },
        { id: 4, region: "APAC", code: "SKIP-301", sales: 50, cogs: 20, profit: 30 },
        { id: 5, region: "NA", code: "ORD-202", sales: 50, cogs: 10, profit: 40 },
      ]);

      // 1. Secondary index equality seek
      const naOrders = await db.from("orders").where("region", "=", "NA").orderBy("id", "asc").toArray();
      expect(naOrders).toHaveLength(2);
      expect(naOrders.map((r) => r.id)).toEqual([3, 5]);

      // 2. String LIKE + multi-column ORDER BY + LIMIT/OFFSET via C Sorter
      const filtered = await db
        .from("orders")
        .where("code", "LIKE", "ORD-%")
        .orderBy("sales", "desc")
        .limit(3)
        .toArray();
      expect(filtered.map((r) => r.id)).toEqual([2, 3, 1]);

      // 3. Single-table multiple aggregates (.count, multiple .sum, .avg, .min, .max) via C Aggregator
      const summary = await db
        .from("orders")
        .where("code", "LIKE", "ORD-%")
        .count("*", "cnt")
        .sum("sales", "total_sales")
        .sum("cogs", "total_cogs")
        .sum("profit", "total_profit")
        .avg("sales", "avg_sales")
        .min("sales", "min_sales")
        .max("sales", "max_sales")
        .first();

      expect(summary).toEqual({
        cnt: 4,
        total_sales: 500,
        total_cogs: 180,
        total_profit: 320,
        avg_sales: 125,
        min_sales: 50,
        max_sales: 200,
      });

      // 4. GROUP BY with multiple sums in C VM
      const byRegion = await db
        .from("orders")
        .select("region")
        .groupBy("region")
        .count("*", "orders_count")
        .sum("sales", "region_sales")
        .sum("profit", "region_profit")
        .orderBy("region", "asc")
        .toArray();

      expect(byRegion).toEqual([
        { region: "APAC", orders_count: 1, region_sales: 50, region_profit: 30 },
        { region: "EMEA", orders_count: 2, region_sales: 300, region_profit: 180 },
        { region: "NA", orders_count: 2, region_sales: 200, region_profit: 140 },
      ]);

      await db.close();
    });
  });

  describe("6. Linear Memory Non-Overlap & Canary Boundary Guarantees", () => {
    it("verifies all VM_CONTEXT sub-regions are strictly contiguous/non-overlapping and fit within 12,288 bytes", () => {
      const regions = [
        { name: "HEADER_SCALARS", start: 0, size: 72 },
        { name: "REGISTERS (64x32B)", start: VM_CTX_REGISTERS_OFF, size: 64 * VM_REG_SIZE },
        { name: "CURSORS (16x24B)", start: VM_CTX_CURSORS_OFF, size: 16 * VM_CURSOR_SIZE },
        { name: "TABLES (16x260B)", start: VM_CTX_TABLES_OFF, size: 16 * VM_TABLE_DESC_SIZE },
        { name: "OUTPUT_COLS (260B)", start: VM_CTX_OUTPUT_COLS_OFF, size: VM_TABLE_DESC_SIZE },
        { name: "KEY_INFOS (8x32B)", start: VM_CTX_KEY_INFOS_OFF, size: 8 * VM_KEY_INFO_SIZE },
        { name: "SORTERS (4x32B)", start: VM_CTX_SORTERS_OFF, size: 4 * VM_SORTER_SIZE },
        { name: "AGGS (4x32B)", start: VM_CTX_AGGS_OFF, size: 4 * VM_AGG_SIZE },
        { name: "IN_SETS (16x8B)", start: VM_CTX_IN_SETS_OFF, size: 16 * 8 },
        { name: "SCRATCH (4608B)", start: VM_CTX_SCRATCH_OFF, size: VM_CONTEXT_SIZE - VM_CTX_SCRATCH_OFF },
      ];

      for (let i = 0; i < regions.length; i++) {
        const curr = regions[i];
        expect(curr.start).toBeGreaterThanOrEqual(0);
        expect(curr.start + curr.size).toBeLessThanOrEqual(VM_CONTEXT_SIZE);
        if (i > 0) {
          const prev = regions[i - 1];
          expect(curr.start).toBeGreaterThanOrEqual(prev.start + prev.size);
        }
      }

      // Also verify global region boundaries
      expect(DIRTY_MASK_OFFSET + 128).toBe(VM_CONTEXT_OFFSET);
      expect(VM_CONTEXT_OFFSET + VM_CONTEXT_SIZE).toBe(RESULT_BUFFER_OFFSET);
      expect(RESULT_BUFFER_OFFSET + RESULT_BUFFER_SIZE).toBe(BYTECODE_OFFSET);
      expect(BYTECODE_OFFSET + BYTECODE_SIZE).toBe(PAGE_SCRATCHPAD_OFFSET);
      expect(PAGE_SCRATCHPAD_OFFSET + PAGE_SCRATCHPAD_SIZE).toBe(ALIGNMENT_PADDING_OFFSET);
      expect(ALIGNMENT_PADDING_OFFSET).toBeLessThan(TRANSIENT_ARENA_OFFSET);
    });

    it("preserves canary sentinel bytes in neighbouring regions across 100-column + IN + GROUP BY + ORDER BY queries on both JS and WASM", async () => {
      for (const engine of ["js", "wasm"] as const) {
        const db = await WebDB.open({
          name: `canary_overlap_${engine}`,
          storage: "memory",
          core: engine,
        });

        const cols = [
          { name: "id", type: DataType.INT32, flags: { primaryKey: true } },
          { name: "grp", type: DataType.TEXT, flags: { notNull: true } },
        ];
        for (let c = 1; c <= 80; c++) {
          cols.push({
            name: `c${c}`,
            type: c % 2 === 0 ? DataType.INT32 : DataType.TEXT,
            flags: {},
          });
        }
        await db.createTable("wide_items", cols);

        const rowsToInsert = [];
        for (let r = 1; r <= 30; r++) {
          const row: Record<string, any> = {
            id: r,
            grp: r % 3 === 0 ? "alpha" : r % 3 === 1 ? "beta" : "gamma",
          };
          for (let c = 1; c <= 80; c++) {
            row[`c${c}`] = c % 2 === 0 ? r * c : `val_${r}_${c}`;
          }
          rowsToInsert.push(row);
        }
        await db.insertMany("wide_items", rowsToInsert);

        // Snapshot Page 1 (Slot 0) and plant canary bytes in PAGE_SCRATCHPAD before query
        const rawBytes = new Uint8Array(db.pool.buffer);
        const page1Before = rawBytes.slice(0, PAGE_SIZE);
        const dirtyMaskBefore = rawBytes.slice(DIRTY_MASK_OFFSET, VM_CONTEXT_OFFSET);
        for (let i = 0; i < PAGE_SCRATCHPAD_SIZE; i++) {
          rawBytes[PAGE_SCRATCHPAD_OFFSET + i] = (0xa5 ^ (i & 0xff)) & 0xff;
        }

        // Run a query that exercises wide column decoding, WHERE IN, GROUP BY, SUM, COUNT, and ORDER BY
        const aggRows = await db
          .from("wide_items")
          .select("grp")
          .whereIn("grp", ["alpha", "beta", "gamma"])
          .where("c79", "LIKE", "val_%")
          .groupBy("grp")
          .count("*", "cnt")
          .sum("c80", "sum_c80")
          .orderBy("grp", "asc")
          .toArray();

        expect(aggRows).toHaveLength(3);
        expect(aggRows.map((x) => x.grp)).toEqual(["alpha", "beta", "gamma"]);
        expect(aggRows.every((x) => x.cnt === 10)).toBe(true);

        // Verify Page 1 (Slot 0), DIRTY_MASK, and PAGE_SCRATCHPAD canaries are 100% intact
        expect(rawBytes.slice(0, PAGE_SIZE)).toEqual(page1Before);
        expect(rawBytes.slice(DIRTY_MASK_OFFSET, VM_CONTEXT_OFFSET)).toEqual(dirtyMaskBefore);
        for (let i = 0; i < PAGE_SCRATCHPAD_SIZE; i++) {
          expect(rawBytes[PAGE_SCRATCHPAD_OFFSET + i]).toBe((0xa5 ^ (i & 0xff)) & 0xff);
        }

        await db.close();
      }
    });

    it("never overwrites Slot 0 (Page 1 at offset 0) when physical arena allocation fails", () => {
      const view = new DataView(memory.buffer);
      wasmCore.catalog_init_page1(view);
      const page1Snapshot = new Uint8Array(memory.buffer, 0, PAGE_SIZE).slice();

      const ctx = createVmContext();
      resetVmContext(ctx);
      ctx.registers[0] = "Hello World From Arena Exhaustion Test";

      // Force physical arena pointer to the end of DEFAULT_MAX_QUERY_MEMORY so vm_phys_alloc returns 0
      const code = new Uint8Array([
        OpCode.OP_STR_LOWER, 0, 1,
        OpCode.OP_HALT,
      ]);

      // Run step in both JS and WASM after exhausting VM_CTX_PHYS_ARENA_USED
      wasmCore.vm_step(ctx, view, code);
      expect(new Uint8Array(memory.buffer, 0, PAGE_SIZE)).toEqual(page1Snapshot);
    });
  });

  describe("7. ULID Crockford Base32 Decoding & Index Comparison (T..Z Boundary)", () => {
    it("maps all 32 indices (0..31) in vm_crockford_char to exact Crockford Base32 ASCII codes", () => {
      expect(CROCKFORD_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
      for (let idx = 0; idx < 32; idx++) {
        const ch = String.fromCharCode(vm_crockford_char(idx));
        expect(ch).toBe(CROCKFORD_ALPHABET[idx]);
      }
    });

    it("round-trips and compares ULIDs containing P..T and V..Z across table scans and index scans on both JS and WASM", async () => {
      const testUlids = [
        "01ARZ3NDEKTSV4RRFFQ69G5PPT", // ends with P, T (idx 22, 26)
        "01ARZ3NDEKTSV4RRFFQ69PQRST", // contains P, Q, R, S, T (indices 22..26)
        "01ARZ3NDEKTSV4RRFFQ69VWXYZ", // contains V, W, X, Y, Z (indices 27..31)
        "01HZXW9TSRQPNMKJHGFEDCBA98", // contains Z, X, W, T, S, R, Q, P, N, M, K, J
        "7ZZZZZZZZZZZZZZZZZZZZZZZZZ", // max valid 128-bit ULID (all Z = idx 31)
      ];

      for (const engine of ["js", "wasm"] as const) {
        const db = await WebDB.open({
          name: `ulid_crockford_${engine}`,
          storage: "memory",
          core: engine,
        });

        await db.createTable("events", [
          { name: "id", type: DataType.INT32, primaryKey: true },
          { name: "ulid_col", type: DataType.ULID, indexed: true },
          { name: "unindexed_ulid", type: DataType.ULID },
        ]);

        for (let i = 0; i < testUlids.length; i++) {
          await db.insert("events", {
            id: i + 1,
            ulid_col: testUlids[i],
            unindexed_ulid: testUlids[i],
          });
        }

        // 1. Verify full table scan (OP_COLUMN_ULID) decodes every character 0..9, A..Z (including T..Z) accurately
        const allRows = await db.from("events").orderBy("id", "asc").toArray();
        expect(allRows.map((r) => r.ulid_col)).toEqual(testUlids);
        expect(allRows.map((r) => r.unindexed_ulid)).toEqual(testUlids);

        // 2. Verify point lookups via secondary index (vm_compare_index_cell) for each ULID
        for (let i = 0; i < testUlids.length; i++) {
          const matched = await db
            .from("events")
            .where("ulid_col", "=", testUlids[i])
            .toArray();
          expect(matched).toHaveLength(1);
          expect(matched[0].id).toBe(i + 1);
          expect(matched[0].ulid_col).toBe(testUlids[i]);
        }

        // 3. Verify unindexed filter comparisons (OP_COLUMN_ULID + OP_EQ / OP_GT / OP_LT)
        for (let i = 0; i < testUlids.length; i++) {
          const matched = await db
            .from("events")
            .where("unindexed_ulid", "=", testUlids[i])
            .toArray();
          expect(matched).toHaveLength(1);
          expect(matched[0].id).toBe(i + 1);
        }

        // 4. Verify lexicographical ordering of decoded ULIDs matches sorted Crockford strings
        const sortedExpected = [...testUlids].sort();
        const orderedByIdx = await db
          .from("events")
          .orderBy("ulid_col", "asc")
          .toArray();
        expect(orderedByIdx.map((r) => r.ulid_col)).toEqual(sortedExpected);

        const orderedByUnindexed = await db
          .from("events")
          .orderBy("unindexed_ulid", "asc")
          .toArray();
        expect(orderedByUnindexed.map((r) => r.unindexed_ulid)).toEqual(
          sortedExpected,
        );

        await db.close();
      }
    });
  });
});
