import "fake-indexeddb/auto";
import { describe, it, expect, assert } from "vitest";
import { createVmContext, resetVmContext } from "../src/shared/index.js";
import {
  vm_step,
  sql_like_match,
  compare_sorter_keys,
  page_init,
  page_insert_row,
  page_serialize_row,
  page_deserialize_row,
  page_set_next_page_id,
} from "../src/core/index.js";
import { compileQuery } from "../src/host/compiler/compiler.js";
import {
  DataType,
  ColumnFlag,
  TableMeta,
  OpCode,
  VmStatus,
  TooManyOrderByColumnsError,
  TooManyGroupByColumnsError,
} from "../src/types/index.js";
import {
  TOTAL_MEMORY_BYTES,
  RESULT_BUFFER_OFFSET,
  RESULT_BUFFER_SIZE,
  PAGE_SIZE,
} from "../src/constants.js";
import { WebDB } from "../src/host/api/webdb.js";
import { Io } from "../src/host/storage/io.js";
import { MemoryVfsAdapter } from "../src/host/storage/memory.js";
import {
  BufferPoolDriver,
  createWasmMemory,
} from "../src/host/driver/buffer_pool_driver.js";

describe("VDBE Execution Engine - Milestones 1-4 (tests/vdbe_engine.test.ts)", () => {
  const testTable: TableMeta = {
    tableId: 1,
    flags: 1,
    rootPageId: 2,
    colCatalogPageId: 0,
    columnCount: 3,
    rowCountEstimate: 0,
    autoIncNext: 1n,
    name: "items",
    columns: [
      {
        type: DataType.INT32,
        flags: ColumnFlag.PRIMARY_KEY,
        colOffset: 0,
        name: "id",
      },
      {
        type: DataType.TEXT,
        flags: ColumnFlag.NONE,
        colOffset: 0,
        name: "name",
      },
      {
        type: DataType.FLOAT64,
        flags: ColumnFlag.NONE,
        colOffset: 4,
        name: "val",
      },
    ],
  };

  describe("Milestone 1 & 2: 3-Valued Logic (3VL) & Register Comparisons", () => {
    it("evaluates NULL comparisons as UNKNOWN and never jumps on =, !=, <, <=, >, >=", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      page_init(view, 4096);

      const ctx = createVmContext();
      resetVmContext(ctx, testTable);

      // Bytecode layout:
      // 0..1: OP_LOAD_NULL r[0]
      // 2..3: OP_LOAD_NULL r[1]
      // 4..9: OP_LOAD_INT r[2] = 10
      // 10..41: 8 comparison opcodes with target = 43 (target is within [0, code_len])
      // 42: OP_HALT
      // 43..48: OP_LOAD_INT r[3] = 999 (should NEVER execute because 3VL comparisons are UNKNOWN)
      // 49: OP_HALT
      const bytecode = new Uint8Array([
        OpCode.OP_LOAD_NULL,
        0, // 0..1: r[0] = NULL
        OpCode.OP_LOAD_NULL,
        1, // 2..3: r[1] = NULL
        OpCode.OP_LOAD_INT,
        2,
        10,
        0,
        0,
        0, // 4..9: r[2] = 10

        OpCode.OP_EQ,
        0,
        1,
        51,
        0, // 10..14: NULL == NULL -> no jump
        OpCode.OP_NE,
        0,
        1,
        51,
        0, // 15..19: NULL != NULL -> no jump
        OpCode.OP_LT,
        0,
        2,
        51,
        0, // 20..24: NULL < 10 -> no jump
        OpCode.OP_GT,
        0,
        2,
        51,
        0, // 25..29: NULL > 10 -> no jump
        OpCode.OP_LE,
        0,
        2,
        51,
        0, // 30..34: NULL <= 10 -> no jump
        OpCode.OP_GE,
        0,
        2,
        51,
        0, // 35..39: NULL >= 10 -> no jump
        OpCode.OP_EQ,
        2,
        0,
        51,
        0, // 40..44: 10 == NULL -> no jump
        OpCode.OP_NE,
        2,
        0,
        51,
        0, // 45..49: 10 != NULL -> no jump

        OpCode.OP_HALT, // 50: Expected halt!

        OpCode.OP_LOAD_INT,
        3,
        231,
        3,
        0,
        0, // 51..56: r[3] = 999 (fail trap)
        OpCode.OP_HALT, // 57
      ]);

      const status = vm_step(ctx, view, bytecode);
      expect(status).toBe(VmStatus.DONE);
      expect(ctx.pc).toBe(51);
      expect(ctx.registers[3]).toBeNull();
    });

    it("jumps on TRUE comparisons and falls through on FALSE for non-null values", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      page_init(view, 4096);

      const ctx = createVmContext();
      resetVmContext(ctx, testTable);

      // Load r[0] = 10, r[1] = 20
      // OP_LT r[0], r[1] -> jumps to target (pass)
      // If it falls through, it hits OP_LOAD_INT r[3] = 99
      const bytecode = new Uint8Array([
        OpCode.OP_LOAD_INT,
        0,
        10,
        0,
        0,
        0, // 0..5
        OpCode.OP_LOAD_INT,
        1,
        20,
        0,
        0,
        0, // 6..11
        OpCode.OP_LT,
        0,
        1,
        23,
        0, // 12..16: 10 < 20 -> jump to 23
        OpCode.OP_LOAD_INT,
        3,
        99,
        0,
        0,
        0, // 17..22: should be skipped!
        OpCode.OP_HALT, // 23
      ]);

      const status = vm_step(ctx, view, bytecode);
      expect(status).toBe(VmStatus.DONE);
      expect(ctx.registers[3]).toBeNull();
    });

    it("handles OP_IS_NULL and OP_IS_NOT_NULL testing null-bitmap directly", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      page_init(view, 4096);

      // Row 1: id=1, name=null, val=10.5
      // Row 2: id=2, name='hello', val=null
      const r1 = page_serialize_row(testTable, {
        id: 1,
        name: null,
        val: 10.5,
      });
      const r2 = page_serialize_row(testTable, {
        id: 2,
        name: "hello",
        val: null,
      });
      page_insert_row(view, 4096, r1);
      page_insert_row(view, 4096, r2);

      // Query: WHERE name IS NULL
      const bytecodeNull = compileQuery({
        table: testTable,
        filters: [{ type: "null", colName: "name", isNull: true }],
      });

      const ctx1 = createVmContext();
      resetVmContext(ctx1, testTable);
      const status1 = vm_step(ctx1, view, bytecodeNull);
      expect(status1).toBe(VmStatus.DONE);
      expect(ctx1.resultCount).toBe(1);

      // Query: WHERE name IS NOT NULL
      const bytecodeNotNull = compileQuery({
        table: testTable,
        filters: [{ type: "null", colName: "name", isNull: false }],
      });

      const ctx2 = createVmContext();
      resetVmContext(ctx2, testTable);
      const status2 = vm_step(ctx2, view, bytecodeNotNull);
      expect(status2).toBe(VmStatus.DONE);
      expect(ctx2.resultCount).toBe(1);
    });
  });

  describe("Milestone 3: Buffer Pool Integration & Page Faults", () => {
    it("yields STATUS_PAGE_FAULT when next page is not resident, and resumes cleanly after acquirePage", async () => {
      const vfs = new MemoryVfsAdapter();
      const memory = createWasmMemory();
      const view = new DataView(memory.buffer);
      const io = new Io({ vfs, memory });
      const driver = new BufferPoolDriver({ io, memory });

      // Page 1 is catalog
      await driver.acquirePage(1);

      // Page 2: items root page with 2 rows, linked to Page 3
      const slot2 = await driver.acquirePage(2);
      const page2Offset = slot2 * PAGE_SIZE;
      page_init(view, page2Offset);
      page_insert_row(
        view,
        page2Offset,
        page_serialize_row(testTable, { id: 1, name: "item1", val: 1.0 }),
      );
      page_insert_row(
        view,
        page2Offset,
        page_serialize_row(testTable, { id: 2, name: "item2", val: 2.0 }),
      );
      page_set_next_page_id(view, page2Offset, 3);
      driver.markDirty(slot2);
      await driver.flushPage(2);

      // Page 3: second page with 2 rows, linked to 0 (EOF)
      const slot3 = await driver.acquirePage(3);
      const page3Offset = slot3 * PAGE_SIZE;
      page_init(view, page3Offset);
      page_insert_row(
        view,
        page3Offset,
        page_serialize_row(testTable, { id: 3, name: "item3", val: 3.0 }),
      );
      page_insert_row(
        view,
        page3Offset,
        page_serialize_row(testTable, { id: 4, name: "item4", val: 4.0 }),
      );
      page_set_next_page_id(view, page3Offset, 0);
      driver.markDirty(slot3);
      await driver.flushPage(3);

      // Evict Page 3 from the buffer pool so it is NOT resident
      driver.unassignSlot(slot3);
      expect(driver.getAssignedPage(slot3)).toBe(0);

      // Compile scan query over testTable
      const bytecode = compileQuery({
        table: testTable,
        filters: [],
      });

      const ctx = createVmContext();
      resetVmContext(ctx, testTable);

      // Step 1: should process Page 2 (2 rows) then hit Page 3 (missing) -> PAGE_FAULT
      const status1 = vm_step(ctx, view, bytecode);
      expect(status1).toBe(VmStatus.PAGE_FAULT);
      expect(ctx.fault_page_id).toBe(3);
      expect(ctx.resultCount).toBe(2);

      // Step 2: Host loads Page 3 into buffer pool
      await driver.acquirePage(ctx.fault_page_id);
      ctx.status = VmStatus.RUNNING;

      // Step 3: Resume VM step -> finishes scanning Page 3
      const status2 = vm_step(ctx, view, bytecode);
      expect(status2).toBe(VmStatus.DONE);
      expect(ctx.resultCount).toBe(4);
    });
  });

  describe("Milestone 4: Chunked Pull Iterator & Result Buffer Streaming", () => {
    it("yields STATUS_BUFFER_FULL on 64KB boundary and correctly drains all rows in chunks", async () => {
      const db = await WebDB.open({ name: "chunking_test", storage: "memory" });

      await db.createTable("records", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "payload", type: "TEXT" },
      ]);

      // Insert 2,200 rows with 40-byte text.
      // Total size: ~2,200 * (4 + 40 + overhead ~50) = ~110,000 bytes > 64KB RESULT_BUFFER_SIZE.
      const totalRows = 2200;
      for (let i = 1; i <= totalRows; i++) {
        await db.insert("records", {
          id: i,
          payload: `Chunking test row payload #${i} for 64KB streaming verification`,
        });
      }

      // Query all rows
      const results = await db.from("records").toArray();

      expect(results).toHaveLength(totalRows);
      expect(results[0].id).toBe(1);
      expect(results[totalRows - 1].id).toBe(totalRows);

      // Verify sequence is strictly monotonic with zero lost rows
      for (let i = 0; i < totalRows; i++) {
        expect(results[i].id).toBe(i + 1);
      }
    });

    it("direct OP_EMIT_ROW rewinds PC on buffer full so instruction resumes without dropping the row", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      page_init(view, 4096);

      const r1 = page_serialize_row(testTable, { id: 1, name: "A", val: 1.0 });
      page_insert_row(view, 4096, r1);

      const ctx = createVmContext();
      resetVmContext(ctx, testTable);

      // Artificially simulate result buffer nearly full:
      // Leave only 5 bytes free, but serialized row is ~25 bytes
      ctx.resultOffset = RESULT_BUFFER_SIZE - 5;

      const bytecode = new Uint8Array([
        OpCode.OP_OPEN_CURSOR,
        0,
        2,
        0,
        0,
        0, // 0..5
        OpCode.OP_REWIND,
        0,
        12,
        0, // 6..9: jump to 12 if empty
        OpCode.OP_EMIT_ROW,
        0, // 10..11
        OpCode.OP_HALT, // 12
      ]);

      // Step: should return BUFFER_FULL
      const status1 = vm_step(ctx, view, bytecode);
      expect(status1).toBe(VmStatus.BUFFER_FULL);
      // PC should point back to OP_EMIT_ROW (index 10)
      expect(ctx.pc).toBe(10);

      // Host drains result buffer: reset offset
      ctx.resultOffset = 0;
      ctx.status = VmStatus.RUNNING;

      // Resume step
      const status2 = vm_step(ctx, view, bytecode);
      expect(status2).toBe(VmStatus.DONE);
      expect(ctx.resultCount).toBe(1);
    });
  });

  describe("Edge Cases & Defensive Guards (Section 6)", () => {
    it("aborts infinite loop with QueryTimeoutError (cycle limit)", async () => {
      const infiniteBytecode = new Uint8Array([OpCode.OP_JUMP, 0x00, 0x00]);

      const ctx = createVmContext();
      resetVmContext(ctx);

      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);

      const status = vm_step(ctx, view, infiniteBytecode);
      expect(status).toBe(VmStatus.TIMEOUT);
    });

    it("aborts with STATUS_INVALID_BYTECODE on out-of-bounds jump target or corrupt opcode", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);

      const ctx = createVmContext();
      resetVmContext(ctx);

      // Jump target 999 exceeds bytecode length
      const invalidJumpBytecode = new Uint8Array([
        OpCode.OP_JUMP,
        0xe7,
        0x03, // jump 999
      ]);

      const status1 = vm_step(ctx, view, invalidJumpBytecode);
      expect(status1).toBe(VmStatus.INVALID_BYTECODE);

      // Corrupt opcode 0xFE
      const corruptOpcodeBytecode = new Uint8Array([0xfe]);
      resetVmContext(ctx);
      const status2 = vm_step(ctx, view, corruptOpcodeBytecode);
      expect(status2).toBe(VmStatus.INVALID_BYTECODE);
    });

    it("supports OP_LAST and OP_PREV_ROW reverse scans", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      page_init(view, 4096);

      const r1 = page_serialize_row(testTable, {
        id: 1,
        name: "First",
        val: 1.0,
      });
      const r2 = page_serialize_row(testTable, {
        id: 2,
        name: "Second",
        val: 2.0,
      });
      const r3 = page_serialize_row(testTable, {
        id: 3,
        name: "Third",
        val: 3.0,
      });
      page_insert_row(view, 4096, r1);
      page_insert_row(view, 4096, r2);
      page_insert_row(view, 4096, r3);

      const ctx = createVmContext();
      resetVmContext(ctx, testTable);

      const bytecode = new Uint8Array([
        OpCode.OP_OPEN_CURSOR,
        0,
        2,
        0,
        0,
        0, // 0..5
        OpCode.OP_LAST,
        0,
        17,
        0, // 6..9: jump to 17 if empty
        // loop at offset 10:
        OpCode.OP_EMIT_ROW,
        0, // 10..11
        OpCode.OP_PREV_ROW,
        0,
        17,
        0, // 12..14 (3 bytes: op, cur, target u16 -> 12, 13, 14..15)
        OpCode.OP_JUMP,
        10,
        0, // 16..18: jump to 10
        OpCode.OP_HALT, // 19
      ]);
      // Operands:
      // OP_OPEN_CURSOR (5 bytes): op(0), cur(1), page(2,3,4,5) -> len 6
      // OP_LAST (3 bytes): op(6), cur(7), target(8,9) -> len 4
      // loop starts at index 10
      // OP_EMIT_ROW (1 byte): op(10), cur(11) -> len 2
      // OP_PREV_ROW (3 bytes): op(12), cur(13), target(14,15) -> len 4
      // OP_JUMP (2 bytes): op(16), target(17,18) -> len 3
      // OP_HALT: op(19) -> len 1
      bytecode[8] = 19;
      bytecode[9] = 0;
      bytecode[14] = 19;
      bytecode[15] = 0;

      const status = vm_step(ctx, view, bytecode);
      expect(status).toBe(VmStatus.DONE);
      expect(ctx.resultCount).toBe(3);

      // Verify records emitted in reverse order (3, 2, 1)
      let offset = RESULT_BUFFER_OFFSET;
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        const rowLen = view.getUint16(offset, true);
        const row = page_deserialize_row(testTable.columns, view, offset + 2);
        ids.push(row.id as number);
        offset += 2 + rowLen;
      }
      expect(ids).toEqual([3, 2, 1]);
    });
  });

  describe("Native String Operations (LIKE, CONTAINS, STARTS_WITH, ENDS_WITH, Transforms)", () => {
    it("sql_like_match correctly evaluates wildcards % and _ case-insensitively", () => {
      // % matches zero or more
      expect(sql_like_match("hello", "h%o")).toBe(true);
      expect(sql_like_match("ho", "h%o")).toBe(true);
      expect(sql_like_match("HELLO", "h%o")).toBe(true);
      expect(sql_like_match("world", "h%o")).toBe(false);
      expect(sql_like_match("phone", "%hon%")).toBe(true);

      // _ matches exactly one character
      expect(sql_like_match("hello", "h_llo")).toBe(true);
      expect(sql_like_match("hallo", "h_llo")).toBe(true);
      expect(sql_like_match("hllo", "h_llo")).toBe(false);

      // empty string
      expect(sql_like_match("", "%")).toBe(true);
      expect(sql_like_match("", "")).toBe(true);
      expect(sql_like_match("a", "")).toBe(false);
    });

    it("executes OP_STR_LIKE, OP_STR_NOT_LIKE, OP_STR_CONTAINS, OP_STR_STARTS_WITH, OP_STR_ENDS_WITH", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      const ctx = createVmContext();
      resetVmContext(ctx);

      // r[0] = "Apple iPhone 15"
      // r[1] = "%iPhone%"
      // r[2] = "Apple"
      // r[3] = "15"
      // r[4] = "Pixel"
      // r[5] = NULL
      ctx.registers[0] = "Apple iPhone 15";
      ctx.registers[1] = "%iPhone%";
      ctx.registers[2] = "Apple";
      ctx.registers[3] = "15";
      ctx.registers[4] = "Pixel";
      ctx.registers[5] = null;

      // 1. LIKE: r[0] LIKE r[1] -> jump to target 6 (pc becomes 7 after OP_HALT at 6)
      const codeLike = new Uint8Array([
        OpCode.OP_STR_LIKE,
        0,
        1,
        6,
        0, // bytes 0..4
        OpCode.OP_HALT, // byte 5 (fallthrough)
        OpCode.OP_HALT, // byte 6 (jumped)
      ]);
      expect(vm_step(ctx, view, codeLike)).toBe(VmStatus.DONE);
      expect(ctx.pc).toBe(7);

      // 2. CONTAINS: r[0] CONTAINS r[4] ("Pixel") -> does NOT jump, halts at byte 5 (pc = 6)
      ctx.pc = 0;
      const codeContainsFail = new Uint8Array([
        OpCode.OP_STR_CONTAINS,
        0,
        4,
        6,
        0,
        OpCode.OP_HALT,
        OpCode.OP_HALT,
      ]);
      expect(vm_step(ctx, view, codeContainsFail)).toBe(VmStatus.DONE);
      expect(ctx.pc).toBe(6); // executed fallthrough OP_HALT at 5

      // 3. STARTS_WITH: r[0] STARTS_WITH r[2] ("Apple") -> jumps to 6 (pc = 7)
      ctx.pc = 0;
      const codeStarts = new Uint8Array([
        OpCode.OP_STR_STARTS_WITH,
        0,
        2,
        6,
        0,
        OpCode.OP_HALT,
        OpCode.OP_HALT,
      ]);
      expect(vm_step(ctx, view, codeStarts)).toBe(VmStatus.DONE);
      expect(ctx.pc).toBe(7);

      // 4. ENDS_WITH: r[0] ENDS_WITH r[3] ("15") -> jumps to 6 (pc = 7)
      ctx.pc = 0;
      const codeEnds = new Uint8Array([
        OpCode.OP_STR_ENDS_WITH,
        0,
        3,
        6,
        0,
        OpCode.OP_HALT,
        OpCode.OP_HALT,
      ]);
      expect(vm_step(ctx, view, codeEnds)).toBe(VmStatus.DONE);
      expect(ctx.pc).toBe(7);

      // 5. 3VL on NULL: r[0] LIKE r[5] (NULL) -> UNKNOWN, does NOT jump, halts at 5 (pc = 6)
      ctx.pc = 0;
      const codeNull = new Uint8Array([
        OpCode.OP_STR_LIKE,
        0,
        5,
        6,
        0,
        OpCode.OP_HALT,
        OpCode.OP_HALT,
      ]);
      expect(vm_step(ctx, view, codeNull)).toBe(VmStatus.DONE);
      expect(ctx.pc).toBe(6);
    });

    it("executes string scalar transformations OP_STR_LOWER, OP_STR_UPPER, OP_STR_LENGTH, OP_STR_SUBSTR", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      const ctx = createVmContext();
      resetVmContext(ctx);

      ctx.registers[0] = "Hello World";
      ctx.registers[1] = 1; // start index 1 (1-indexed)
      ctx.registers[2] = 5; // length 5

      const codeTransforms = new Uint8Array([
        OpCode.OP_STR_LOWER,
        0,
        10, // r[10] = lower(r[0]) -> "hello world"
        OpCode.OP_STR_UPPER,
        0,
        11, // r[11] = upper(r[0]) -> "HELLO WORLD"
        OpCode.OP_STR_LENGTH,
        0,
        12, // r[12] = length(r[0]) -> 11
        OpCode.OP_STR_SUBSTR,
        0,
        1,
        2,
        13, // r[13] = substr(r[0], 1, 5) -> "Hello"
        OpCode.OP_HALT,
      ]);

      const status = vm_step(ctx, view, codeTransforms);
      expect(status).toBe(VmStatus.DONE);
      expect(ctx.registers[10]).toBe("hello world");
      expect(ctx.registers[11]).toBe("HELLO WORLD");
      expect(ctx.registers[12]).toBe(11);
      expect(ctx.registers[13]).toBe("Hello");
    });

    it("filters end-to-end with WebDB using LIKE, NOT LIKE, STARTS_WITH, ENDS_WITH, CONTAINS", async () => {
      const db = await WebDB.open({
        name: "string_e2e_test",
        storage: "memory",
      });

      await db.createTable("gadgets", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "name", type: "TEXT" },
      ]);

      await db.insert("gadgets", { id: 1, name: "Apple iPhone 15 Pro" });
      await db.insert("gadgets", { id: 2, name: "Google Pixel 8 Pro" });
      await db.insert("gadgets", { id: 3, name: "Samsung Galaxy S24 Ultra" });
      await db.insert("gadgets", { id: 4, name: "Apple iPad Air" });

      // LIKE '%iPhone%'
      const iphones = await db
        .from("gadgets")
        .where("name", "LIKE", "%iPhone%")
        .toArray();
      expect(iphones).toHaveLength(1);
      expect(iphones[0].name).toBe("Apple iPhone 15 Pro");

      // STARTS_WITH 'Apple'
      const apples = await db
        .from("gadgets")
        .where("name", "STARTS_WITH", "Apple")
        .toArray();
      expect(apples).toHaveLength(2);
      expect(apples.map((g) => g.id)).toEqual([1, 4]);

      // LIKE 'Apple%'
      const applesLike = await db
        .from("gadgets")
        .where("name", "LIKE", "Apple%")
        .toArray();
      expect(applesLike).toHaveLength(2);
      expect(applesLike.map((g) => g.id)).toEqual([1, 4]);

      // ENDS_WITH 'Pro'
      const pros = await db
        .from("gadgets")
        .where("name", "ENDS_WITH", "Pro")
        .toArray();
      expect(pros).toHaveLength(2);
      expect(pros.map((g) => g.id)).toEqual([1, 2]);

      // CONTAINS 'Galaxy'
      const galaxy = await db
        .from("gadgets")
        .where("name", "CONTAINS", "Galaxy")
        .toArray();
      expect(galaxy).toHaveLength(1);
      expect(galaxy[0].id).toBe(3);

      // NOT LIKE 'Apple%'
      const nonApples = await db
        .from("gadgets")
        .where("name", "NOT LIKE", "Apple%")
        .toArray();
      expect(nonApples).toHaveLength(2);
      expect(nonApples.map((g) => g.id)).toEqual([2, 3]);
    });
  });

  describe("Milestone 5: In-Arena Sorter (ORDER BY) & Aggregations (GROUP BY + COUNT, SUM, AVG, MIN, MAX)", () => {
    it("enforces multi-column KeyInfo collation with SQLite NULL semantics (NULLS_FIRST/LAST)", () => {
      // 1. ASC: NULL is smaller than non-null -> NULLS_FIRST (cmp = -1)
      expect(
        compare_sorter_keys([null], [10], {
          numKeys: 1,
          directions: [0],
          nullOrders: [0],
        }),
      ).toBe(-1);
      expect(
        compare_sorter_keys([10], [null], {
          numKeys: 1,
          directions: [0],
          nullOrders: [0],
        }),
      ).toBe(1);

      // 2. DESC: NULL is smaller than non-null -> in DESC, NULL comes last (cmp = 1)
      expect(
        compare_sorter_keys([null], [10], {
          numKeys: 1,
          directions: [1],
          nullOrders: [1],
        }),
      ).toBe(1);
      expect(
        compare_sorter_keys([10], [null], {
          numKeys: 1,
          directions: [1],
          nullOrders: [1],
        }),
      ).toBe(-1);

      // 3. Explicit NULLS_LAST override on ASC
      expect(
        compare_sorter_keys([null], [10], {
          numKeys: 1,
          directions: [0],
          nullOrders: [1],
        }),
      ).toBe(1);

      // 4. Both NULL -> equal for this column
      expect(
        compare_sorter_keys([null, "alpha"], [null, "beta"], {
          numKeys: 2,
          directions: [0, 0],
          nullOrders: [0, 0],
        }),
      ).toBe(-1);

      // 5. Multi-column priority: col 1 ASC, col 2 DESC
      const keyInfo = {
        numKeys: 2,
        directions: [0, 1], // col 0 ASC, col 1 DESC
        nullOrders: [0, 1],
      };
      // Different col 0 -> col 0 decides ("Dept A" < "Dept B")
      expect(
        compare_sorter_keys(["Dept A", 100], ["Dept B", 50], keyInfo),
      ).toBe(-1);
      // Same col 0 -> col 1 decides in DESC (200 > 100 -> -1 in DESC)
      expect(
        compare_sorter_keys(["Dept A", 200], ["Dept A", 100], keyInfo),
      ).toBe(-1);
      expect(
        compare_sorter_keys(["Dept A", 100], ["Dept A", 200], keyInfo),
      ).toBe(1);
    });

    it("enforces hard compile-time ceilings: max 8 sort columns and max 8 grouping columns", () => {
      const dummyTable: TableMeta = {
        tableId: 1,
        flags: 1,
        rootPageId: 2,
        colCatalogPageId: 0,
        columnCount: 1,
        rowCountEstimate: 0,
        autoIncNext: 1n,
        name: "test",
        columns: [
          {
            name: "c",
            type: DataType.INT32,
            flags: ColumnFlag.NONE,
            colOffset: 0,
          },
        ],
      };

      // 9 sort columns -> throws TooManyOrderByColumnsError
      expect(() =>
        compileQuery({
          table: dummyTable,
          filters: [],
          orderBy: Array.from({ length: 9 }, () => ({ colName: "c" })),
        }),
      ).toThrow(TooManyOrderByColumnsError);

      // 8 sort columns -> succeeds
      expect(() =>
        compileQuery({
          table: dummyTable,
          filters: [],
          orderBy: Array.from({ length: 8 }, () => ({ colName: "c" })),
        }),
      ).not.toThrow();

      // 9 group columns -> throws TooManyGroupByColumnsError
      expect(() =>
        compileQuery({
          table: dummyTable,
          filters: [],
          groupBy: Array.from({ length: 9 }, () => "c"),
        }),
      ).toThrow(TooManyGroupByColumnsError);

      // 8 group columns -> succeeds
      expect(() =>
        compileQuery({
          table: dummyTable,
          filters: [],
          groupBy: Array.from({ length: 8 }, () => "c"),
        }),
      ).not.toThrow();
    });

    it("sorts rows in-arena using OP_SORTER_OPEN, OP_SORTER_INSERT, OP_SORTER_SORT, OP_SORTER_NEXT", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);

      const tableMeta: TableMeta = {
        tableId: 10,
        flags: 1,
        rootPageId: 2,
        colCatalogPageId: 0,
        columnCount: 3,
        rowCountEstimate: 0,
        autoIncNext: 5n,
        name: "scores",
        columns: [
          {
            name: "id",
            type: DataType.INT32,
            flags: ColumnFlag.PRIMARY_KEY,
            colOffset: 0,
          },
          {
            name: "name",
            type: DataType.TEXT,
            flags: ColumnFlag.NONE,
            colOffset: 0,
          },
          {
            name: "score",
            type: DataType.FLOAT64,
            flags: ColumnFlag.NONE,
            colOffset: 0,
          },
        ],
      };

      page_init(view, 4096);

      // Insert unsorted rows with a NULL score
      const rowsToInsert = [
        { id: 1, name: "Charlie", score: 50.5 },
        { id: 2, name: "Alice", score: 98.0 },
        { id: 3, name: "Dave", score: null },
        { id: 4, name: "Bob", score: 75.0 },
      ];

      for (const r of rowsToInsert) {
        const serialized = page_serialize_row(tableMeta.columns, r);
        page_insert_row(view, 4096, serialized);
      }

      // Compile query: ORDER BY score ASC (Dave/NULL should be first, then Charlie 50.5, Bob 75.0, Alice 98.0)
      const plan = {
        table: tableMeta,
        filters: [],
        keyInfos: [],
        orderBy: [{ colName: "score", direction: "asc" as const }],
      };
      const bytecode = compileQuery(plan);

      const ctx = createVmContext();
      resetVmContext(ctx, tableMeta);
      ctx.keyInfos = plan.keyInfos ?? [];

      const status = vm_step(ctx, view, bytecode);
      expect(status).toBe(VmStatus.DONE);
      expect(ctx.resultCount).toBe(4);

      // Hydrate emitted rows
      const hydrated: any[] = [];
      let offset = 0;
      for (let i = 0; i < ctx.resultCount; i++) {
        const rowLen = view.getUint16(RESULT_BUFFER_OFFSET + offset, true);
        const record = page_deserialize_row(
          tableMeta.columns,
          view,
          RESULT_BUFFER_OFFSET + offset + 2,
        );
        hydrated.push(record);
        offset += 2 + rowLen;
      }

      expect(hydrated.map((r) => r.name)).toEqual([
        "Dave",
        "Charlie",
        "Bob",
        "Alice",
      ]);
      expect(hydrated[0].score).toBeNull();
      expect(hydrated[1].score).toBe(50.5);
      expect(hydrated[2].score).toBe(75.0);
      expect(hydrated[3].score).toBe(98.0);
    });

    it("executes in-arena hash aggregations (GROUP BY + COUNT, SUM, AVG, MIN, MAX) with NULL group collapsing", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);

      const tableMeta: TableMeta = {
        tableId: 20,
        flags: 1,
        rootPageId: 2,
        colCatalogPageId: 0,
        columnCount: 3,
        rowCountEstimate: 0,
        autoIncNext: 7n,
        name: "employees",
        columns: [
          {
            name: "id",
            type: DataType.INT32,
            flags: ColumnFlag.PRIMARY_KEY,
            colOffset: 0,
          },
          {
            name: "dept",
            type: DataType.TEXT,
            flags: ColumnFlag.NONE,
            colOffset: 0,
          },
          {
            name: "salary",
            type: DataType.FLOAT64,
            flags: ColumnFlag.NONE,
            colOffset: 0,
          },
        ],
      };

      page_init(view, 4096);

      const dataset = [
        { id: 1, dept: "Eng", salary: 100.0 },
        { id: 2, dept: "Eng", salary: 200.0 },
        { id: 3, dept: "HR", salary: 50.0 },
        { id: 4, dept: "Eng", salary: 300.0 },
        { id: 5, dept: null, salary: 80.0 },
        { id: 6, dept: null, salary: 120.0 },
      ];

      for (const r of dataset) {
        const serialized = page_serialize_row(tableMeta.columns, r);
        page_insert_row(view, 4096, serialized);
      }

      const plan = {
        table: tableMeta,
        filters: [],
        groupBy: ["dept"],
        aggregates: [
          { func: "count" as const, colName: "*", alias: "count" },
          { func: "sum" as const, colName: "salary", alias: "total" },
          { func: "avg" as const, colName: "salary", alias: "average" },
          { func: "min" as const, colName: "salary", alias: "min_sal" },
          { func: "max" as const, colName: "salary", alias: "max_sal" },
        ],
      };

      const bytecode = compileQuery(plan);
      const ctx = createVmContext();
      resetVmContext(ctx, tableMeta);
      ctx.outputColumns = (bytecode as any).outputColumns;

      const status = vm_step(ctx, view, bytecode);
      expect(status).toBe(VmStatus.DONE);
      expect(ctx.resultCount).toBe(3); // "Eng", "HR", and null (all NULL dept rows collapse to single bucket!)

      // Use output columns for deserialization
      const outputCols = (bytecode as any).outputColumns;

      const groups: any[] = [];
      let offset = 0;
      for (let i = 0; i < ctx.resultCount; i++) {
        const rowLen = view.getUint16(RESULT_BUFFER_OFFSET + offset, true);
        const record = page_deserialize_row(
          outputCols,
          view,
          RESULT_BUFFER_OFFSET + offset + 2,
        );
        groups.push(record);
        offset += 2 + rowLen;
      }

      const eng = groups.find((g) => g.dept === "Eng");
      expect(eng).toBeDefined();
      expect(eng.count).toBe(3);
      expect(eng.total).toBe(600.0);
      expect(eng.average).toBe(200.0);
      expect(eng.min_sal).toBe(100.0);
      expect(eng.max_sal).toBe(300.0);

      const hr = groups.find((g) => g.dept === "HR");
      expect(hr).toBeDefined();
      expect(hr.count).toBe(1);
      expect(hr.total).toBe(50.0);
      expect(hr.average).toBe(50.0);
      expect(hr.min_sal).toBe(50.0);
      expect(hr.max_sal).toBe(50.0);

      const nullGroup = groups.find(
        (g) => g.dept === null || g.dept === undefined,
      );
      expect(nullGroup).toBeDefined();
      expect(nullGroup.count).toBe(2);
      expect(nullGroup.total).toBe(200.0);
      expect(nullGroup.average).toBe(100.0);
      expect(nullGroup.min_sal).toBe(80.0);
      expect(nullGroup.max_sal).toBe(120.0);
    });

    it("dynamically doubles open-addressing hash table at 70% load factor (> 716 buckets)", () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      const ctx = createVmContext();
      resetVmContext(ctx);

      // OP_AGG_INIT: agg_id = 0, start_key_reg = 0, num_keys = 1, mode = 0 (hash)
      const codeInit = new Uint8Array([
        OpCode.OP_AGG_INIT,
        0,
        0,
        1,
        0,
        OpCode.OP_HALT,
      ]);
      expect(vm_step(ctx, view, codeInit)).toBe(VmStatus.DONE);

      const agg = ctx.aggregators[0];
      expect(agg.capacity).toBe(1024);
      expect(agg.occupiedCount).toBe(0);

      // Insert 716 distinct keys (at 70% load factor threshold)
      for (let i = 0; i < 716; i++) {
        ctx.registers[0] = `group_key_${i}`;
        ctx.pc = 0;
        const codeStep = new Uint8Array([
          OpCode.OP_AGG_STEP,
          0,
          0,
          1,
          255,
          0,
          OpCode.OP_HALT,
        ]);
        expect(vm_step(ctx, view, codeStep)).toBe(VmStatus.DONE);
      }

      // Should still be capacity 1024
      expect(agg.capacity).toBe(1024);
      expect(agg.occupiedCount).toBe(716);

      // Insert key 717 -> exceeds 70% threshold (716.8) -> triggers table doubling to 2048!
      ctx.registers[0] = "group_key_716";
      ctx.pc = 0;
      const codeTrigger = new Uint8Array([
        OpCode.OP_AGG_STEP,
        0,
        0,
        1,
        255,
        0,
        OpCode.OP_HALT,
      ]);
      expect(vm_step(ctx, view, codeTrigger)).toBe(VmStatus.DONE);

      expect(agg.capacity).toBe(2048);
      expect(agg.occupiedCount).toBe(717);
    });

    it("enforces fail-fast 16MB arena limit yielding STATUS_ERR_ARENA_EXHAUSTED and O(1) memory reset", async () => {
      const buffer = new ArrayBuffer(TOTAL_MEMORY_BYTES);
      const view = new DataView(buffer);
      const ctx = createVmContext();
      resetVmContext(ctx);

      // Artificially configure a tight query memory limit (60 KB)
      ctx.maxQueryMemory = 60 * 1024;

      // 1. Initial table takes 1024 * 40B = 40.96 KB
      const codeInit = new Uint8Array([OpCode.OP_AGG_INIT, 0, 0, 1, 0]);
      expect(vm_step(ctx, view, codeInit)).toBe(VmStatus.DONE);
      expect(ctx.arenaOffset).toBe(40960);

      // 2. Filling past 716 triggers doubling attempt requiring another 2048 * 40B = 81.92 KB
      // Total needed: 40.96 KB + 81.92 KB = 122.88 KB > 60 KB maxQueryMemory
      for (let i = 0; i < 716; i++) {
        ctx.registers[0] = `k_${i}`;
        ctx.pc = 0;
        const codeStep = new Uint8Array([OpCode.OP_AGG_STEP, 0, 0, 1, 255, 0]);
        vm_step(ctx, view, codeStep);
      }

      // Key 717 triggers doubling -> must halt with ARENA_EXHAUSTED
      ctx.registers[0] = "k_716";
      ctx.pc = 0;
      const codeTrigger = new Uint8Array([OpCode.OP_AGG_STEP, 0, 0, 1, 255, 0]);
      const status = vm_step(ctx, view, codeTrigger);
      expect(status).toBe(VmStatus.ARENA_EXHAUSTED);

      // Verify O(1) recovery via resetVmContext (or OP_HALT)
      resetVmContext(ctx);
      expect(ctx.arenaOffset).toBe(0);
    });

    it("executes end-to-end multi-column sort and aggregations via WebDB & QueryBuilder", async () => {
      const db = await WebDB.open({
        name: "milestone5_e2e_db",
        storage: "memory",
      });

      await db.createTable("products", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "category", type: "TEXT" },
        { name: "price", type: "FLOAT64" },
        { name: "rating", type: "FLOAT64" },
      ]);

      await db.insert("products", {
        id: 1,
        category: "Electronics",
        price: 299.99,
        rating: 4.5,
      });
      await db.insert("products", {
        id: 2,
        category: "Electronics",
        price: 99.99,
        rating: 4.8,
      });
      await db.insert("products", {
        id: 3,
        category: "Books",
        price: 19.99,
        rating: 4.9,
      });
      await db.insert("products", {
        id: 4,
        category: "Books",
        price: 29.99,
        rating: 4.2,
      });
      await db.insert("products", {
        id: 5,
        category: "Electronics",
        price: 99.99,
        rating: 4.1,
      });

      // 1. Multi-column Order By: category ASC, price ASC, rating DESC
      const sorted = await db
        .from("products")
        .orderBy([
          { colName: "category", direction: "asc" },
          { colName: "price", direction: "asc" },
          { colName: "rating", direction: "desc" },
        ])
        .toArray();

      expect(sorted).toHaveLength(5);
      expect(sorted.map((p) => p.id)).toEqual([3, 4, 2, 5, 1]);
      // Books (19.99, 29.99), Electronics (99.99 rating 4.8, 99.99 rating 4.1, 299.99)

      // 2. Group By with Aggregates: Category, count(*), sum(price), avg(price), min(price), max(price)
      const aggResults = await db
        .from("products")
        .groupBy("category")
        .count("*", "item_count")
        .sum("price", "total_price")
        .avg("price", "avg_price")
        .min("price", "min_price")
        .max("price", "max_price")
        .toArray();

      expect(aggResults).toHaveLength(2);

      const books = aggResults.find((a) => a.category === "Books");
      expect(books).toBeDefined();
      expect(books!.item_count).toBe(2);
      expect(books!.total_price).toBeCloseTo(49.98);
      expect(books!.avg_price).toBeCloseTo(24.99);
      expect(books!.min_price).toBe(19.99);
      expect(books!.max_price).toBe(29.99);

      const elec = aggResults.find((a) => a.category === "Electronics");
      expect(elec).toBeDefined();
      expect(elec!.item_count).toBe(3);
      expect(elec!.total_price).toBeCloseTo(499.97);
      expect(elec!.avg_price).toBeCloseTo(166.6566, 2);
      expect(elec!.min_price).toBe(99.99);
      expect(elec!.max_price).toBe(299.99);
    });
  });
});
