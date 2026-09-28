import { describe, it, expect } from "vitest";
import {
  BytecodeEmitter,
  compileQuery,
  disassembleBytecode,
  formatDisassembly,
  type QueryPlan,
} from "../src/host/compiler/compiler.js";
import {
  OpCode,
  DataType,
  ColumnFlag,
  type TableMeta,
  TooManyOrderByColumnsError,
  TooManyGroupByColumnsError,
  TooManyRegistersError,
} from "../src/types/index.js";

function createMockTable(numCols = 4): TableMeta {
  return {
    name: "users",
    rootPageId: 2,
    schemaVersion: 1,
    flags: 1,
    colCatalogPageId: 0,
    totalRows: 100,
    autoIncNext: 1n,
    columns: [
      { name: "id", type: DataType.INT32, flags: ColumnFlag.PRIMARY_KEY, colOffset: 0 },
      { name: "name", type: DataType.TEXT, flags: ColumnFlag.NOT_NULL, colOffset: 1 },
      { name: "age", type: DataType.INT32, flags: ColumnFlag.NONE, colOffset: 2 },
      { name: "score", type: DataType.FLOAT64, flags: ColumnFlag.NONE, colOffset: 3 },
      ...(numCols > 4
        ? Array.from({ length: numCols - 4 }, (_, i) => ({
            name: `extra_${i}`,
            type: DataType.INT32,
            flags: ColumnFlag.NONE,
            colOffset: 4 + i,
          }))
        : []),
    ],
  };
}

describe("Bytecode Compiler & Emitter Unit Tests", () => {
  describe("BytecodeEmitter (Bytes Builder Logic)", () => {
    it("emits 8-bit unsigned integers (emitUint8)", () => {
      const emitter = new BytecodeEmitter();
      expect(emitter.currentOffset()).toBe(0);

      const p0 = emitter.emitUint8(0x00);
      const p1 = emitter.emitUint8(0x25);
      const p2 = emitter.emitUint8(0xff);
      const p3 = emitter.emitUint8(0x105); // overflow masks to 0x05

      expect([p0, p1, p2, p3]).toEqual([0, 1, 2, 3]);
      expect(emitter.currentOffset()).toBe(4);
      expect(emitter.toByteArray()).toEqual(new Uint8Array([0x00, 0x25, 0xff, 0x05]));
    });

    it("emits 16-bit unsigned integers in little-endian format (emitUint16)", () => {
      const emitter = new BytecodeEmitter();
      emitter.emitUint16(0x1234);
      emitter.emitUint16(0x0005);
      emitter.emitUint16(0xffff);

      const bytes = emitter.toByteArray();
      expect(bytes).toHaveLength(6);
      const view = new DataView(bytes.buffer);
      expect(view.getUint16(0, true)).toBe(0x1234);
      expect(view.getUint16(2, true)).toBe(0x0005);
      expect(view.getUint16(4, true)).toBe(0xffff);
    });

    it("emits 32-bit unsigned and signed integers in little-endian format (emitUint32, emitInt32)", () => {
      const emitter = new BytecodeEmitter();
      emitter.emitUint32(0xdeadbeef);
      emitter.emitInt32(-42);
      emitter.emitInt32(1000000);

      const bytes = emitter.toByteArray();
      expect(bytes).toHaveLength(12);
      const view = new DataView(bytes.buffer);
      expect(view.getUint32(0, true)).toBe(0xdeadbeef);
      expect(view.getInt32(4, true)).toBe(-42);
      expect(view.getInt32(8, true)).toBe(1000000);
    });

    it("emits 64-bit floating point numbers with full IEEE 754 precision (emitFloat64)", () => {
      const emitter = new BytecodeEmitter();
      emitter.emitFloat64(Math.PI);
      emitter.emitFloat64(-99.125);
      emitter.emitFloat64(0.0);

      const bytes = emitter.toByteArray();
      expect(bytes).toHaveLength(24);
      const view = new DataView(bytes.buffer);
      expect(view.getFloat64(0, true)).toBeCloseTo(Math.PI, 10);
      expect(view.getFloat64(8, true)).toBe(-99.125);
      expect(view.getFloat64(16, true)).toBe(0.0);
    });

    it("emits length-prefixed UTF-8 strings (emitString)", () => {
      const emitter = new BytecodeEmitter();
      const pos = emitter.emitString("WebDB Database 🚀");

      expect(pos).toBe(0);
      const bytes = emitter.toByteArray();
      const view = new DataView(bytes.buffer);
      const len = view.getUint16(0, true);

      const decoder = new TextDecoder();
      const str = decoder.decode(bytes.subarray(2, 2 + len));
      expect(str).toBe("WebDB Database 🚀");
      expect(bytes.length).toBe(2 + len);
    });

    it("patches forward jump targets accurately (patchUint16)", () => {
      const emitter = new BytecodeEmitter();
      emitter.emitUint8(OpCode.OP_JUMP);
      const jumpPatch = emitter.emitUint16(0); // placeholder address

      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(0);
      emitter.emitInt32(100);

      const targetPos = emitter.currentOffset();
      emitter.patchUint16(jumpPatch, targetPos);

      const bytes = emitter.toByteArray();
      const view = new DataView(bytes.buffer);
      expect(view.getUint16(1, true)).toBe(targetPos);
    });
  });

  describe("Table Scan Query Compilation", () => {
    it("compiles unconditional table scan to bytecode", () => {
      const table = createMockTable();
      const bytecode = compileQuery({
        table,
        filters: [],
      });

      expect(bytecode.length).toBeGreaterThan(0);
      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes[0]).toBe("OP_OPEN_CURSOR");
      expect(opcodes[1]).toBe("OP_REWIND");
      expect(opcodes).toContain("OP_EMIT_ROW");
      expect(opcodes).toContain("OP_NEXT_ROW");
      expect(opcodes).toContain("OP_JUMP");
      expect(opcodes[opcodes.length - 1]).toBe("OP_HALT");
    });

    it("compiles numeric comparison filters (=, !=, <, <=, >, >=)", () => {
      const table = createMockTable();
      const bytecode = compileQuery({
        table,
        filters: [
          { type: "cmp", colName: "age", op: ">", value: 18 },
          { type: "cmp", colName: "score", op: "<=", value: 95.5 },
        ],
      });

      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      // Preamble constants loaded into registers
      expect(opcodes).toContain("OP_LOAD_INT");
      expect(opcodes).toContain("OP_LOAD_FLOAT");

      // Column readings
      expect(opcodes).toContain("OP_COLUMN_INT");
      expect(opcodes).toContain("OP_COLUMN_FLOAT");

      // Branch conditions: inverted jumps on mismatch
      // For '>' filter, branch to next_row on LE
      expect(opcodes).toContain("OP_LE");
      // For '<=' filter, branch to next_row on GT
      expect(opcodes).toContain("OP_GT");
    });

    it("compiles string pattern filters (LIKE, NOT LIKE, CONTAINS, STARTS_WITH, ENDS_WITH)", () => {
      const table = createMockTable();
      const bytecode = compileQuery({
        table,
        filters: [
          { type: "cmp", colName: "name", op: "LIKE", value: "%Alice%" },
          { type: "cmp", colName: "name", op: "STARTS_WITH", value: "Ali" },
          { type: "cmp", colName: "name", op: "ENDS_WITH", value: "ce" },
          { type: "cmp", colName: "name", op: "CONTAINS", value: "lic" },
          { type: "cmp", colName: "name", op: "NOT LIKE", value: "%Bob%" },
        ],
      });

      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes).toContain("OP_LOAD_TEXT");
      expect(opcodes).toContain("OP_COLUMN_TEXT");
      expect(opcodes).toContain("OP_STR_NOT_LIKE");
      expect(opcodes).toContain("OP_STR_LIKE");
      expect(opcodes).toContain("OP_STR_STARTS_WITH");
      expect(opcodes).toContain("OP_STR_ENDS_WITH");
      expect(opcodes).toContain("OP_STR_CONTAINS");
    });

    it("compiles NULL and NOT NULL filters", () => {
      const table = createMockTable();
      const bytecode = compileQuery({
        table,
        filters: [
          { type: "null", colName: "score", isNull: true },
          { type: "null", colName: "age", isNull: false },
        ],
      });

      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes).toContain("OP_IS_NOT_NULL"); // skips to next row if not null
      expect(opcodes).toContain("OP_IS_NULL");     // skips to next row if null
    });

    it("compiles native LIMIT and OFFSET opcodes in table scan loop", () => {
      const table = createMockTable();
      const bytecode = compileQuery({
        table,
        filters: [],
        offset: 5,
        limit: 10,
      });

      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes).toContain("OP_OFFSET");
      expect(opcodes).toContain("OP_LIMIT");

      // Verify OP_OFFSET precedes OP_EMIT_ROW and OP_LIMIT succeeds OP_EMIT_ROW
      const offsetIdx = opcodes.indexOf("OP_OFFSET");
      const emitIdx = opcodes.indexOf("OP_EMIT_ROW");
      const limitIdx = opcodes.indexOf("OP_LIMIT");

      expect(offsetIdx).toBeLessThan(emitIdx);
      expect(emitIdx).toBeLessThan(limitIdx);
    });
  });

  describe("Nested Boolean Conditions Compilation (AND / OR / NOT)", () => {
    it("compiles A AND (B OR C) with short-circuit control flow", () => {
      const table = createMockTable();
      const plan: QueryPlan = {
        table,
        filters: [
          {
            type: "and",
            children: [
              { type: "cmp", colName: "age", op: ">", value: 18 },
              {
                type: "or",
                children: [
                  { type: "cmp", colName: "name", op: "=", value: "Alice" },
                  { type: "cmp", colName: "name", op: "=", value: "Bob" },
                ],
              },
            ],
          },
        ],
      };

      const bytecode = compileQuery(plan);
      expect(bytecode.length).toBeGreaterThan(0);
      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      // Verify register preloading: 3 leaves (age > 18, name = Alice, name = Bob)
      expect(opcodes.filter((op) => op === "OP_LOAD_INT")).toHaveLength(1);
      expect(opcodes.filter((op) => op === "OP_LOAD_TEXT")).toHaveLength(2);

      // Verify comparison opcodes
      expect(opcodes).toContain("OP_GT");
      expect(opcodes).toContain("OP_EQ");

      // Verify jumps exist for short-circuit evaluation
      expect(opcodes).toContain("OP_JUMP");
    });

    it("compiles NOT (A OR B) with inverted control flow", () => {
      const table = createMockTable();
      const plan: QueryPlan = {
        table,
        filters: [
          {
            type: "not",
            child: {
              type: "or",
              children: [
                { type: "cmp", colName: "name", op: "=", value: "Banned1" },
                { type: "cmp", colName: "name", op: "=", value: "Banned2" },
              ],
            },
          },
        ],
      };

      const bytecode = compileQuery(plan);
      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes).toContain("OP_NE");
      expect(opcodes).toContain("OP_EMIT_ROW");
    });

    it("compiles (A AND B) OR (C AND D) composite boolean tree", () => {
      const table = createMockTable();
      const plan: QueryPlan = {
        table,
        filters: [
          {
            type: "or",
            children: [
              {
                type: "and",
                children: [
                  { type: "cmp", colName: "age", op: ">=", value: 20 },
                  { type: "cmp", colName: "score", op: ">=", value: 90.0 },
                ],
              },
              {
                type: "and",
                children: [
                  { type: "cmp", colName: "age", op: "<", value: 20 },
                  { type: "cmp", colName: "score", op: ">=", value: 95.0 },
                ],
              },
            ],
          },
        ],
      };

      const bytecode = compileQuery(plan);
      expect(bytecode.length).toBeGreaterThan(0);
      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes).toContain("OP_GE");
      expect(opcodes).toContain("OP_LT");
      expect(opcodes).toContain("OP_EMIT_ROW");
    });

    it("throws TooManyRegistersError when nested boolean leaf filters exceed 32", () => {
      const table = createMockTable(40);
      const leafChildren = Array.from({ length: 33 }, (_, i) => ({
        type: "cmp" as const,
        colName: "age",
        op: ">" as const,
        value: i,
      }));

      const plan: QueryPlan = {
        table,
        filters: [
          {
            type: "or",
            children: leafChildren,
          },
        ],
      };

      expect(() => compileQuery(plan)).toThrow(TooManyRegistersError);
    });
  });

  describe("In-Arena Sorter (ORDER BY) Query Compilation", () => {
    it("compiles single and multi-column ORDER BY with KeyInfo directions", () => {
      const table = createMockTable();
      const plan: QueryPlan = {
        table,
        filters: [],
        orderBy: [
          { colName: "age", direction: "asc" },
          { colName: "score", direction: "desc", nullOrder: "nulls_last" },
        ],
      };

      const bytecode = compileQuery(plan);
      expect(plan.keyInfos).toBeDefined();
      expect(plan.keyInfos![0].numKeys).toBe(2);
      expect(plan.keyInfos![0].directions).toEqual([0, 1]);
      expect(plan.keyInfos![0].nullOrders).toEqual([0, 1]);

      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes).toContain("OP_SORTER_OPEN");
      expect(opcodes).toContain("OP_SORTER_INSERT");
      expect(opcodes).toContain("OP_SORTER_SORT");
      expect(opcodes).toContain("OP_SORTER_NEXT");
    });

    it("binds limit and offset into KeyInfo for Top-K optimization", () => {
      const table = createMockTable();
      const plan: QueryPlan = {
        table,
        filters: [],
        orderBy: [{ colName: "score", direction: "desc" }],
        limit: 5,
        offset: 2,
      };

      compileQuery(plan);
      expect(plan.keyInfos![0].limit).toBe(5);
      expect(plan.keyInfos![0].offset).toBe(2);
    });

    it("throws TooManyOrderByColumnsError when sort columns exceed 8", () => {
      const table = createMockTable(12);
      const plan: QueryPlan = {
        table,
        filters: [],
        orderBy: Array.from({ length: 9 }, (_, i) => ({
          colName: i === 0 ? "id" : i === 1 ? "name" : i === 2 ? "age" : i === 3 ? "score" : `extra_${i - 4}`,
          direction: "asc" as const,
        })),
      };

      expect(() => compileQuery(plan)).toThrow(TooManyOrderByColumnsError);
    });
  });

  describe("In-Arena Hash Aggregation (GROUP BY) Query Compilation", () => {
    it("compiles GROUP BY with aggregations (COUNT, SUM, AVG, MIN, MAX)", () => {
      const table = createMockTable();
      const plan: QueryPlan = {
        table,
        filters: [],
        groupBy: ["name"],
        aggregates: [
          { func: "count", colName: "*", alias: "total_rows" },
          { func: "sum", colName: "score", alias: "total_score" },
          { func: "avg", colName: "score", alias: "avg_score" },
          { func: "min", colName: "age", alias: "min_age" },
          { func: "max", colName: "age", alias: "max_age" },
        ],
      };

      const bytecode = compileQuery(plan);
      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes).toContain("OP_AGG_INIT");
      expect(opcodes).toContain("OP_AGG_STEP");
      expect(opcodes).toContain("OP_AGG_NEXT");
      expect(opcodes).toContain("OP_AGG_FINAL");
      expect(opcodes).toContain("OP_RESULT_ROW");
    });

    it("compiles aggregation with OFFSET and LIMIT in emission loop", () => {
      const table = createMockTable();
      const plan: QueryPlan = {
        table,
        filters: [],
        groupBy: ["name"],
        aggregates: [{ func: "count", colName: "*" }],
        offset: 3,
        limit: 5,
      };

      const bytecode = compileQuery(plan);
      const instructions = disassembleBytecode(bytecode, table);
      const opcodes = instructions.map((i) => i.opcode);

      expect(opcodes).toContain("OP_OFFSET");
      expect(opcodes).toContain("OP_LIMIT");

      const offsetIdx = opcodes.indexOf("OP_OFFSET");
      const resultIdx = opcodes.indexOf("OP_RESULT_ROW");
      const limitIdx = opcodes.indexOf("OP_LIMIT");

      expect(offsetIdx).toBeLessThan(resultIdx);
      expect(resultIdx).toBeLessThan(limitIdx);
    });

    it("throws TooManyGroupByColumnsError when grouping columns exceed 8", () => {
      const table = createMockTable(12);
      const plan: QueryPlan = {
        table,
        filters: [],
        groupBy: ["id", "name", "age", "score", "extra_0", "extra_1", "extra_2", "extra_3", "extra_4"],
        aggregates: [{ func: "count", colName: "*" }],
      };

      expect(() => compileQuery(plan)).toThrow(TooManyGroupByColumnsError);
    });

    it("throws TooManyRegistersError if register allocation exceeds 64", () => {
      const table = createMockTable(30);
      // Construct a query plan with many filters to overflow registers >= 64
      const filters = Array.from({ length: 35 }, (_, i) => ({
        type: "cmp" as const,
        colName: "age",
        op: ">" as const,
        value: i,
      }));

      const plan: QueryPlan = {
        table,
        filters,
        groupBy: ["id", "name", "age", "score", "extra_0", "extra_1", "extra_2", "extra_3"],
        aggregates: [
          { func: "count" as const, colName: "*" },
          { func: "sum" as const, colName: "score" },
          { func: "min" as const, colName: "score" },
          { func: "max" as const, colName: "score" },
        ],
      };

      expect(() => compileQuery(plan)).toThrow(TooManyRegistersError);
    });
  });

  describe("Disassembler and Assembly Formatting", () => {
    it("disassembles bytecode into instruction descriptors and formats table", () => {
      const table = createMockTable();
      const bytecode = compileQuery({
        table,
        filters: [{ type: "cmp", colName: "age", op: ">", value: 25 }],
        limit: 5,
      });

      const instructions = disassembleBytecode(bytecode, table);
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions[0]).toHaveProperty("addr");
      expect(instructions[0]).toHaveProperty("opcode");
      expect(instructions[0]).toHaveProperty("p1");

      const assembly = formatDisassembly(instructions);
      expect(typeof assembly).toBe("string");
      expect(assembly).toContain("ADDR");
      expect(assembly).toContain("OPCODE");
      expect(assembly).toContain("OP_OPEN_CURSOR");
      expect(assembly).toContain("OP_HALT");
    });
  });
});
