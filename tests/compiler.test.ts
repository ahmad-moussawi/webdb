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
  attachTableMetaHelpers,
} from "../src/types/index.js";

function createMockTable(numCols = 4): TableMeta {
  return attachTableMetaHelpers({
    tableId: 1,
    columnCount: numCols,
    name: "users",
    rowCountEstimate: 100,
    autoIncNext: 1n,
    rootPageId: 2,
    schemaVersion: 1,
    flags: 1,
    colCatalogPageId: 0,
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
  });
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
          { type: "cmp", colName: "name", op: "like", value: "%Alice%" },
          { type: "cmp", colName: "name", op: "starts_with", value: "Ali" },
          { type: "cmp", colName: "name", op: "ends_with", value: "ce" },
          { type: "cmp", colName: "name", op: "contains", value: "lic" },
          { type: "cmp", colName: "name", op: "not like", value: "%Bob%" },
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
        colName: `extra_${i % 30}`,
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

    it("exhaustively decodes all 71 supported opcode layouts with exact PC advancement and descriptor fields", () => {
      const table = createMockTable();
      const emitter = new BytecodeEmitter();
      const expected: Array<{
        addr: number;
        opcode: string;
        p1: string;
        p2: string;
        p3: string;
        comment: string;
      }> = [];
      const testedOpcodes = new Set<number>();

      const record = (
        op: OpCode,
        emitOperands: () => void,
        desc: { opcode: string; p1: string; p2: string; p3: string; comment: string },
      ) => {
        const addr = emitter.currentOffset();
        testedOpcodes.add(op);
        emitter.emitUint8(op);
        emitOperands();
        expected.push({ addr, ...desc });
      };

      // 1. Cursor jump table (4 opcodes)
      const cursorJumpCases: Array<[OpCode, string, string]> = [
        [OpCode.OP_REWIND, "OP_REWIND", "Rewind cursor to first row; jump to 0x0123 if empty"],
        [OpCode.OP_NEXT_ROW, "OP_NEXT_ROW", "Advance cursor to next row; jump to 0x0123 if EOF"],
        [OpCode.OP_LAST, "OP_LAST", "Position cursor to last row; jump to 0x0123 if empty"],
        [OpCode.OP_PREV_ROW, "OP_PREV_ROW", "Advance cursor to previous row; jump to 0x0123 if BOF"],
      ];
      for (const [op, name, comment] of cursorJumpCases) {
        record(
          op,
          () => {
            emitter.emitUint8(1);
            emitter.emitUint16(0x0123);
          },
          { opcode: name, p1: "c[1]", p2: "0x0123", p3: "", comment },
        );
      }

      // 2. Column read table (6 opcodes)
      const columnCases: Array<[OpCode, string, string]> = [
        [OpCode.OP_COLUMN_INT, "OP_COLUMN_INT", "INT"],
        [OpCode.OP_COLUMN_FLOAT, "OP_COLUMN_FLOAT", "FLOAT"],
        [OpCode.OP_COLUMN_TEXT, "OP_COLUMN_TEXT", "TEXT"],
        [OpCode.OP_COLUMN_BLOB, "OP_COLUMN_BLOB", "BLOB"],
        [OpCode.OP_COLUMN_UUID, "OP_COLUMN_UUID", "UUID"],
        [OpCode.OP_COLUMN_ULID, "OP_COLUMN_ULID", "ULID"],
      ];
      for (const [op, name, kind] of columnCases) {
        record(
          op,
          () => {
            emitter.emitUint8(0);
            emitter.emitUint8(2);
            emitter.emitUint8(5);
          },
          {
            opcode: name,
            p1: "c[0]",
            p2: "2 ('age')",
            p3: "r[5]",
            comment: `Read 'age' as ${kind} into r[5]`,
          },
        );
      }

      // 3. Comparison & string predicate table (12 opcodes)
      const cmpCases: Array<[OpCode, string, string]> = [
        [OpCode.OP_EQ, "OP_EQ", "=="],
        [OpCode.OP_NE, "OP_NE", "!="],
        [OpCode.OP_GT, "OP_GT", ">"],
        [OpCode.OP_GE, "OP_GE", ">="],
        [OpCode.OP_LT, "OP_LT", "<"],
        [OpCode.OP_LE, "OP_LE", "<="],
        [OpCode.OP_STR_LIKE, "OP_STR_LIKE", "LIKE"],
        [OpCode.OP_STR_NOT_LIKE, "OP_STR_NOT_LIKE", "NOT LIKE"],
        [OpCode.OP_STR_CONTAINS, "OP_STR_CONTAINS", "CONTAINS"],
        [OpCode.OP_STR_STARTS_WITH, "OP_STR_STARTS_WITH", "STARTS_WITH"],
        [OpCode.OP_STR_ENDS_WITH, "OP_STR_ENDS_WITH", "ENDS_WITH"],
        [OpCode.OP_STR_FUZZY_MATCH, "OP_STR_FUZZY_MATCH", "FUZZY_MATCH"],
      ];
      for (const [op, name, sym] of cmpCases) {
        record(
          op,
          () => {
            emitter.emitUint8(3);
            emitter.emitUint8(4);
            emitter.emitUint16(0x00ab);
          },
          {
            opcode: name,
            p1: "r[3]",
            p2: "r[4]",
            p3: "0x00ab",
            comment: `If r[3] ${sym} r[4] -> jump to 0x00ab`,
          },
        );
      }

      // 4. Unary register table (8 opcodes)
      const unaryCases: Array<[OpCode, string]> = [
        [OpCode.OP_STR_LOWER, "OP_STR_LOWER"],
        [OpCode.OP_STR_UPPER, "OP_STR_UPPER"],
        [OpCode.OP_STR_LENGTH, "OP_STR_LENGTH"],
        [OpCode.OP_STR_TRIM, "OP_STR_TRIM"],
        [OpCode.OP_MATH_ABS, "OP_MATH_ABS"],
        [OpCode.OP_MATH_ROUND, "OP_MATH_ROUND"],
        [OpCode.OP_MATH_FLOOR, "OP_MATH_FLOOR"],
        [OpCode.OP_MATH_CEIL, "OP_MATH_CEIL"],
      ];
      for (const [op, name] of unaryCases) {
        record(
          op,
          () => {
            emitter.emitUint8(6);
            emitter.emitUint8(7);
          },
          {
            opcode: name,
            p1: "r[6]",
            p2: "r[7]",
            p3: "",
            comment: `${name}: r[7] = ${name.toLowerCase()}(r[6])`,
          },
        );
      }

      // 5. Binary arithmetic table (5 opcodes)
      const arithCases: Array<[OpCode, string]> = [
        [OpCode.OP_ADD, "OP_ADD"],
        [OpCode.OP_SUB, "OP_SUB"],
        [OpCode.OP_MUL, "OP_MUL"],
        [OpCode.OP_DIV, "OP_DIV"],
        [OpCode.OP_MOD, "OP_MOD"],
      ];
      for (const [op, name] of arithCases) {
        record(
          op,
          () => {
            emitter.emitUint8(8);
            emitter.emitUint8(9);
            emitter.emitUint8(10);
          },
          {
            opcode: name,
            p1: "r[8]",
            p2: "r[9]",
            p3: "r[10]",
            comment: `${name}: r[10] = r[8] ${name.replace("OP_", "")} r[9]`,
          },
        );
      }

      // 6. Switch-dispatched opcodes (36 opcodes)
      record(OpCode.OP_OPEN_CURSOR, () => {
        emitter.emitUint8(0);
        emitter.emitUint32(42);
      }, {
        opcode: "OP_OPEN_CURSOR",
        p1: "c[0]",
        p2: "page=42",
        p3: "",
        comment: "Open cursor 0 on root page 42 ('users')",
      });

      record(OpCode.OP_OPEN_INDEX, () => {
        emitter.emitUint8(2);
        emitter.emitUint32(99);
      }, {
        opcode: "OP_OPEN_INDEX",
        p1: "c[2]",
        p2: "page=99",
        p3: "",
        comment: "Open index cursor 2 on root page 99",
      });

      record(OpCode.OP_INDEX_SEEK_EQ, () => {
        emitter.emitUint8(2);
        emitter.emitUint8(0);
        emitter.emitUint8(3);
        emitter.emitUint8(DataType.INT32);
        emitter.emitUint16(0x0200);
      }, {
        opcode: "OP_INDEX_SEEK_EQ",
        p1: "idx=c[2], data=c[0]",
        p2: `key=r[3], type=${DataType.INT32}`,
        p3: "0x0200",
        comment: "Seek exact key in index; position data cursor or jump to 0x0200 if not found",
      });

      record(OpCode.OP_INDEX_SEEK_GE, () => {
        emitter.emitUint8(2);
        emitter.emitUint8(0);
        emitter.emitUint8(4);
        emitter.emitUint8(DataType.TEXT);
        emitter.emitUint16(0x0210);
      }, {
        opcode: "OP_INDEX_SEEK_GE",
        p1: "idx=c[2], data=c[0]",
        p2: `key=r[4], type=${DataType.TEXT}`,
        p3: "0x0210",
        comment: "Seek first entry >= key in index; position data cursor or jump to 0x0210 if EOF",
      });

      record(OpCode.OP_INDEX_NEXT, () => {
        emitter.emitUint8(2);
        emitter.emitUint8(0);
        emitter.emitUint16(0x0220);
      }, {
        opcode: "OP_INDEX_NEXT",
        p1: "idx=c[2], data=c[0]",
        p2: "0x0220",
        p3: "",
        comment: "Advance index cursor to next entry; jump to 0x0220 if EOF",
      });

      record(OpCode.OP_IS_NULL, () => {
        emitter.emitUint8(0);
        emitter.emitUint8(1);
        emitter.emitUint16(0x0230);
      }, {
        opcode: "OP_IS_NULL",
        p1: "c[0]",
        p2: "1 ('name')",
        p3: "0x0230",
        comment: "If 'name' IS NULL -> jump to 0x0230",
      });

      record(OpCode.OP_IS_NOT_NULL, () => {
        emitter.emitUint8(0);
        emitter.emitUint8(1);
        emitter.emitUint16(0x0240);
      }, {
        opcode: "OP_IS_NOT_NULL",
        p1: "c[0]",
        p2: "1 ('name')",
        p3: "0x0240",
        comment: "If 'name' IS NOT NULL -> jump to 0x0240",
      });

      record(OpCode.OP_JUMP, () => {
        emitter.emitUint16(0x0250);
      }, {
        opcode: "OP_JUMP",
        p1: "0x0250",
        p2: "",
        p3: "",
        comment: "Unconditional jump to 0x0250",
      });

      record(OpCode.OP_IN, () => {
        emitter.emitUint8(5);
        emitter.emitUint16(7);
        emitter.emitUint16(0x0260);
      }, {
        opcode: "OP_IN",
        p1: "r[5]",
        p2: "set[7]",
        p3: "0x0260",
        comment: "If r[5] IN set[7] -> jump to 0x0260",
      });

      record(OpCode.OP_LOAD_INT, () => {
        emitter.emitUint8(1);
        emitter.emitInt32(-123456);
      }, {
        opcode: "OP_LOAD_INT",
        p1: "r[1]",
        p2: "-123456",
        p3: "",
        comment: "Load literal int -123456 into r[1]",
      });

      record(OpCode.OP_LOAD_INT64, () => {
        emitter.emitUint8(2);
        emitter.emitInt64(9007199254740993n);
      }, {
        opcode: "OP_LOAD_INT64",
        p1: "r[2]",
        p2: "9007199254740993n",
        p3: "",
        comment: "Load literal int64 9007199254740993n into r[2]",
      });

      record(OpCode.OP_LOAD_FLOAT, () => {
        emitter.emitUint8(3);
        emitter.emitFloat64(3.5);
      }, {
        opcode: "OP_LOAD_FLOAT",
        p1: "r[3]",
        p2: "3.5",
        p3: "",
        comment: "Load literal float 3.5 into r[3]",
      });

      record(OpCode.OP_LOAD_TEXT, () => {
        emitter.emitUint8(4);
        emitter.emitString("hello");
      }, {
        opcode: "OP_LOAD_TEXT",
        p1: "r[4]",
        p2: '"hello"',
        p3: "",
        comment: 'Load literal text "hello" into r[4]',
      });

      record(OpCode.OP_LOAD_BLOB, () => {
        emitter.emitUint8(5);
        emitter.emitBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
      }, {
        opcode: "OP_LOAD_BLOB",
        p1: "r[5]",
        p2: "len=4",
        p3: "",
        comment: "Load literal BLOB (4 bytes) into r[5]",
      });

      record(OpCode.OP_LOAD_NULL, () => {
        emitter.emitUint8(6);
      }, {
        opcode: "OP_LOAD_NULL",
        p1: "r[6]",
        p2: "NULL",
        p3: "",
        comment: "Set r[6] to NULL",
      });

      record(OpCode.OP_EMIT_ROW, () => {
        emitter.emitUint8(0);
      }, {
        opcode: "OP_EMIT_ROW",
        p1: "c[0]",
        p2: "",
        p3: "",
        comment: "Row passed all filters -> emit to Output Result Buffer",
      });

      record(OpCode.OP_RESULT_ROW, () => {
        emitter.emitUint8(10);
        emitter.emitUint8(3);
      }, {
        opcode: "OP_RESULT_ROW",
        p1: "r[10]",
        p2: "cols=3",
        p3: "",
        comment: "Serialize registers r[10..12] to Result Buffer",
      });

      record(OpCode.OP_OFFSET, () => {
        emitter.emitUint8(11);
        emitter.emitUint16(0x0270);
      }, {
        opcode: "OP_OFFSET",
        p1: "r[11]",
        p2: "0x0270",
        p3: "",
        comment: "If r[11] > 0 -> decrement and skip row to 0x0270",
      });

      record(OpCode.OP_LIMIT, () => {
        emitter.emitUint8(12);
        emitter.emitUint16(0x0280);
      }, {
        opcode: "OP_LIMIT",
        p1: "r[12]",
        p2: "0x0280",
        p3: "",
        comment: "If r[12] <= 1 -> halt to 0x0280, else decrement",
      });

      record(OpCode.OP_CALL_UDF, () => {
        emitter.emitUint16(5);
        emitter.emitUint8(13);
        emitter.emitUint8(2);
        emitter.emitUint8(15);
      }, {
        opcode: "OP_CALL_UDF",
        p1: "udf#5",
        p2: "r[13..14]",
        p3: "r[15]",
        comment: "Call UDF #5 with 2 args -> r[15]",
      });

      record(OpCode.OP_STR_SUBSTR, () => {
        emitter.emitUint8(1);
        emitter.emitUint8(2);
        emitter.emitUint8(3);
        emitter.emitUint8(4);
      }, {
        opcode: "OP_STR_SUBSTR",
        p1: "r[1]",
        p2: "start=r[2], len=r[3]",
        p3: "r[4]",
        comment: "Extract substring from r[1] into r[4]",
      });

      record(OpCode.OP_STR_LEVENSHTEIN, () => {
        emitter.emitUint8(1);
        emitter.emitUint8(2);
        emitter.emitUint8(3);
      }, {
        opcode: "OP_STR_LEVENSHTEIN",
        p1: "r[1]",
        p2: "r[2]",
        p3: "r[3]",
        comment: "r[3] = levenshtein(r[1], r[2])",
      });

      record(OpCode.OP_STR_CONCAT, () => {
        emitter.emitUint8(2);
        emitter.emitUint8(3);
        emitter.emitUint8(5);
      }, {
        opcode: "OP_STR_CONCAT",
        p1: "r[2..4]",
        p2: "count=3",
        p3: "r[5]",
        comment: "OP_STR_CONCAT: r[5]",
      });

      record(OpCode.OP_COALESCE, () => {
        emitter.emitUint8(6);
        emitter.emitUint8(2);
        emitter.emitUint8(8);
      }, {
        opcode: "OP_COALESCE",
        p1: "r[6..7]",
        p2: "count=2",
        p3: "r[8]",
        comment: "OP_COALESCE: r[8]",
      });

      record(OpCode.OP_COPY, () => {
        emitter.emitUint8(9);
        emitter.emitUint8(10);
      }, {
        opcode: "OP_COPY",
        p1: "r[9]",
        p2: "r[10]",
        p3: "",
        comment: "Copy r[9] to r[10]",
      });

      record(OpCode.OP_SORTER_OPEN, () => {
        emitter.emitUint8(0);
        emitter.emitUint8(2);
      }, {
        opcode: "OP_SORTER_OPEN",
        p1: "s[0]",
        p2: "keyInfo=2",
        p3: "",
        comment: "Open sorter 0 with keyInfo 2",
      });

      record(OpCode.OP_SORTER_INSERT, () => {
        emitter.emitUint8(0);
        emitter.emitUint8(4);
        emitter.emitUint8(2);
        emitter.emitUint8(1);
      }, {
        opcode: "OP_SORTER_INSERT",
        p1: "s[0]",
        p2: "r[4..+2]",
        p3: "c[1]",
        comment: "Insert row from cursor 1 into sorter 0",
      });

      record(OpCode.OP_SORTER_SORT, () => {
        emitter.emitUint8(0);
      }, {
        opcode: "OP_SORTER_SORT",
        p1: "s[0]",
        p2: "",
        p3: "",
        comment: "Sort entries in sorter 0",
      });

      record(OpCode.OP_SORTER_NEXT, () => {
        emitter.emitUint8(0);
        emitter.emitUint16(0x0290);
      }, {
        opcode: "OP_SORTER_NEXT",
        p1: "s[0]",
        p2: "0x0290",
        p3: "",
        comment: "Emit next sorted row from sorter 0; jump to 0x0290 while more rows",
      });

      record(OpCode.OP_AGG_INIT, () => {
        emitter.emitUint8(0);
        emitter.emitUint8(2);
        emitter.emitUint8(1);
        emitter.emitUint8(0);
      }, {
        opcode: "OP_AGG_INIT",
        p1: "agg[0]",
        p2: "keys=r[2..+1]",
        p3: "mode=hash",
        comment: "Initialize aggregator 0 (hash table)",
      });

      record(OpCode.OP_AGG_INIT, () => {
        emitter.emitUint8(1);
        emitter.emitUint8(3);
        emitter.emitUint8(2);
        emitter.emitUint8(1);
      }, {
        opcode: "OP_AGG_INIT",
        p1: "agg[1]",
        p2: "keys=r[3..+2]",
        p3: "mode=stream",
        comment: "Initialize aggregator 1 (stream)",
      });

      record(OpCode.OP_AGG_STEP, () => {
        emitter.emitUint8(0);
        emitter.emitUint8(2);
        emitter.emitUint8(1);
        emitter.emitUint8(255);
        emitter.emitUint8((1 << 3) | 0); // slot 1, COUNT
      }, {
        opcode: "OP_AGG_STEP",
        p1: "agg[0]",
        p2: "val=*",
        p3: "COUNT",
        comment: "Update accumulator COUNT (slot 1) for group r[2..+1]",
      });

      record(OpCode.OP_AGG_STEP, () => {
        emitter.emitUint8(0);
        emitter.emitUint8(2);
        emitter.emitUint8(1);
        emitter.emitUint8(5);
        emitter.emitUint8((2 << 3) | 1); // slot 2, SUM
      }, {
        opcode: "OP_AGG_STEP",
        p1: "agg[0]",
        p2: "val=r[5]",
        p3: "SUM",
        comment: "Update accumulator SUM (slot 2) for group r[2..+1]",
      });

      record(OpCode.OP_AGG_NEXT, () => {
        emitter.emitUint8(0);
        emitter.emitUint8(10);
        emitter.emitUint8(12);
        emitter.emitUint16(0x02a0);
      }, {
        opcode: "OP_AGG_NEXT",
        p1: "agg[0]",
        p2: "out_keys=r[10], out_acc=r[12]",
        p3: "0x02a0",
        comment: "Iterate next group bucket; jump to 0x02a0",
      });

      record(OpCode.OP_AGG_FINAL, () => {
        emitter.emitUint8(12);
        emitter.emitUint8(13);
        emitter.emitUint8(14);
        emitter.emitUint8((3 << 3) | 2); // slot 3, AVG
      }, {
        opcode: "OP_AGG_FINAL",
        p1: "sum=r[12], cnt=r[13]",
        p2: "r[14]",
        p3: "AVG",
        comment: "Finalize AVG (slot 3) into r[14]",
      });

      record(OpCode.OP_REG_IS_NULL, () => {
        emitter.emitUint8(14);
        emitter.emitUint16(0x02b0);
      }, {
        opcode: "OP_REG_IS_NULL",
        p1: "r[14]",
        p2: "0x02b0",
        p3: "",
        comment: "Jump to 0x02b0 if r[14] is NULL",
      });

      record(OpCode.OP_REG_IS_NOT_NULL, () => {
        emitter.emitUint8(15);
        emitter.emitUint16(0x02c0);
      }, {
        opcode: "OP_REG_IS_NOT_NULL",
        p1: "r[15]",
        p2: "0x02c0",
        p3: "",
        comment: "Jump to 0x02c0 if r[15] is NOT NULL",
      });

      // Trailing sentinel: catches any PC drift from preceding instructions
      record(OpCode.OP_HALT, () => {}, {
        opcode: "OP_HALT",
        p1: "",
        p2: "",
        p3: "",
        comment: "Halt VM execution (STATUS_DONE)",
      });

      // Guard against newly added opcodes silently missing disassembler coverage
      const unimplementedOpcodes = new Set<number>([
        OpCode.OP_ENTER_SUBQUERY,
        OpCode.OP_RETURN_SUBQUERY,
        OpCode.OP_DELETE_ROW,
        OpCode.OP_UPDATE_FIELD,
        OpCode.OP_INSERT_ROW,
      ]);
      const allNumericOpcodes = Object.values(OpCode).filter(
        (v): v is number => typeof v === "number",
      );
      expect(testedOpcodes.size).toBe(71);
      for (const op of allNumericOpcodes) {
        expect(
          testedOpcodes.has(op) || unimplementedOpcodes.has(op),
          `OpCode 0x${op.toString(16)} is missing from exhaustive disassembler test`,
        ).toBe(true);
      }

      const decoded = disassembleBytecode(emitter.toByteArray(), table);
      expect(decoded).toEqual(expected);

      // Verify unknown opcode fallback advances PC by 1 and doesn't corrupt trailing instructions
      const unknownBytes = new Uint8Array([0xff, OpCode.OP_HALT]);
      expect(disassembleBytecode(unknownBytes)).toEqual([
        {
          addr: 0,
          opcode: "OP_UNKNOWN(0xff)",
          p1: "",
          p2: "",
          p3: "",
          comment: "Unknown opcode",
        },
        {
          addr: 1,
          opcode: "OP_HALT",
          p1: "",
          p2: "",
          p3: "",
          comment: "Halt VM execution (STATUS_DONE)",
        },
      ]);
    });
  });
});
