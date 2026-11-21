import { describe, it, expect, beforeEach } from "vitest";
import { WebDB } from "../src/host/api/webdb.js";
import {
  DataType,
  ColumnFlag,
  OpCode,
  VmStatus,
  UnknownFunctionError,
  InvalidDatabaseError,
  TableMeta,
} from "../src/types/index.js";
import {
  PAGE_SIZE,
  BYTECODE_SIZE,
  MAX_IN_LIST_SIZE,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_OVERFLOW,
  HEADER_OFFSET_FREE_PAGE_HEAD,
  HEADER_OFFSET_PAGE_CHECKSUM,
  INDEX_CATALOG_OFFSET,
} from "../src/constants.js";
import {
  compileQuery,
  chooseIndexScan,
  normalizeFilter,
  BytecodeEmitter,
  type QueryFilter,
} from "../src/host/compiler/compiler.js";
import {
  parseExpression,
  evalExprNode,
  evalExprNodeBatch,
} from "../src/host/compiler/expr_parser.js";
import {
  CostBasedPlanner,
  CustomOrderPlanner,
} from "../src/host/compiler/planner/index.js";
import {
  vm_step,
  catalog_list_table_descriptors,
  catalog_update_page1_checksum,
} from "../src/core/index.js";
import { createVmContext } from "../src/shared/index.js";
import { computePageChecksum } from "../src/host/storage/crc32.js";
import {
  damerauLevenshtein,
  ngrams,
  wordNgrams,
  computeBM25ScoreRow,
} from "../src/search/index.js";
import { padLeft, padRight, regexpMatch } from "../src/intl/index.js";

describe("Phase 2: Compiler, Planner, VM & Security Hardening", () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({ name: "test_phase2_db", storage: "memory" });
  });

  // 1. OP_LOAD_BLOB extra u32 & multi_point driving-table join fixes
  describe("OP_LOAD_BLOB & Join Driving-Table Index Scans", () => {
    it("executes a join whose driving table uses a composite unique index scan", async () => {
      await db.createTable("accounts", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "tenant", type: DataType.TEXT },
        { name: "code", type: DataType.INT32 },
      ]);
      await db.createIndex("accounts", ["tenant", "code"], {
        name: "idx_tenant_code",
        unique: true,
      });
      await db.createTable("orders", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "account_id", type: DataType.INT32 },
        { name: "total", type: DataType.INT32 },
      ]);

      await db.insert("accounts", { id: 1, tenant: "acme", code: 100 });
      await db.insert("accounts", { id: 2, tenant: "acme", code: 200 });
      await db.insert("accounts", { id: 3, tenant: "beta", code: 100 });
      await db.insert("orders", { id: 10, account_id: 1, total: 500 });
      await db.insert("orders", { id: 11, account_id: 2, total: 900 });

      // Verify explain/bytecode actually hits composite table0Scan + OP_LOAD_BLOB
      const qb = db
        .from("accounts")
        .innerJoin("orders", "accounts.id", "=", "orders.account_id")
        .where("accounts.tenant", "=", "acme")
        .where("accounts.code", "=", 100)
        .select("accounts.id AS aid", "orders.total AS total");

      const explained = await qb.explain();
      expect(explained.plan.scanType).toBe("IndexScan");
      expect(explained.plan.indexName).toBe("idx_tenant_code");
      expect(
        explained.instructions.some((ins) => ins.opcode === "OP_LOAD_BLOB"),
      ).toBe(true);

      const rows = await qb.toArray();
      expect(rows).toEqual([{ aid: 1, total: 500 }]);
    });

    it("executes a join whose driving table has whereIn on an indexed PK (multi_point fallback)", async () => {
      await db.createTable("users", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "name", type: DataType.TEXT },
      ]);
      await db.createTable("posts", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "user_id", type: DataType.INT32 },
        { name: "title", type: DataType.TEXT },
      ]);

      await db.insert("users", { id: 1, name: "Alice" });
      await db.insert("users", { id: 2, name: "Bob" });
      await db.insert("users", { id: 3, name: "Charlie" });
      await db.insert("posts", { id: 100, user_id: 1, title: "Hello" });
      await db.insert("posts", { id: 101, user_id: 3, title: "World" });

      // Confirm chooseIndexScan recognizes qualified users.id as multi_point,
      // and compileQuery explicitly drops multi_point for join driving-table scans.
      const usersMeta = (await db.getTable("users"))!;
      const inFilter: QueryFilter = {
        type: "in",
        colName: "users.id",
        values: [1, 3],
        notIn: false,
      };
      expect(chooseIndexScan(usersMeta, [inFilter])?.scanType).toBe("multi_point");

      const qb = db
        .from("users")
        .innerJoin("posts", "users.id", "=", "posts.user_id")
        .whereIn("users.id", [1, 3])
        .select("users.name AS author", "posts.title AS title");

      const explained = await qb.explain();
      expect(explained.plan.scanType).toBe("TableScan");
      expect(explained.plan.indexName).toBeUndefined();

      const rows = await qb.toArray();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.author).sort()).toEqual(["Alice", "Charlie"]);
    });
  });

  // 2. BigInt (INT64) 64-bit constants & where_optimizer serialization
  describe("BigInt (INT64) 64-bit Constant Precision", () => {
    it("compares INT64 values > 2^32 without 32-bit truncation in WHERE, IN, and HAVING", async () => {
      await db.createTable("events", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "grp", type: DataType.TEXT },
        { name: "ts", type: DataType.INT64 },
      ]);

      const t1 = 5_000_000_000n;
      const t2 = 6_000_000_000n;
      const t3 = -5_000_000_000n;
      // Same low 32 bits as 5_000_000_000n (705032704)
      const tCollision = 705_032_704n;

      await db.insert("events", { id: 1, grp: "a", ts: t1 });
      await db.insert("events", { id: 2, grp: "a", ts: t2 });
      await db.insert("events", { id: 3, grp: "b", ts: t3 });
      await db.insert("events", { id: 4, grp: "b", ts: tCollision });

      const eqRows = await db.from("events").where("ts", "=", t1).toArray();
      expect(eqRows.map((r) => r.id)).toEqual([1]);

      const gtRows = await db
        .from("events")
        .where("ts", ">", 4_500_000_000n)
        .toArray();
      expect(gtRows.map((r) => r.id).sort()).toEqual([1, 2]);

      const ltRows = await db.from("events").where("ts", "<", 0n).toArray();
      expect(ltRows.map((r) => r.id)).toEqual([3]);

      // CostBasedPlanner filterSignature must not throw on BigInt in whereIn
      const inRows = await db
        .from("events")
        .whereIn("ts", [t1, t2])
        .toArray();
      expect(inRows.map((r) => r.id).sort()).toEqual([1, 2]);

      // HAVING with BigInt > 2^32
      const havingRows = await db
        .from("events")
        .groupBy("grp")
        .sum("ts", "total_ts")
        .having("total_ts", ">", 5_000_000_000n)
        .toArray();
      expect(havingRows.map((r) => r.grp)).toEqual(["a"]);
    });
  });

  // 3. Dynamic scratchBaseReg (fixing hardcoded tempReg = 50)
  describe("Dynamic Scratch Registers (No tempReg = 50 Clobber)", () => {
    it("evaluates queries with >= 26 leaf filters + expression filter + ORDER BY expression", async () => {
      await db.createTable("metrics", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "label", type: DataType.TEXT },
        { name: "val", type: DataType.INT32 },
      ]);
      await db.insert("metrics", { id: 1, label: "alice", val: 50 });
      await db.insert("metrics", { id: 2, label: "bob", val: 30 });
      await db.insert("metrics", { id: 3, label: "alice", val: 10 });

      // 26 non-subsumed leaf filters occupy registers 0..51 (straddling reg 50!)
      let q = db.from("metrics");
      for (let i = 100; i < 126; i++) {
        q = q.where("val", "!=", i);
      }
      const rows = await q
        .where("upper(label) = 'ALICE'")
        .orderBy("val + 0", "asc")
        .toArray();

      expect(rows.map((r) => r.id)).toEqual([3, 1]);
    });
  });

  // 4. buildRootFilter / normalizeFilter object-identity preservation
  describe("Filter Normalization & Object Identity", () => {
    it("preserves distinct IN sets across joined tables and enforces MAX_IN_LIST_SIZE under NOT", async () => {
      await db.createTable("t1", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "tag", type: DataType.TEXT },
      ]);
      await db.createTable("t2", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "t1_id", type: DataType.INT32 },
        { name: "kind", type: DataType.TEXT },
      ]);
      await db.insert("t1", { id: 1, tag: "alpha" });
      await db.insert("t1", { id: 2, tag: "beta" });
      await db.insert("t2", { id: 10, t1_id: 1, kind: "x" });
      await db.insert("t2", { id: 11, t1_id: 2, kind: "y" });

      const rows = await db
        .from("t1")
        .innerJoin("t2", "t1.id", "=", "t2.t1_id")
        .whereIn("t1.tag", ["alpha", "beta"])
        .whereIn("t2.kind", ["y"])
        .select("t1.id AS id1", "t2.kind AS kind")
        .toArray();

      expect(rows).toEqual([{ id1: 2, kind: "y" }]);

      // NOT (x IN oversized) must enforce MAX_IN_LIST_SIZE
      const oversized: QueryFilter = {
        type: "not",
        child: {
          type: "in",
          colName: "id",
          values: new Array(MAX_IN_LIST_SIZE + 1).fill(1),
        },
      };
      expect(() => normalizeFilter(oversized)).toThrow(RangeError);
    });
  });

  // 5. LEFT JOIN transitive predicate & null-row semantics
  describe("LEFT JOIN Correctness", () => {
    beforeEach(async () => {
      await db.createTable("customers", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "name", type: DataType.TEXT },
      ]);
      await db.createTable("invoices", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "customer_id", type: DataType.INT32 },
        { name: "status", type: DataType.TEXT },
      ]);

      await db.insert("customers", { id: 1, name: "Alice" });
      await db.insert("customers", { id: 2, name: "Bob" });
      await db.insert("customers", { id: 3, name: "Carol" });
      await db.insert("invoices", { id: 10, customer_id: 1, status: "paid" });
    });

    it("supports LEFT JOIN anti-join (WHERE A.id = 2 AND B.customer_id IS NULL)", async () => {
      const rows = await db
        .from("customers")
        .leftJoin("invoices", "customers.id", "=", "invoices.customer_id")
        .where("customers.id", "=", 2)
        .whereNull("invoices.customer_id")
        .select("customers.name AS cname", "invoices.status AS status")
        .toArray();

      expect(rows).toEqual([{ cname: "Bob", status: null }]);
    });

    it("applies WHERE filters on the right table to null-extended LEFT JOIN rows", async () => {
      const rows = await db
        .from("customers")
        .leftJoin("invoices", "customers.id", "=", "invoices.customer_id")
        .where("invoices.status", "=", "paid")
        .select("customers.name AS cname", "invoices.status AS status")
        .toArray();

      // Unmatched rows (Bob, Carol) have NULL status and MUST be filtered out
      expect(rows).toEqual([{ cname: "Alice", status: "paid" }]);
    });

    it("evaluates non-trivial expressions like COALESCE/UPPER on unmatched LEFT JOIN rows as NULL", async () => {
      const rows = await db
        .from("customers")
        .leftJoin("invoices", "customers.id", "=", "invoices.customer_id")
        .select(
          "customers.id AS cid",
          "COALESCE(invoices.status, 'none') AS eff_status",
          "UPPER(invoices.status) AS upper_status",
        )
        .toArray();

      rows.sort((a, b) => Number(a.cid) - Number(b.cid));
      expect(rows).toEqual([
        { cid: 1, eff_status: "paid", upper_status: "PAID" },
        { cid: 2, eff_status: "none", upper_status: null },
        { cid: 3, eff_status: "none", upper_status: null },
      ]);
    });
  });

  // 6. Join Planner: non-equi flip, CustomOrderPlanner filter pushdown, DP cap
  describe("Join Planner Fixes", () => {
    it("flips directional operator when non-equi join tables are reordered", async () => {
      await db.createTable("left_t", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "v", type: DataType.INT32 },
      ]);
      await db.createTable("right_t", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "v", type: DataType.INT32 },
      ]);
      await db.insert("left_t", { id: 1, v: 10 });
      await db.insert("left_t", { id: 2, v: 30 });
      await db.insert("right_t", { id: 1, v: 20 });

      // Force reverse join order (right_t first, then left_t) on left_t.v < right_t.v
      const rows = await db
        .from("left_t")
        .innerJoin("right_t", "left_t.v", "<", "right_t.v")
        .withPlanner(new CustomOrderPlanner(["right_t", "left_t"]))
        .select("left_t.v AS lv", "right_t.v AS rv")
        .toArray();

      // Only (10, 20) satisfies 10 < 20 (NOT (30, 20))
      expect(rows).toEqual([{ lv: 10, rv: 20 }]);
    });

    it("pushes single-table filters to the correct tables under CustomOrderPlanner", async () => {
      await db.createTable("a", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "tag", type: DataType.TEXT },
      ]);
      await db.createTable("b", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "a_id", type: DataType.INT32 },
        { name: "score", type: DataType.INT32 },
      ]);
      await db.insert("a", { id: 1, tag: "keep" });
      await db.insert("a", { id: 2, tag: "drop" });
      await db.insert("b", { id: 10, a_id: 1, score: 90 });
      await db.insert("b", { id: 11, a_id: 1, score: 10 });
      await db.insert("b", { id: 12, a_id: 2, score: 95 });

      const rows = await db
        .from("a")
        .innerJoin("b", "a.id", "=", "b.a_id")
        .where("a.tag", "=", "keep")
        .where("b.score", ">", 50)
        .withPlanner(new CustomOrderPlanner(["b", "a"]))
        .select("a.id AS aid", "b.score AS score")
        .toArray();

      expect(rows).toEqual([{ aid: 1, score: 90 }]);
    });

    it("falls back to HeuristicPlanner when CostBasedPlanner receives > 12 joined tables", () => {
      const tables: TableMeta[] = [];
      for (let i = 0; i < 14; i++) {
        tables.push({
          name: `t${i}`,
          rootPageId: i + 2,
          colCatalogPageId: 0,
          columns: [
            { name: "id", type: DataType.INT32, flags: ColumnFlag.PRIMARY_KEY, colOffset: 0 },
          ],
          indexes: [],
          rowCountEstimate: 10 + i,
        });
      }
      const joinedTables = tables.slice(1).map((t, idx) => ({
        type: "inner" as const,
        table: t,
        cursor: idx + 1,
        leftCol: `t${idx}.id`,
        op: "=" as const,
        rightCol: `${t.name}.id`,
      }));

      const t0 = performance.now();
      const res = new CostBasedPlanner().optimize({
        table: tables[0],
        joinedTables,
        filters: [],
      });
      const elapsed = performance.now() - t0;

      expect(res.orderedTables).toHaveLength(14);
      expect(elapsed).toBeLessThan(200);
    });
  });

  // 7. Prototype-chain lookup hardening
  describe("Prototype-Chain Safety", () => {
    it("rejects Object.prototype function names in compiler expressions", () => {
      const dummyTable: TableMeta = {
        name: "items",
        rootPageId: 2,
        colCatalogPageId: 0,
        columns: [
          { name: "id", type: DataType.INT32, flags: ColumnFlag.PRIMARY_KEY, colOffset: 0 },
        ],
        indexes: [],
      };
      expect(() =>
        compileQuery({
          table: dummyTable,
          filters: [],
          selectExprs: [{ expr: parseExpression("constructor(id)"), alias: "c" }],
        }),
      ).toThrow(UnknownFunctionError);
      expect(() =>
        compileQuery({
          table: dummyTable,
          filters: [],
          selectExprs: [{ expr: parseExpression("toString(id)"), alias: "s" }],
        }),
      ).toThrow(UnknownFunctionError);
    });

    it("guards prototype properties in evalExprNode, evalExprNodeBatch, and BM25", () => {
      const row = { id: 1 };
      expect(evalExprNode(parseExpression("constructor"), row)).toBeNull();
      expect(evalExprNode(parseExpression("toString"), row)).toBeNull();
      expect(() =>
        evalExprNode(parseExpression("toString(id)"), row, {}),
      ).toThrow(UnknownFunctionError);

      // Columnar batch missing column must return nulls (not crash or read prototype)
      const colBatch = { id: [1, 2] };
      expect(evalExprNodeBatch(parseExpression("missing_col"), colBatch)).toEqual([
        null,
        null,
      ]);
      expect(evalExprNodeBatch(parseExpression("toString"), colBatch)).toEqual([
        null,
        null,
      ]);

      // BM25 must not read Object.prototype.constructor as a document frequency
      const score = computeBM25ScoreRow(
        "constructor toString valueOf",
        { totalDocs: 10, docFreqs: {} },
        ["constructor toString valueOf"],
      );
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThan(0);
    });

    it("does not pollute Object.prototype when projecting prototype-named aliases", async () => {
      await db.createTable("docs", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "body", type: DataType.TEXT },
      ]);
      await db.insert("docs", { id: 1, body: "safe" });

      const sub = db.from("docs").select("id", "body");
      const rows = await db
        .from(sub)
        .select("body AS toString", "id AS constructor")
        .toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0].toString).toBe("safe");
      expect(rows[0].constructor).toBe(1);
      expect(({} as any).polluted).toBeUndefined();
    });
  });

  // 8. VM Bytecode & Untrusted importBinary Validation
  describe("VM Bytecode & Untrusted Binary Import Validation", () => {
    it("returns INVALID_BYTECODE for oversized, truncated, and out-of-range bytecode", () => {
      const buf = new ArrayBuffer(1024 * 1024);
      const view = new DataView(buf);

      // 1. Oversized bytecode (> BYTECODE_SIZE)
      const ctx1 = createVmContext();
      expect(vm_step(ctx1, view, new Uint8Array(BYTECODE_SIZE + 1))).toBe(
        VmStatus.INVALID_BYTECODE,
      );

      // 2. Truncated OP_LOAD_TEXT length > remaining bytecode
      const ctx2 = createVmContext();
      const truncText = new Uint8Array([OpCode.OP_LOAD_TEXT, 0, 0xff, 0x00, 0x41]);
      expect(vm_step(ctx2, view, truncText)).toBe(VmStatus.INVALID_BYTECODE);

      // 3. Register index >= 64
      const ctx3 = createVmContext();
      const badReg = new Uint8Array([OpCode.OP_LOAD_NULL, 64]);
      expect(vm_step(ctx3, view, badReg)).toBe(VmStatus.INVALID_BYTECODE);

      // 4. Cursor index >= 16
      const ctx4 = createVmContext();
      const badCursor = new Uint8Array([OpCode.OP_OPEN_CURSOR, 20, 2, 0, 0, 0]);
      expect(vm_step(ctx4, view, badCursor)).toBe(VmStatus.INVALID_BYTECODE);

      // 5. Sorter ID >= 4
      const ctx5 = createVmContext();
      const badSorter = new Uint8Array([OpCode.OP_SORTER_OPEN, 5, 0]);
      expect(vm_step(ctx5, view, badSorter)).toBe(VmStatus.INVALID_BYTECODE);

      // 6. Aggregator ID >= 4
      const ctx6 = createVmContext();
      const badAgg = new Uint8Array([OpCode.OP_AGG_INIT, 4, 0, 1, 0]);
      expect(vm_step(ctx6, view, badAgg)).toBe(VmStatus.INVALID_BYTECODE);

      // 7. Comprehensive bounds checks across remaining opcodes (arithmetic, column, index, string, jump, offset/limit)
      const invalidPrograms: Uint8Array[] = [
        new Uint8Array([OpCode.OP_ADD, 255, 255, 255]),
        new Uint8Array([OpCode.OP_SUB, 0, 64, 0]),
        new Uint8Array([OpCode.OP_MUL, 0, 0, 64]),
        new Uint8Array([OpCode.OP_DIV, 64, 0, 0]),
        new Uint8Array([OpCode.OP_MOD, 0, 64, 0]),
        new Uint8Array([OpCode.OP_COLUMN_INT, 200, 0, 0]),
        new Uint8Array([OpCode.OP_COLUMN_INT, 0, 0, 200]),
        new Uint8Array([OpCode.OP_COLUMN_FLOAT, 16, 0, 0]),
        new Uint8Array([OpCode.OP_COLUMN_TEXT, 0, 0, 64]),
        new Uint8Array([OpCode.OP_COLUMN_BLOB, 16, 0, 64]),
        new Uint8Array([OpCode.OP_OPEN_INDEX, 20, 2, 0, 0, 0]),
        new Uint8Array([OpCode.OP_INDEX_SEEK_EQ, 20, 0, 0, 0, 0, 0]),
        new Uint8Array([OpCode.OP_INDEX_SEEK_GE, 0, 20, 0, 0, 0, 0]),
        new Uint8Array([OpCode.OP_INDEX_SEEK_GE, 0, 0, 64, 0, 0, 0]),
        new Uint8Array([OpCode.OP_INDEX_NEXT, 0, 20, 0, 0]),
        new Uint8Array([OpCode.OP_IS_NULL, 20, 0, 0, 0]),
        new Uint8Array([OpCode.OP_IS_NOT_NULL, 20, 0, 0, 0]),
        new Uint8Array([OpCode.OP_EQ, 64, 0, 0, 0]),
        new Uint8Array([OpCode.OP_NE, 0, 64, 0, 0]),
        new Uint8Array([OpCode.OP_GT, 64, 0, 0, 0]),
        new Uint8Array([OpCode.OP_GE, 0, 64, 0, 0]),
        new Uint8Array([OpCode.OP_LT, 64, 0, 0, 0]),
        new Uint8Array([OpCode.OP_LE, 0, 64, 0, 0]),
        new Uint8Array([OpCode.OP_JUMP, 0]), // truncated
        new Uint8Array([OpCode.OP_STR_LIKE, 64, 0, 0, 0]),
        new Uint8Array([OpCode.OP_STR_NOT_LIKE, 0, 64, 0, 0]),
        new Uint8Array([OpCode.OP_STR_CONTAINS, 64, 0, 0, 0]),
        new Uint8Array([OpCode.OP_STR_STARTS_WITH, 0, 64, 0, 0]),
        new Uint8Array([OpCode.OP_STR_ENDS_WITH, 64, 0, 0, 0]),
        new Uint8Array([OpCode.OP_STR_FUZZY_MATCH, 0, 64, 0, 0]),
        new Uint8Array([OpCode.OP_IN, 64, 0, 0, 0, 0]),
        new Uint8Array([OpCode.OP_EMIT_ROW, 20]),
        new Uint8Array([OpCode.OP_OFFSET, 64, 0, 0]),
        new Uint8Array([OpCode.OP_LIMIT, 64, 0, 0]),
        new Uint8Array([OpCode.OP_STR_LOWER, 64, 0]),
        new Uint8Array([OpCode.OP_STR_UPPER, 0, 64]),
        new Uint8Array([OpCode.OP_STR_LENGTH, 64, 0]),
        new Uint8Array([OpCode.OP_STR_SUBSTR, 0, 0, 0, 64]),
        new Uint8Array([OpCode.OP_STR_TRIM, 64, 0]),
        new Uint8Array([OpCode.OP_STR_LEVENSHTEIN, 0, 64, 0]),
        new Uint8Array([OpCode.OP_MATH_ABS, 64, 0]),
        new Uint8Array([OpCode.OP_MATH_ROUND, 0, 64]),
        new Uint8Array([OpCode.OP_MATH_FLOOR, 64, 0]),
        new Uint8Array([OpCode.OP_MATH_CEIL, 0, 64]),
        new Uint8Array([OpCode.OP_LAST, 20, 0, 0]),
        new Uint8Array([OpCode.OP_PREV_ROW, 20, 0, 0]),
      ];
      for (const prog of invalidPrograms) {
        const c = createVmContext();
        expect(vm_step(c, view, prog)).toBe(VmStatus.INVALID_BYTECODE);
      }

      // 8. BytecodeEmitter rejects uint16 jump overflow and out-of-range int64
      const em = new BytecodeEmitter();
      expect(() => em.emitUint16(70000)).toThrow(RangeError);
      expect(() => em.emitInt64(9223372036854775808n)).toThrow(RangeError);
      expect(() => em.emitInt64(-9223372036854775809n)).toThrow(RangeError);
    });

    it("fails with VM error on self-cyclic overflow page instead of returning corrupted data", async () => {
      await db.createTable("blobs", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "content", type: DataType.TEXT },
      ]);
      // > 4KB string spans multiple overflow pages
      const bigText = "A".repeat(9000);
      await db.insert("blobs", { id: 1, content: bigText });

      const img = new Uint8Array(await db.exportBinary());
      const numPages = img.byteLength / PAGE_SIZE;

      // Find the first overflow page and make it point to itself (self-cycle)
      let foundOverflowPid = -1;
      for (let p = 2; p <= numPages; p++) {
        const off = (p - 1) * PAGE_SIZE;
        if (img[off] === PAGE_TYPE_OVERFLOW) {
          foundOverflowPid = p;
          const v = new DataView(img.buffer, off, PAGE_SIZE);
          v.setUint32(6, p, true); // next_pid = curr_pid (self-cycle!)
          v.setUint32(12, 0, true);
          v.setUint32(
            12,
            computePageChecksum(img.subarray(off, off + PAGE_SIZE)),
            true,
          );
          break;
        }
      }
      expect(foundOverflowPid).toBeGreaterThanOrEqual(2);

      const db2 = await WebDB.open({ name: "test_cyclic_overflow", storage: "memory" });
      await db2.importBinary(img);

      // Querying the column in WHERE triggers vm_load_overflow_column inside VM
      await expect(
        db2.from("blobs").where("content", "like", "A%").toArray(),
      ).rejects.toThrow(/VM execution error/);
    });

    it("rejects corrupted/cyclic catalog chains in importBinary without harming live DB", async () => {
      await db.createTable("live_items", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "name", type: DataType.TEXT },
      ]);
      await db.insert("live_items", { id: 1, name: "original" });

      const validExport = await db.exportBinary();

      // Case A: Wrong page type on column catalog page
      const badCatTypeImg = new Uint8Array(validExport);
      const p1 = new DataView(badCatTypeImg.buffer, 0, PAGE_SIZE);
      const descs = catalog_list_table_descriptors(p1, {
        getPageBytes: (pid) =>
          badCatTypeImg.subarray((pid - 1) * PAGE_SIZE, pid * PAGE_SIZE),
      });
      const colCatPid = descs[0].colCatalogPageId;
      expect(colCatPid).toBeGreaterThanOrEqual(2);
      const colCatOff = (colCatPid - 1) * PAGE_SIZE;
      const colCatView = new DataView(badCatTypeImg.buffer, colCatOff, PAGE_SIZE);
      colCatView.setUint8(0, PAGE_TYPE_LEAF_DATA); // Wrong page type!
      colCatView.setUint32(12, 0, true);
      colCatView.setUint32(
        12,
        computePageChecksum(badCatTypeImg.subarray(colCatOff, colCatOff + PAGE_SIZE)),
        true,
      );

      await expect(db.importBinary(badCatTypeImg)).rejects.toThrow(
        InvalidDatabaseError,
      );

      // Case B: Self-cycle on column catalog page (NEXT_COL_CATALOG_PAGE_ID at offset 8)
      const cyclicColImg = new Uint8Array(validExport);
      const cyclicColView = new DataView(cyclicColImg.buffer, colCatOff, PAGE_SIZE);
      cyclicColView.setUint32(8, colCatPid, true); // nextColCatalogPageId -> self
      cyclicColView.setUint32(12, 0, true);
      cyclicColView.setUint32(
        12,
        computePageChecksum(cyclicColImg.subarray(colCatOff, colCatOff + PAGE_SIZE)),
        true,
      );

      await expect(db.importBinary(cyclicColImg)).rejects.toThrow(
        InvalidDatabaseError,
      );

      // Case C: Invalid colCountInPage (> 56)
      const badColCountImg = new Uint8Array(validExport);
      const badColCountView = new DataView(badColCountImg.buffer, colCatOff, PAGE_SIZE);
      badColCountView.setUint16(2, 200, true);
      badColCountView.setUint32(12, 0, true);
      badColCountView.setUint32(
        12,
        computePageChecksum(badColCountImg.subarray(colCatOff, colCatOff + PAGE_SIZE)),
        true,
      );

      await expect(db.importBinary(badColCountImg)).rejects.toThrow(
        InvalidDatabaseError,
      );

      // Case D: Out-of-bounds freePageHead in Page 1 header
      const badFreeHeadImg = new Uint8Array(validExport);
      const badFreeP1 = new DataView(badFreeHeadImg.buffer, 0, PAGE_SIZE);
      badFreeP1.setUint32(HEADER_OFFSET_FREE_PAGE_HEAD, 999, true);
      badFreeP1.setUint32(HEADER_OFFSET_PAGE_CHECKSUM, 0, true);
      catalog_update_page1_checksum(badFreeP1);

      await expect(db.importBinary(badFreeHeadImg)).rejects.toThrow(
        InvalidDatabaseError,
      );

      // Case E: Out-of-bounds index rootPageId
      await db.createIndex("live_items", ["name"], { name: "idx_live_name" });
      const indexedExport = await db.exportBinary();
      const badIdxImg = new Uint8Array(indexedExport);
      const badIdxP1 = new DataView(badIdxImg.buffer, 0, PAGE_SIZE);
      // First index descriptor slot is at INDEX_CATALOG_OFFSET; rootPageId is at +4
      badIdxP1.setUint32(INDEX_CATALOG_OFFSET + 4, 999, true);
      badIdxP1.setUint32(HEADER_OFFSET_PAGE_CHECKSUM, 0, true);
      catalog_update_page1_checksum(badIdxP1);

      await expect(db.importBinary(badIdxImg)).rejects.toThrow(
        InvalidDatabaseError,
      );

      // Live DB MUST remain completely intact after all rejected imports!
      const liveRows = await db.from("live_items").toArray();
      expect(liveRows).toEqual([{ id: 1, name: "original" }]);
    });
  });

  // 9. DoS Vectors: damerauLevenshtein, ngrams, LIKE ReDoS, padLeft, recursion depth
  describe("DoS Hardening (Search, Intl, LIKE ReDoS, Recursion)", () => {
    it("computes damerauLevenshtein in O(min(n,m)) space with Ukkonen band, handles NaN, and bounds CPU work", () => {
      expect(damerauLevenshtein("tehs", "thes")).toBe(1);
      expect(damerauLevenshtein("kitten", "sitting")).toBe(3);
      expect(damerauLevenshtein("abcdef", "abcfed")).toBe(2);
      expect(damerauLevenshtein("hello", "helo", 1)).toBe(1);
      expect(damerauLevenshtein("hello", "world", 2)).toBeGreaterThan(2);
      expect(Number.isNaN(damerauLevenshtein("abc", "def", NaN))).toBe(true);

      // Previously allocated 2000x2000 = 4M JS array elements (~32 MB) even with maxDistance=2
      const s1 = "a".repeat(2000);
      const s2 = "a".repeat(1999) + "b";
      const t0 = performance.now();
      const d = damerauLevenshtein(s1, s2, 2);
      const elapsed = performance.now() - t0;
      expect(d).toBe(1);
      expect(elapsed).toBeLessThan(50);

      // Unbounded huge strings throw RangeError immediately instead of freezing the event loop
      expect(() =>
        damerauLevenshtein("a".repeat(5000), "b".repeat(5000)),
      ).toThrow(RangeError);
    });

    it("guards ngrams and wordNgrams against non-positive, fractional, or huge n", () => {
      expect(ngrams("webdb", 0)).toEqual([]);
      expect(ngrams("webdb", -3)).toEqual([]);
      expect(ngrams("webdb", 2.5)).toEqual([]);
      expect(ngrams("webdb", 1e9, { pad: true })).toEqual([]);
      expect(wordNgrams("fast db", 0)).toEqual([]);
      expect(wordNgrams("fast db", -1)).toEqual([]);
      expect(wordNgrams("fast db", 100)).toEqual([]);
    });

    it("avoids ReDoS in QueryBuilder materialized LIKE evaluation", async () => {
      await db.createTable("texts", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "s", type: DataType.TEXT },
      ]);
      await db.insert("texts", { id: 1, s: "a".repeat(40) });
      await db.insert("texts", { id: 2, s: "a".repeat(25) + "b" });

      const evilPattern = "%a".repeat(20) + "%b";
      const sub = db.from("texts").select("id", "s");
      const t0 = performance.now();
      const rows = await db
        .from(sub)
        .where("s", "like", evilPattern)
        .toArray();
      const elapsed = performance.now() - t0;

      expect(rows.map((r) => r.id)).toEqual([2]);
      expect(elapsed).toBeLessThan(100);
    });

    it("caps padLeft/padRight length and regexpMatch pattern length", () => {
      expect(padLeft("x", 1e9)?.length).toBe(65536);
      expect(padRight("x", 1e9)?.length).toBe(65536);
      expect(padLeft("x", Infinity)).toBe("x");
      // Pattern > 1024 chars is rejected by getRegExp and returns 0 cleanly
      const longStr = "a".repeat(2000);
      expect(regexpMatch(longStr, "a{10}")).toBe(1);
      expect(regexpMatch(longStr, longStr)).toBe(0);
    });

    it("guards deeply nested expressions and filters against stack overflow", () => {
      const deepExpr = "(".repeat(120) + "1" + ")".repeat(120);
      expect(() => parseExpression(deepExpr)).toThrow(RangeError);

      let deepFilter: QueryFilter = { type: "cmp", colName: "id", op: "=", value: 1 };
      for (let i = 0; i < 100; i++) {
        deepFilter = { type: "and", children: [deepFilter] };
      }
      expect(() => normalizeFilter(deepFilter)).toThrow(RangeError);
    });
  });

  // 10. PR #2 Review Follow-Ups: Chained LEFT JOINs, Filter Mutation, Expr-String IN 3VL, INT64 > 2^53 UDFs
  describe("PR #2 Review Hardening (Chained LEFT JOINs, Filter Mutation, IN 3VL, INT64 UDFs)", () => {
    it("handles A LEFT JOIN B INNER JOIN C ON A.id = C.a_id and A LEFT JOIN B LEFT JOIN C ON A.id = C.a_id", async () => {
      await db.createTable("a", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "aname", type: DataType.TEXT },
      ]);
      await db.createTable("b", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "a_id", type: DataType.INT32 },
        { name: "bval", type: DataType.TEXT },
      ]);
      await db.createTable("c", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "a_id", type: DataType.INT32 },
        { name: "b_id", type: DataType.INT32 },
        { name: "cval", type: DataType.TEXT },
      ]);

      // a=1 matches b and c; a=2 has NO b, TWO c; a=3 has NO b, NO c
      await db.insert("a", { id: 1, aname: "A1" });
      await db.insert("a", { id: 2, aname: "A2" });
      await db.insert("a", { id: 3, aname: "A3" });
      await db.insert("b", { id: 10, a_id: 1, bval: "B10" });
      await db.insert("c", { id: 100, a_id: 1, b_id: 10, cval: "C100" });
      await db.insert("c", { id: 101, a_id: 2, b_id: 99, cval: "C101" });
      await db.insert("c", { id: 102, a_id: 2, b_id: 99, cval: "C102" });

      // 1. A LEFT JOIN B ON A.id = B.a_id INNER JOIN C ON A.id = C.a_id
      const leftInnerOnA = await db
        .from("a")
        .leftJoin("b", "a.id", "=", "b.a_id")
        .innerJoin("c", "a.id", "=", "c.a_id")
        .withPlanner(new CustomOrderPlanner(["a", "b", "c"]))
        .select("a.aname AS aname", "b.bval AS bval", "c.cval AS cval")
        .toArray();

      leftInnerOnA.sort((x, y) => String(x.cval).localeCompare(String(y.cval)));
      // A3 excluded (no match in C); A2 emitted TWICE with bval=null and C101/C102!
      expect(leftInnerOnA).toEqual([
        { aname: "A1", bval: "B10", cval: "C100" },
        { aname: "A2", bval: null, cval: "C101" },
        { aname: "A2", bval: null, cval: "C102" },
      ]);

      // 2. A LEFT JOIN B ON A.id = B.a_id INNER JOIN C ON B.id = C.b_id
      const leftInnerOnB = await db
        .from("a")
        .leftJoin("b", "a.id", "=", "b.a_id")
        .innerJoin("c", "b.id", "=", "c.b_id")
        .withPlanner(new CustomOrderPlanner(["a", "b", "c"]))
        .select("a.aname AS aname", "b.bval AS bval", "c.cval AS cval")
        .toArray();

      // Only A1->B10->C100 matches; A2/A3 have B.id = NULL so INNER JOIN C emits nothing
      expect(leftInnerOnB).toEqual([
        { aname: "A1", bval: "B10", cval: "C100" },
      ]);

      // 3. A LEFT JOIN B ON A.id = B.a_id LEFT JOIN C ON A.id = C.a_id
      const leftLeftOnA = await db
        .from("a")
        .leftJoin("b", "a.id", "=", "b.a_id")
        .leftJoin("c", "a.id", "=", "c.a_id")
        .withPlanner(new CustomOrderPlanner(["a", "b", "c"]))
        .select("a.aname AS aname", "b.bval AS bval", "c.cval AS cval")
        .toArray();

      leftLeftOnA.sort((x, y) =>
        `${x.aname}:${x.cval ?? ""}`.localeCompare(`${y.aname}:${y.cval ?? ""}`),
      );
      expect(leftLeftOnA).toEqual([
        { aname: "A1", bval: "B10", cval: "C100" },
        { aname: "A2", bval: null, cval: "C101" },
        { aname: "A2", bval: null, cval: "C102" },
        { aname: "A3", bval: null, cval: null },
      ]);
    });

    it("does not return stale cached results when a reused QueryFilter is mutated", () => {
      const filter: QueryFilter = {
        type: "in",
        colName: "id",
        values: [1, 1],
      };
      const first = normalizeFilter(filter);
      expect(first.values).toEqual([1]);

      filter.values!.push(2);
      const second = normalizeFilter(filter);
      expect(second.values).toEqual([1, 2]);
    });

    it("enforces SQL 3VL NULL exclusion for NOT IN with expression-string colName", async () => {
      await db.createTable("profiles", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "bio", type: DataType.TEXT },
      ]);
      await db.insert("profiles", { id: 1, bio: "coder" });
      await db.insert("profiles", { id: 2, bio: "designer" });
      await db.insert("profiles", { id: 3, bio: null });

      const rows = await db
        .from("profiles")
        .whereNotIn("upper(bio)", ["CODER"])
        .toArray();
      // Row 3 has bio=NULL -> upper(NULL)=NULL -> NULL NOT IN ('CODER') is UNKNOWN (excluded)
      expect(rows.map((r) => r.id)).toEqual([2]);
    });

    it("preserves INT64 precision > 2^53 when passing arguments to host JS UDFs", async () => {
      const bigVal = 9007199254740993n; // 2^53 + 1 (loses precision if cast to Number)
      db.registerFunction("echo_i64_str", {
        returnType: DataType.TEXT,
        call: (v: unknown) => `${typeof v}:${String(v)}`,
      });

      await db.createTable("bigs", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "v", type: DataType.INT64 },
      ]);
      await db.insert("bigs", { id: 1, v: bigVal });
      await db.insert("bigs", { id: 2, v: 42n });

      const rows = await db
        .from("bigs")
        .select("id", "echo_i64_str(v) AS repr")
        .toArray();
      rows.sort((a, b) => Number(a.id) - Number(b.id));
      expect(rows).toEqual([
        { id: 1, repr: "bigint:9007199254740993" },
        { id: 2, repr: "number:42" },
      ]);
    });

    it("handles BLOB (Uint8Array) constants in primary-key multi_point index scans", async () => {
      await db.createTable("blob_keys", [
        { name: "k", type: DataType.BLOB, primaryKey: true },
        { name: "label", type: DataType.TEXT },
      ]);
      const k1 = new Uint8Array([0x01, 0x02, 0x03]);
      const k2 = new Uint8Array([0x01, 0x02, 0x04]);
      const k3 = new Uint8Array([0x02, 0x00]);
      await db.insert("blob_keys", { k: k1, label: "first" });
      await db.insert("blob_keys", { k: k2, label: "second" });
      await db.insert("blob_keys", { k: k3, label: "third" });

      // Include a duplicate Uint8Array instance with identical bytes to verify deduplication
      const qb = db
        .from("blob_keys")
        .whereIn("k", [k3, new Uint8Array([0x01, 0x02, 0x03]), k1])
        .orderBy("k", "asc");

      const explained = await qb.explain();
      expect(explained.plan.scanType).toBe("IndexScan");
      expect(
        explained.instructions.some((ins) => ins.opcode === "OP_LOAD_BLOB"),
      ).toBe(true);

      const rows = await qb.toArray();
      expect(rows.map((r) => r.label)).toEqual(["first", "third"]);
    });

    it("does not drop distinct whereIn predicates whose string representations collide", async () => {
      await db.createTable("tags", [
        { name: "id", type: DataType.INT32, primaryKey: true },
        { name: "tag", type: DataType.TEXT },
      ]);
      await db.insert("tags", { id: 1, tag: "a,b" });
      await db.insert("tags", { id: 2, tag: "c" });
      await db.insert("tags", { id: 3, tag: "a" });
      await db.insert("tags", { id: 4, tag: "b,c" });

      // ["a,b", "c"] AND ["a", "b,c"] have disjoint elements — must NOT be deduplicated as identical
      const rows = await db
        .from("tags")
        .whereIn("tag", ["a,b", "c"])
        .whereIn("tag", ["a", "b,c"])
        .toArray();
      expect(rows).toEqual([]);

      // Also ensure "1n" (TEXT) and 1n (BigInt) / "1" and 1 do not collide in filterSignature
      const rows2 = await db
        .from("tags")
        .where("tag", "=", "a,b")
        .whereIn("tag", ["a,b", "c"])
        .toArray();
      expect(rows2.map((r) => r.id)).toEqual([1]);
    });
  });
});
