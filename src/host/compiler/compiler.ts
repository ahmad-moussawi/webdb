import {
  OpCode,
  DataType,
  TableMeta,
  ColumnMeta,
  ColumnFlag,
  IndexFlag,
  IndexDescriptor,
  TooManyRegistersError,
  TooManyOrderByColumnsError,
  TooManyGroupByColumnsError,
  TooManyCursorsError,
  UnknownFunctionError,
  JoinType,
} from "../../types/index.js";
import { serialize_composite_key } from "../../core/index.js";
import { VmKeyInfo } from "../../shared/vm_context.js";
import { MAX_IN_LIST_SIZE } from "../../constants.js";
import {
  ExprNode,
  ParsedSelectExpr,
  parseExpression,
  deriveDefaultAlias,
} from "./expr_parser.js";
import { QueryPlanner, resolveQueryPlanner } from "./planner.js";

export type ComparisonOp =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "like"
  | "not like"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not in";

const isInt32 = (v: number): boolean =>
  Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;

export function getCmpOpcode(op: string | undefined): OpCode {
  if (!op) return OpCode.OP_EQ;
  const norm = String(op).trim().toLowerCase().replace(/\s+/g, " ");
  switch (norm) {
    case "=":
    case "==":
      return OpCode.OP_EQ;
    case "!=":
    case "<>":
      return OpCode.OP_NE;
    case ">":
      return OpCode.OP_GT;
    case ">=":
      return OpCode.OP_GE;
    case "<":
      return OpCode.OP_LT;
    case "<=":
      return OpCode.OP_LE;
    case "like":
      return OpCode.OP_STR_LIKE;
    case "not like":
      return OpCode.OP_STR_NOT_LIKE;
    case "contains":
      return OpCode.OP_STR_CONTAINS;
    case "starts_with":
      return OpCode.OP_STR_STARTS_WITH;
    case "ends_with":
      return OpCode.OP_STR_ENDS_WITH;
    case "fuzzy":
      return OpCode.OP_STR_FUZZY_MATCH;
    default:
      return OpCode.OP_EQ;
  }
}

export type QueryFilterType =
  | "null"
  | "cmp"
  | "expr"
  | "and"
  | "or"
  | "not"
  | "in"
  | "exists";

export interface QueryFilter {
  type: QueryFilterType;
  colName?: string;
  isNull?: boolean; // true for isNull, false for isNotNull
  op?: ComparisonOp;
  value?: any;
  values?: any[];
  notIn?: boolean;
  subquery?: any;
  notExists?: boolean;
  expr?: ExprNode;
  children?: QueryFilter[]; // for 'and', 'or'
  child?: QueryFilter; // for 'not'
}

export interface SortKey {
  colName?: string;
  expr?: ExprNode;
  direction?: "asc" | "desc";
  nullOrder?: "nulls_first" | "nulls_last";
}

export interface GroupKey {
  colName?: string;
  expr?: ExprNode;
}

export type AggFunc = "count" | "sum" | "avg" | "min" | "max";

export interface AggExpr {
  func: AggFunc;
  colName?: string;
  alias?: string;
  fromHaving?: boolean;
}

export interface JoinPlan {
  type: JoinType;
  table: TableMeta;
  cursor: number;
  leftCol: string;
  op: ComparisonOp;
  rightCol: string;
}

export interface QueryPlan {
  table: TableMeta;
  joinedTables?: JoinPlan[];
  filters: QueryFilter[];
  orderBy?: SortKey[];
  groupBy?: (string | GroupKey)[];
  aggregates?: AggExpr[];
  having?: QueryFilter[];
  selectExprs?: ParsedSelectExpr[];
  udfNameMap?: Map<string, number>;
  udfDefs?: Map<string, { returnType?: DataType }>;
  keyInfos?: VmKeyInfo[];
  outputColumns?: ColumnMeta[];
  limit?: number;
  offset?: number;
  planner?: QueryPlanner;
  isOrderSatisfied?: boolean;
  sortCostAvoided?: number;
}

const SHARED_TEXT_ENCODER = new TextEncoder();
const SCRATCH_8_BUF = new ArrayBuffer(8);
const SCRATCH_8_VIEW = new DataView(SCRATCH_8_BUF);
const SCRATCH_8_U8 = new Uint8Array(SCRATCH_8_BUF);

const MAX_FILTER_DEPTH = 64;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

export interface JoinNullFlags {
  nullFlagRegs: Map<number, number>;
  regZero: number;
}

const INVERSE_OPS = new Map<string, ComparisonOp>([
  ["=", "!="],
  ["==", "!="],
  ["!=", "="],
  ["<>", "="],
  [">", "<="],
  [">=", "<"],
  ["<", ">="],
  ["<=", ">"],
  ["like", "not like"],
  ["not like", "like"],
]);

const UNARY_OPS = new Map<string, OpCode>([
  ["upper", OpCode.OP_STR_UPPER],
  ["lower", OpCode.OP_STR_LOWER],
  ["length", OpCode.OP_STR_LENGTH],
  ["trim", OpCode.OP_STR_TRIM],
  ["abs", OpCode.OP_MATH_ABS],
  ["round", OpCode.OP_MATH_ROUND],
  ["floor", OpCode.OP_MATH_FLOOR],
  ["ceil", OpCode.OP_MATH_CEIL],
]);

const PATTERN_OPS = new Map<string, OpCode>([
  ["starts_with", OpCode.OP_STR_STARTS_WITH],
  ["startswith", OpCode.OP_STR_STARTS_WITH],
  ["ends_with", OpCode.OP_STR_ENDS_WITH],
  ["endswith", OpCode.OP_STR_ENDS_WITH],
  ["like", OpCode.OP_STR_LIKE],
  ["contains", OpCode.OP_STR_CONTAINS],
  ["fuzzy", OpCode.OP_STR_FUZZY_MATCH],
]);

export class BytecodeEmitter {
  private buffer: number[] = [];

  emitUint8(val: number): number {
    const pos = this.buffer.length;
    this.buffer.push(val & 0xff);
    return pos;
  }

  emitUint16(val: number): number {
    if (val < 0 || val > 0xffff) {
      throw new RangeError(
        `Bytecode uint16 operand out of range: ${val} (must be 0..65535)`,
      );
    }
    const pos = this.buffer.length;
    this.buffer.push(val & 0xff);
    this.buffer.push((val >> 8) & 0xff);
    return pos;
  }

  emitUint32(val: number): number {
    const pos = this.buffer.length;
    this.buffer.push(val & 0xff);
    this.buffer.push((val >> 8) & 0xff);
    this.buffer.push((val >> 16) & 0xff);
    this.buffer.push((val >> 24) & 0xff);
    return pos;
  }

  emitInt32(val: number): number {
    return this.emitUint32(val);
  }

  emitInt64(val: bigint): number {
    if (val < INT64_MIN || val > INT64_MAX) {
      throw new RangeError(
        `Bytecode int64 operand out of range: ${val.toString()} (must fit in signed 64-bit integer)`,
      );
    }
    const pos = this.buffer.length;
    SCRATCH_8_VIEW.setBigInt64(0, val, true);
    for (let i = 0; i < 8; i++) {
      this.buffer.push(SCRATCH_8_U8[i]);
    }
    return pos;
  }

  emitFloat64(val: number): number {
    const pos = this.buffer.length;
    SCRATCH_8_VIEW.setFloat64(0, val, true);
    for (let i = 0; i < 8; i++) {
      this.buffer.push(SCRATCH_8_U8[i]);
    }
    return pos;
  }

  emitString(str: string): number {
    const bytes = SHARED_TEXT_ENCODER.encode(str);
    const pos = this.emitUint16(bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i++) {
      this.buffer.push(bytes[i]);
    }
    return pos;
  }

  emitBytes(bytes: Uint8Array): number {
    const pos = this.emitUint16(bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i++) {
      this.buffer.push(bytes[i]);
    }
    return pos;
  }

  patchUint16(pos: number, val: number): void {
    if (val < 0 || val > 0xffff) {
      throw new RangeError(
        `Bytecode jump target out of range: ${val} (must be 0..65535)`,
      );
    }
    this.buffer[pos] = val & 0xff;
    this.buffer[pos + 1] = (val >> 8) & 0xff;
  }

  currentOffset(): number {
    return this.buffer.length;
  }

  toByteArray(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}

function emitReadColumn(
  emitter: BytecodeEmitter,
  cursor: number,
  colIdx: number,
  destReg: number,
  colType: DataType,
): void {
  if (colType === DataType.INT32 || colType === DataType.INT64) {
    emitter.emitUint8(OpCode.OP_COLUMN_INT);
    emitter.emitUint8(cursor);
    emitter.emitUint8(colIdx);
    emitter.emitUint8(destReg);
  } else if (colType === DataType.FLOAT64) {
    emitter.emitUint8(OpCode.OP_COLUMN_FLOAT);
    emitter.emitUint8(cursor);
    emitter.emitUint8(colIdx);
    emitter.emitUint8(destReg);
  } else if (colType === DataType.TEXT) {
    emitter.emitUint8(OpCode.OP_COLUMN_TEXT);
    emitter.emitUint8(cursor);
    emitter.emitUint8(colIdx);
    emitter.emitUint8(destReg);
  } else if (colType === DataType.UUID) {
    emitter.emitUint8(OpCode.OP_COLUMN_UUID);
    emitter.emitUint8(cursor);
    emitter.emitUint8(colIdx);
    emitter.emitUint8(destReg);
  } else if (colType === DataType.ULID) {
    emitter.emitUint8(OpCode.OP_COLUMN_ULID);
    emitter.emitUint8(cursor);
    emitter.emitUint8(colIdx);
    emitter.emitUint8(destReg);
  } else if (colType === DataType.BLOB) {
    emitter.emitUint8(OpCode.OP_COLUMN_BLOB);
    emitter.emitUint8(cursor);
    emitter.emitUint8(colIdx);
    emitter.emitUint8(destReg);
  }
}

function emitReadColumnGuarded(
  emitter: BytecodeEmitter,
  cursor: number,
  colIdx: number,
  destReg: number,
  colType: DataType,
  joinNullFlags?: JoinNullFlags,
): void {
  const nullFlagReg = joinNullFlags?.nullFlagRegs.get(cursor);
  if (nullFlagReg === undefined) {
    emitReadColumn(emitter, cursor, colIdx, destReg, colType);
    return;
  }
  emitter.emitUint8(OpCode.OP_EQ);
  emitter.emitUint8(nullFlagReg);
  emitter.emitUint8(joinNullFlags!.regZero);
  const readRealPatch = emitter.emitUint16(0);

  emitter.emitUint8(OpCode.OP_LOAD_NULL);
  emitter.emitUint8(destReg);
  emitter.emitUint8(OpCode.OP_JUMP);
  const donePatch = emitter.emitUint16(0);

  emitter.patchUint16(readRealPatch, emitter.currentOffset());
  emitReadColumn(emitter, cursor, colIdx, destReg, colType);
  emitter.patchUint16(donePatch, emitter.currentOffset());
}

export function normalizeFilter(
  filter: QueryFilter,
  depth: number = 0,
): QueryFilter {
  if (depth > MAX_FILTER_DEPTH) {
    throw new RangeError(
      `Filter nesting depth exceeds maximum limit of ${MAX_FILTER_DEPTH}`,
    );
  }

  if (filter.type === "in") {
    if (filter.values && filter.values.length > MAX_IN_LIST_SIZE) {
      throw new RangeError(
        `WebDB: whereIn list exceeds maximum limit of ${MAX_IN_LIST_SIZE} elements`,
      );
    }
    const rawValues = filter.values ?? [];
    const dedup = new Set(rawValues);
    if (
      Array.isArray(filter.values) &&
      typeof filter.notIn === "boolean" &&
      dedup.size === rawValues.length
    ) {
      return filter;
    }
    return {
      type: "in",
      colName: filter.colName,
      expr: filter.expr,
      values: Array.from(dedup),
      notIn: !!filter.notIn,
    };
  }

  if (filter.type === "cmp") {
    const opNorm = filter.op ? String(filter.op).trim().toLowerCase() : "";
    if (opNorm === "in" || opNorm === "not in") {
      const arr = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (arr.length > MAX_IN_LIST_SIZE) {
        throw new RangeError(
          `WebDB: whereIn list exceeds maximum limit of ${MAX_IN_LIST_SIZE} elements`,
        );
      }
      return {
        type: "in",
        colName: filter.colName,
        expr: filter.expr,
        values: Array.from(new Set(arr)),
        notIn: opNorm === "not in",
      };
    }
  }

  if (filter.type === "and" || filter.type === "or") {
    const origChildren = filter.children ?? [];
    let changed = !filter.children;
    const newChildren: QueryFilter[] = new Array(origChildren.length);
    for (let i = 0; i < origChildren.length; i++) {
      const c = normalizeFilter(origChildren[i], depth + 1);
      newChildren[i] = c;
      if (c !== origChildren[i]) {
        changed = true;
      }
    }
    if (!changed) {
      return filter;
    }
    return {
      type: filter.type,
      children: newChildren,
    };
  }

  if (filter.type === "not") {
    const child = filter.child;
    if (!child) {
      return filter;
    }

    // Double negation: NOT (NOT x) => x
    if (child.type === "not" && child.child) {
      return normalizeFilter(child.child, depth + 1);
    }

    // NOT (x IN (A)) => x NOT IN (A)
    // NOT (x NOT IN (A)) => x IN (A)
    if (child.type === "in") {
      return normalizeFilter(
        {
          type: "in",
          colName: child.colName,
          expr: child.expr,
          values: child.values,
          notIn: !child.notIn,
        },
        depth + 1,
      );
    }

    // De Morgan: NOT (A AND B) => (NOT A) OR (NOT B)
    if (child.type === "and") {
      return {
        type: "or",
        children: child.children
          ? child.children.map((c) =>
              normalizeFilter({ type: "not", child: c }, depth + 1),
            )
          : [],
      };
    }

    // De Morgan: NOT (A OR B) => (NOT A) AND (NOT B)
    if (child.type === "or") {
      return {
        type: "and",
        children: child.children
          ? child.children.map((c) =>
              normalizeFilter({ type: "not", child: c }, depth + 1),
            )
          : [],
      };
    }

    // NOT (col IS NULL) => col IS NOT NULL
    // NOT (col IS NOT NULL) => col IS NULL
    if (child.type === "null") {
      return {
        type: "null",
        colName: child.colName,
        expr: child.expr,
        isNull: !child.isNull,
      };
    }

    // NOT (cmp)
    if (child.type === "cmp") {
      const opNorm = child.op ? String(child.op).trim().toLowerCase() : "";
      if (opNorm === "in" || opNorm === "not in") {
        return normalizeFilter(
          {
            type: "in",
            colName: child.colName,
            expr: child.expr,
            values: Array.isArray(child.value) ? child.value : [child.value],
            notIn: opNorm === "in", // inverted
          },
          depth + 1,
        );
      }

      const inverseOp = INVERSE_OPS.get(opNorm);
      if (inverseOp) {
        return {
          type: "cmp",
          colName: child.colName,
          expr: child.expr,
          op: inverseOp,
          value: child.value,
        };
      }

      // For CONTAINS, STARTS_WITH, ENDS_WITH:
      // In 3VL: NOT(col CONTAINS val) requires col IS NOT NULL AND NOT(col CONTAINS val)
      return {
        type: "and",
        children: [
          {
            type: "null",
            colName: child.colName,
            expr: child.expr,
            isNull: false,
          },
          { type: "not", child },
        ],
      };
    }
  }

  return filter;
}

export function buildRootFilter(filters: QueryFilter[]): QueryFilter | null {
  if (!filters || filters.length === 0) return null;
  const rawRoot: QueryFilter =
    filters.length === 1 ? filters[0] : { type: "and", children: filters };
  return normalizeFilter(rawRoot);
}

export function collectLeafFilters(filter: QueryFilter): QueryFilter[] {
  const leaves: QueryFilter[] = [];
  const seen = new Set<QueryFilter>();
  function traverse(f: QueryFilter) {
    if (
      f.type === "null" ||
      f.type === "cmp" ||
      f.type === "expr" ||
      f.type === "in"
    ) {
      if (!seen.has(f)) {
        seen.add(f);
        leaves.push(f);
      }
    } else if (f.type === "and" || f.type === "or") {
      if (f.children) {
        for (const child of f.children) {
          traverse(child);
        }
      }
    } else if (f.type === "not") {
      if (f.child) {
        traverse(f.child);
      }
    }
  }
  traverse(filter);
  return leaves;
}

export function getTopLevelConjunctionFilters(
  rootFilter: QueryFilter | null,
): QueryFilter[] {
  if (!rootFilter) return [];
  const conjunctions: QueryFilter[] = [];
  function gather(f: QueryFilter) {
    if (f.type === "and" && f.children) {
      for (const child of f.children) {
        gather(child);
      }
    } else if (f.type === "cmp" || f.type === "in" || f.type === "null") {
      conjunctions.push(f);
    }
  }
  gather(rootFilter);
  return conjunctions;
}

export interface ResolvedColumn {
  tableIdx: number;
  cursor: number;
  colIdx: number;
  col: ColumnMeta;
  table: TableMeta;
}

export function resolveColumnAcrossTables(
  colName: string,
  tables: TableMeta[],
): ResolvedColumn | null {
  if (colName.includes(".")) {
    const parts = colName.split(".");
    const tblName = parts[0];
    const cName = parts[1];
    const tableIdx = tables.findIndex(
      (t) => t.name.toLowerCase() === tblName.toLowerCase(),
    );
    if (tableIdx === -1) return null;
    const colIdx = tables[tableIdx].columns.findIndex(
      (c) => c.name.toLowerCase() === cName.toLowerCase(),
    );
    if (colIdx === -1) return null;
    return {
      tableIdx,
      cursor: tableIdx,
      colIdx,
      col: tables[tableIdx].columns[colIdx],
      table: tables[tableIdx],
    };
  }

  // Unqualified column name: search tables in order
  for (let i = 0; i < tables.length; i++) {
    const colIdx = tables[i].columns.findIndex(
      (c) => c.name.toLowerCase() === colName.toLowerCase(),
    );
    if (colIdx !== -1) {
      return {
        tableIdx: i,
        cursor: i,
        colIdx,
        col: tables[i].columns[colIdx],
        table: tables[i],
      };
    }
  }

  return null;
}

function createRegAllocator(startReg: number): () => number {
  let next = startReg;
  return () => {
    if (next >= 64) throw new TooManyRegistersError(next);
    return next++;
  };
}

function emitCondJump(
  emitter: BytecodeEmitter,
  jumpOnTrue: boolean,
  patches: number[],
  emitJumpOnMatch: () => number,
): void {
  if (jumpOnTrue) {
    patches.push(emitJumpOnMatch());
  } else {
    const passPatch = emitJumpOnMatch();
    emitter.emitUint8(OpCode.OP_JUMP);
    patches.push(emitter.emitUint16(0));
    emitter.patchUint16(passPatch, emitter.currentOffset());
  }
}

function emitFilterLhsToReg(
  filter: QueryFilter,
  regCol: number,
  table: TableMeta,
  all: TableMeta[],
  emitter: BytecodeEmitter,
  scratchBaseReg: number,
  missingColMsg: string,
  udfNameMap?: Map<string, number>,
  joinNullFlags?: JoinNullFlags,
): void {
  if (filter.expr) {
    emitExpression(
      filter.expr,
      table,
      emitter,
      0,
      regCol,
      createRegAllocator(scratchBaseReg),
      udfNameMap,
      undefined,
      all,
      joinNullFlags,
    );
    return;
  }
  if (!filter.colName) {
    throw new Error(missingColMsg);
  }
  const resolved = resolveColumnAcrossTables(filter.colName, all);
  if (resolved) {
    emitReadColumnGuarded(
      emitter,
      resolved.cursor,
      resolved.colIdx,
      regCol,
      resolved.col.type,
      joinNullFlags,
    );
    return;
  }
  try {
    const parsed = parseExpression(filter.colName);
    emitExpression(
      parsed,
      table,
      emitter,
      0,
      regCol,
      createRegAllocator(scratchBaseReg),
      udfNameMap,
      undefined,
      all,
      joinNullFlags,
    );
  } catch {
    throw new Error(`Column "${filter.colName}" not found in tables`);
  }
}

function emitWhereLeaf(
  filter: QueryFilter,
  leafIdx: number,
  jumpOnTrue: boolean,
  patches: number[],
  table: TableMeta,
  emitter: BytecodeEmitter,
  udfNameMap?: Map<string, number>,
  tables?: TableMeta[],
  filterSetMap?: Map<QueryFilter, number>,
  scratchBaseReg: number = 50,
  joinNullFlags?: JoinNullFlags,
): void {
  const all = tables ?? [table];
  const regCol = leafIdx * 2;
  const regConst = leafIdx * 2 + 1;

  if (filter.type === "expr") {
    emitExpression(
      filter.expr!,
      table,
      emitter,
      0,
      regCol,
      createRegAllocator(scratchBaseReg),
      udfNameMap,
      undefined,
      all,
      joinNullFlags,
    );
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(regConst);
    emitter.emitInt32(1);

    emitCondJump(emitter, jumpOnTrue, patches, () => {
      emitter.emitUint8(OpCode.OP_EQ);
      emitter.emitUint8(regCol);
      emitter.emitUint8(regConst);
      return emitter.emitUint16(0);
    });
    return;
  }

  if (filter.type === "null") {
    const jumpIfNull = jumpOnTrue ? Boolean(filter.isNull) : !filter.isNull;
    if (filter.expr) {
      emitExpression(
        filter.expr,
        table,
        emitter,
        0,
        regCol,
        createRegAllocator(scratchBaseReg),
        udfNameMap,
        undefined,
        all,
        joinNullFlags,
      );
      emitter.emitUint8(
        jumpIfNull ? OpCode.OP_REG_IS_NULL : OpCode.OP_REG_IS_NOT_NULL,
      );
      emitter.emitUint8(regCol);
      patches.push(emitter.emitUint16(0));
      return;
    }
    if (!filter.colName) {
      throw new Error(`Filter leaf node missing colName`);
    }
    const resolved = resolveColumnAcrossTables(filter.colName, all);
    if (!resolved) {
      throw new Error(`Column "${filter.colName}" not found in tables`);
    }
    const nullFlagReg = joinNullFlags?.nullFlagRegs.get(resolved.cursor);
    if (nullFlagReg !== undefined) {
      emitter.emitUint8(OpCode.OP_EQ);
      emitter.emitUint8(nullFlagReg);
      emitter.emitUint8(joinNullFlags!.regZero);
      const checkRealPatch = emitter.emitUint16(0);
      if (jumpIfNull) {
        // Synthetic NULL row -> take jump
        emitter.emitUint8(OpCode.OP_JUMP);
        patches.push(emitter.emitUint16(0));
        emitter.patchUint16(checkRealPatch, emitter.currentOffset());
        emitter.emitUint8(OpCode.OP_IS_NULL);
        emitter.emitUint8(resolved.cursor);
        emitter.emitUint8(resolved.colIdx);
        patches.push(emitter.emitUint16(0));
      } else {
        // Synthetic NULL row -> do not jump (skip real check)
        emitter.emitUint8(OpCode.OP_JUMP);
        const skipRealPatch = emitter.emitUint16(0);
        emitter.patchUint16(checkRealPatch, emitter.currentOffset());
        emitter.emitUint8(OpCode.OP_IS_NOT_NULL);
        emitter.emitUint8(resolved.cursor);
        emitter.emitUint8(resolved.colIdx);
        patches.push(emitter.emitUint16(0));
        emitter.patchUint16(skipRealPatch, emitter.currentOffset());
      }
      return;
    }
    emitter.emitUint8(jumpIfNull ? OpCode.OP_IS_NULL : OpCode.OP_IS_NOT_NULL);
    emitter.emitUint8(resolved.cursor);
    emitter.emitUint8(resolved.colIdx);
    patches.push(emitter.emitUint16(0));
    return;
  }

  if (filter.type === "in") {
    if (!filter.values || filter.values.length === 0) {
      if (jumpOnTrue ? filter.notIn : !filter.notIn) {
        emitter.emitUint8(OpCode.OP_JUMP);
        patches.push(emitter.emitUint16(0));
      }
      return;
    }

    emitFilterLhsToReg(
      filter,
      regCol,
      table,
      all,
      emitter,
      scratchBaseReg,
      `Filter IN leaf node missing colName`,
      udfNameMap,
      joinNullFlags,
    );

    const setIdx = filterSetMap?.get(filter) ?? 0;
    if (jumpOnTrue) {
      if (!filter.notIn) {
        emitter.emitUint8(OpCode.OP_IN);
        emitter.emitUint8(regCol);
        emitter.emitUint16(setIdx);
        patches.push(emitter.emitUint16(0));
      } else {
        emitter.emitUint8(OpCode.OP_REG_IS_NULL);
        emitter.emitUint8(regCol);
        const nullSkipPatch = emitter.emitUint16(0);

        emitter.emitUint8(OpCode.OP_IN);
        emitter.emitUint8(regCol);
        emitter.emitUint16(setIdx);
        const inSkipPatch = emitter.emitUint16(0);

        emitter.emitUint8(OpCode.OP_JUMP);
        patches.push(emitter.emitUint16(0));

        const notInTruePos = emitter.currentOffset();
        emitter.patchUint16(nullSkipPatch, notInTruePos);
        emitter.patchUint16(inSkipPatch, notInTruePos);
      }
    } else {
      // In SQL 3VL, NULL IN (...) and NULL NOT IN (...) are both UNKNOWN (excluded).
      emitter.emitUint8(OpCode.OP_REG_IS_NULL);
      emitter.emitUint8(regCol);
      patches.push(emitter.emitUint16(0));

      emitCondJump(emitter, Boolean(filter.notIn), patches, () => {
        emitter.emitUint8(OpCode.OP_IN);
        emitter.emitUint8(regCol);
        emitter.emitUint16(setIdx);
        return emitter.emitUint16(0);
      });
    }
    return;
  }

  emitFilterLhsToReg(
    filter,
    regCol,
    table,
    all,
    emitter,
    scratchBaseReg,
    `Filter leaf node missing colName`,
    udfNameMap,
    joinNullFlags,
  );

  const cmpOpcode = getCmpOpcode(filter.op);
  emitCondJump(emitter, jumpOnTrue, patches, () => {
    emitter.emitUint8(cmpOpcode);
    emitter.emitUint8(regCol);
    emitter.emitUint8(regConst);
    return emitter.emitUint16(0);
  });
}

function resolveHavingLhsReg(
  filter: QueryFilter,
  table: TableMeta,
  emitter: BytecodeEmitter,
  resolveReg: (name?: string, expr?: ExprNode) => number | undefined,
  allocReg: () => number,
  udfNameMap?: Map<string, number>,
): number {
  const resolved = resolveReg(filter.colName, filter.expr);
  if (resolved !== undefined) {
    return resolved;
  }
  const regLhs = allocReg();
  if (filter.expr) {
    emitExpression(
      filter.expr,
      table,
      emitter,
      -1,
      regLhs,
      allocReg,
      udfNameMap,
      resolveReg,
    );
  } else if (filter.colName) {
    const parsed = parseExpression(filter.colName);
    emitExpression(
      parsed,
      table,
      emitter,
      -1,
      regLhs,
      allocReg,
      udfNameMap,
      resolveReg,
    );
  } else {
    emitter.emitUint8(OpCode.OP_LOAD_NULL);
    emitter.emitUint8(regLhs);
  }
  return regLhs;
}

function emitHavingLeaf(
  filter: QueryFilter,
  jumpOnTrue: boolean,
  patches: number[],
  table: TableMeta,
  emitter: BytecodeEmitter,
  resolveReg: (name?: string, expr?: ExprNode) => number | undefined,
  allocReg: () => number,
  udfNameMap?: Map<string, number>,
): void {
  if (filter.type === "cmp") {
    const regLhs = resolveHavingLhsReg(
      filter,
      table,
      emitter,
      resolveReg,
      allocReg,
      udfNameMap,
    );
    const regConst = allocReg();
    emitLoadConstant(emitter, regConst, filter.value);
    const cmpOpcode = getCmpOpcode(filter.op);
    emitCondJump(emitter, jumpOnTrue, patches, () => {
      emitter.emitUint8(cmpOpcode);
      emitter.emitUint8(regLhs);
      emitter.emitUint8(regConst);
      return emitter.emitUint16(0);
    });
    return;
  }

  if (filter.type === "null") {
    const regLhs = resolveHavingLhsReg(
      filter,
      table,
      emitter,
      resolveReg,
      allocReg,
      udfNameMap,
    );
    const jumpIfNull = jumpOnTrue ? Boolean(filter.isNull) : !filter.isNull;
    emitter.emitUint8(
      jumpIfNull ? OpCode.OP_REG_IS_NULL : OpCode.OP_REG_IS_NOT_NULL,
    );
    emitter.emitUint8(regLhs);
    patches.push(emitter.emitUint16(0));
    return;
  }

  if (filter.type === "expr" && filter.expr) {
    const regRes = allocReg();
    emitExpression(
      filter.expr,
      table,
      emitter,
      -1,
      regRes,
      allocReg,
      udfNameMap,
      resolveReg,
    );
    const regOne = allocReg();
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(regOne);
    emitter.emitInt32(1);

    emitCondJump(emitter, jumpOnTrue, patches, () => {
      emitter.emitUint8(OpCode.OP_EQ);
      emitter.emitUint8(regRes);
      emitter.emitUint8(regOne);
      return emitter.emitUint16(0);
    });
  }
}

function compileBooleanTree(
  node: QueryFilter,
  emitter: BytecodeEmitter,
  truePatches: number[],
  falsePatches: number[],
  fallthrough: "true" | "false" | "none",
  emitLeaf: (leaf: QueryFilter, jumpOnTrue: boolean, patches: number[]) => void,
  allowInLeaf: boolean,
): void {
  if (
    node.type === "cmp" ||
    node.type === "null" ||
    node.type === "expr" ||
    (allowInLeaf && node.type === "in")
  ) {
    if (fallthrough === "true") {
      emitLeaf(node, false, falsePatches);
    } else if (fallthrough === "false") {
      emitLeaf(node, true, truePatches);
    } else {
      emitLeaf(node, true, truePatches);
      emitter.emitUint8(OpCode.OP_JUMP);
      falsePatches.push(emitter.emitUint16(0));
    }
    return;
  }

  if (node.type === "not") {
    if (!node.child) return;
    const childFallthrough =
      fallthrough === "true"
        ? "false"
        : fallthrough === "false"
          ? "true"
          : "none";
    compileBooleanTree(
      node.child,
      emitter,
      falsePatches,
      truePatches,
      childFallthrough,
      emitLeaf,
      allowInLeaf,
    );
    return;
  }

  if (node.type === "and" || node.type === "or") {
    const isAnd = node.type === "and";
    const children = node.children ?? [];
    if (children.length === 0) {
      if (isAnd && fallthrough !== "true") {
        emitter.emitUint8(OpCode.OP_JUMP);
        truePatches.push(emitter.emitUint16(0));
      } else if (!isAnd && fallthrough !== "false") {
        emitter.emitUint8(OpCode.OP_JUMP);
        falsePatches.push(emitter.emitUint16(0));
      }
      return;
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      if (!isLast) {
        const subPatches: number[] = [];
        compileBooleanTree(
          child,
          emitter,
          isAnd ? subPatches : truePatches,
          isAnd ? falsePatches : subPatches,
          isAnd ? "true" : "false",
          emitLeaf,
          allowInLeaf,
        );
        const nextChildPos = emitter.currentOffset();
        for (const patch of subPatches) {
          emitter.patchUint16(patch, nextChildPos);
        }
      } else {
        compileBooleanTree(
          child,
          emitter,
          truePatches,
          falsePatches,
          fallthrough,
          emitLeaf,
          allowInLeaf,
        );
      }
    }
  }
}

function emitHavingTree(
  root: QueryFilter | null,
  table: TableMeta,
  emitter: BytecodeEmitter,
  resolveReg: (name?: string, expr?: ExprNode) => number | undefined,
  allocReg: () => number,
  failPatches: number[],
  udfNameMap?: Map<string, number>,
): void {
  if (!root) return;
  const truePatches: number[] = [];
  compileBooleanTree(
    root,
    emitter,
    truePatches,
    failPatches,
    "true",
    (leaf, jumpOnTrue, patches) =>
      emitHavingLeaf(
        leaf,
        jumpOnTrue,
        patches,
        table,
        emitter,
        resolveReg,
        allocReg,
        udfNameMap,
      ),
    false,
  );
  const passPos = emitter.currentOffset();
  for (const patch of truePatches) {
    emitter.patchUint16(patch, passPos);
  }
}

function emitFilterTree(
  root: QueryFilter | null,
  table: TableMeta,
  emitter: BytecodeEmitter,
  leafRegMap: Map<QueryFilter, number>,
  nextRowPatches: number[],
  udfNameMap?: Map<string, number>,
  tables?: TableMeta[],
  filterSetMap?: Map<QueryFilter, number>,
  scratchBaseReg: number = 50,
  joinNullFlags?: JoinNullFlags,
): void {
  if (!root) return;
  const truePatches: number[] = [];
  compileBooleanTree(
    root,
    emitter,
    truePatches,
    nextRowPatches,
    "true",
    (leaf, jumpOnTrue, patches) =>
      emitWhereLeaf(
        leaf,
        leafRegMap.get(leaf) ?? 0,
        jumpOnTrue,
        patches,
        table,
        emitter,
        udfNameMap,
        tables,
        filterSetMap,
        scratchBaseReg,
        joinNullFlags,
      ),
    true,
  );
  const rowStartPos = emitter.currentOffset();
  for (const patch of truePatches) {
    emitter.patchUint16(patch, rowStartPos);
  }
}

export function inferExprType(
  expr: ExprNode,
  table: TableMeta,
  udfDefs?: Map<string, { returnType?: DataType }>,
  tables?: TableMeta[],
): DataType {
  if (expr.type === "literal") {
    if (typeof expr.value === "number") {
      return isInt32(expr.value) ? DataType.INT32 : DataType.FLOAT64;
    }
    if (typeof expr.value === "string") return DataType.TEXT;
    return DataType.TEXT;
  }
  if (expr.type === "col") {
    const all = tables ?? [table];
    const resolved = resolveColumnAcrossTables(expr.name, all);
    return resolved ? resolved.col.type : DataType.TEXT;
  }
  if (expr.type === "binary") {
    return DataType.FLOAT64;
  }
  if (expr.type === "fn") {
    const fn = expr.name.toLowerCase();
    if (udfDefs && udfDefs.has(fn)) {
      const def = udfDefs.get(fn)!;
      if (def.returnType !== undefined) {
        return def.returnType;
      }
    }
    if (["upper", "lower", "substr", "trim", "concat"].includes(fn))
      return DataType.TEXT;
    if (
      [
        "length",
        "count",
        "starts_with",
        "startswith",
        "ends_with",
        "endswith",
        "like",
        "contains",
        "levenshtein",
        "edit_distance",
        "fuzzy",
      ].includes(fn)
    )
      return DataType.INT32;
    if (
      ["abs", "round", "floor", "ceil", "sum", "avg", "min", "max"].includes(fn)
    ) {
      if (expr.args.length > 0 && expr.args[0].type === "col") {
        const resolved = resolveColumnAcrossTables(
          (expr.args[0] as any).name,
          tables ?? [table],
        );
        if (resolved && resolved.col.type === DataType.INT32 && fn !== "avg")
          return DataType.INT32;
      }
      return DataType.FLOAT64;
    }
    return DataType.TEXT;
  }
  return DataType.TEXT;
}

export function emitExpression(
  expr: ExprNode,
  table: TableMeta,
  emitter: BytecodeEmitter,
  cursor: number,
  targetReg: number,
  allocReg: () => number,
  udfNameMap?: Map<string, number>,
  resolveReg?: (name?: string, expr?: ExprNode) => number | undefined,
  tables?: TableMeta[],
  joinNullFlags?: JoinNullFlags,
): void {
  if (resolveReg) {
    const colName = expr.type === "col" ? expr.name : undefined;
    const resolved = resolveReg(colName, expr);
    if (resolved !== undefined) {
      if (resolved !== targetReg) {
        emitter.emitUint8(OpCode.OP_COPY);
        emitter.emitUint8(resolved);
        emitter.emitUint8(targetReg);
      }
      return;
    }
  }

  if (expr.type === "literal") {
    const val = expr.value;
    if (val === null || val === undefined) {
      emitter.emitUint8(OpCode.OP_LOAD_NULL);
      emitter.emitUint8(targetReg);
    } else if (typeof val === "number") {
      if (isInt32(val)) {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(targetReg);
        emitter.emitInt32(val);
      } else {
        emitter.emitUint8(OpCode.OP_LOAD_FLOAT);
        emitter.emitUint8(targetReg);
        emitter.emitFloat64(val);
      }
    } else if (typeof val === "bigint") {
      emitter.emitUint8(OpCode.OP_LOAD_INT64);
      emitter.emitUint8(targetReg);
      emitter.emitInt64(val);
    } else if (typeof val === "string") {
      emitter.emitUint8(OpCode.OP_LOAD_TEXT);
      emitter.emitUint8(targetReg);
      emitter.emitString(val);
    } else if (typeof val === "boolean") {
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(targetReg);
      emitter.emitInt32(val ? 1 : 0);
    }
    return;
  }

  if (expr.type === "col") {
    if (cursor === -1) {
      throw new Error(
        `Column "${expr.name}" in HAVING clause must be an aggregate or grouping column`,
      );
    }
    const all = tables ?? [table];
    const resolved = resolveColumnAcrossTables(expr.name, all);
    if (!resolved) {
      if (expr.name === "*") {
        emitter.emitUint8(OpCode.OP_LOAD_NULL);
        emitter.emitUint8(targetReg);
        return;
      }
      throw new Error(
        `Column "${expr.name}" does not exist in table "${table.name}"`,
      );
    }
    emitReadColumnGuarded(
      emitter,
      resolved.cursor,
      resolved.colIdx,
      targetReg,
      resolved.col.type,
      joinNullFlags,
    );
    return;
  }

  if (expr.type === "binary") {
    const regLeft = allocReg();
    const regRight = allocReg();
    emitExpression(
      expr.left,
      table,
      emitter,
      cursor,
      regLeft,
      allocReg,
      udfNameMap,
      resolveReg,
      tables,
      joinNullFlags,
    );
    emitExpression(
      expr.right,
      table,
      emitter,
      cursor,
      regRight,
      allocReg,
      udfNameMap,
      resolveReg,
      tables,
      joinNullFlags,
    );

    let opCode = OpCode.OP_ADD;
    if (expr.op === "+") opCode = OpCode.OP_ADD;
    else if (expr.op === "-") opCode = OpCode.OP_SUB;
    else if (expr.op === "*") opCode = OpCode.OP_MUL;
    else if (expr.op === "/") opCode = OpCode.OP_DIV;
    else if (expr.op === "%") opCode = OpCode.OP_MOD;
    else if (
      expr.op === "=" ||
      expr.op === "!=" ||
      expr.op === "<" ||
      expr.op === "<=" ||
      expr.op === ">" ||
      expr.op === ">="
    ) {
      let cmpOp = OpCode.OP_EQ;
      if (expr.op === "=") cmpOp = OpCode.OP_EQ;
      else if (expr.op === "!=") cmpOp = OpCode.OP_NE;
      else if (expr.op === "<") cmpOp = OpCode.OP_LT;
      else if (expr.op === "<=") cmpOp = OpCode.OP_LE;
      else if (expr.op === ">") cmpOp = OpCode.OP_GT;
      else if (expr.op === ">=") cmpOp = OpCode.OP_GE;

      emitter.emitUint8(cmpOp);
      emitter.emitUint8(regLeft);
      emitter.emitUint8(regRight);
      const truePatch = emitter.emitUint16(0);

      // False branch: targetReg = 0
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(targetReg);
      emitter.emitInt32(0);
      emitter.emitUint8(OpCode.OP_JUMP);
      const donePatch = emitter.emitUint16(0);

      // True branch: targetReg = 1
      emitter.patchUint16(truePatch, emitter.currentOffset());
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(targetReg);
      emitter.emitInt32(1);

      emitter.patchUint16(donePatch, emitter.currentOffset());
      return;
    }

    emitter.emitUint8(opCode);
    emitter.emitUint8(regLeft);
    emitter.emitUint8(regRight);
    emitter.emitUint8(targetReg);
    return;
  }

  if (expr.type === "fn") {
    const fnName = expr.name.toLowerCase();

    const unaryOp = UNARY_OPS.get(fnName);
    if (unaryOp !== undefined) {
      const srcReg = allocReg();
      const arg = expr.args[0] ?? { type: "literal", value: null };
      emitExpression(
        arg,
        table,
        emitter,
        cursor,
        srcReg,
        allocReg,
        udfNameMap,
        resolveReg,
        tables,
        joinNullFlags,
      );
      emitter.emitUint8(unaryOp);
      emitter.emitUint8(srcReg);
      emitter.emitUint8(targetReg);
      return;
    }

    if (fnName === "substr") {
      const srcReg = allocReg();
      const startReg = allocReg();
      const lenReg = allocReg();
      emitExpression(
        expr.args[0],
        table,
        emitter,
        cursor,
        srcReg,
        allocReg,
        udfNameMap,
        resolveReg,
        tables,
        joinNullFlags,
      );
      emitExpression(
        expr.args[1] ?? { type: "literal", value: 1 },
        table,
        emitter,
        cursor,
        startReg,
        allocReg,
        udfNameMap,
        resolveReg,
        tables,
        joinNullFlags,
      );
      if (expr.args[2] !== undefined) {
        emitExpression(
          expr.args[2],
          table,
          emitter,
          cursor,
          lenReg,
          allocReg,
          udfNameMap,
          resolveReg,
          tables,
          joinNullFlags,
        );
      } else {
        emitter.emitUint8(OpCode.OP_LOAD_NULL);
        emitter.emitUint8(lenReg);
      }
      emitter.emitUint8(OpCode.OP_STR_SUBSTR);
      emitter.emitUint8(srcReg);
      emitter.emitUint8(startReg);
      emitter.emitUint8(lenReg);
      emitter.emitUint8(targetReg);
      return;
    }

    if (fnName === "levenshtein" || fnName === "edit_distance") {
      const regStr1 = allocReg();
      const regStr2 = allocReg();
      emitExpression(
        expr.args[0] ?? { type: "literal", value: null },
        table,
        emitter,
        cursor,
        regStr1,
        allocReg,
        udfNameMap,
        resolveReg,
        tables,
        joinNullFlags,
      );
      emitExpression(
        expr.args[1] ?? { type: "literal", value: null },
        table,
        emitter,
        cursor,
        regStr2,
        allocReg,
        udfNameMap,
        resolveReg,
        tables,
        joinNullFlags,
      );
      emitter.emitUint8(OpCode.OP_STR_LEVENSHTEIN);
      emitter.emitUint8(regStr1);
      emitter.emitUint8(regStr2);
      emitter.emitUint8(targetReg);
      return;
    }

    const patternOp = PATTERN_OPS.get(fnName);
    if (patternOp !== undefined) {
      const regStr = allocReg();
      const regPat = allocReg();
      emitExpression(
        expr.args[0] ?? { type: "literal", value: null },
        table,
        emitter,
        cursor,
        regStr,
        allocReg,
        udfNameMap,
        resolveReg,
        tables,
        joinNullFlags,
      );
      emitExpression(
        expr.args[1] ?? { type: "literal", value: "" },
        table,
        emitter,
        cursor,
        regPat,
        allocReg,
        udfNameMap,
        resolveReg,
        tables,
        joinNullFlags,
      );

      emitter.emitUint8(patternOp);
      emitter.emitUint8(regStr);
      emitter.emitUint8(regPat);
      const truePatch = emitter.emitUint16(0);

      // False branch: targetReg = 0
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(targetReg);
      emitter.emitInt32(0);
      emitter.emitUint8(OpCode.OP_JUMP);
      const donePatch = emitter.emitUint16(0);

      // True branch: targetReg = 1
      emitter.patchUint16(truePatch, emitter.currentOffset());
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(targetReg);
      emitter.emitInt32(1);

      emitter.patchUint16(donePatch, emitter.currentOffset());
      return;
    }

    if (fnName === "concat" || fnName === "coalesce") {
      const numArgs = expr.args.length;
      const startReg = allocReg();
      for (let i = 1; i < numArgs; i++) {
        allocReg();
      }
      for (let i = 0; i < numArgs; i++) {
        emitExpression(
          expr.args[i],
          table,
          emitter,
          cursor,
          startReg + i,
          allocReg,
          udfNameMap,
          resolveReg,
          tables,
          joinNullFlags,
        );
      }
      const op =
        fnName === "concat" ? OpCode.OP_STR_CONCAT : OpCode.OP_COALESCE;
      emitter.emitUint8(op);
      emitter.emitUint8(startReg);
      emitter.emitUint8(numArgs);
      emitter.emitUint8(targetReg);
      return;
    }

    if (udfNameMap && udfNameMap.has(fnName)) {
      const udfId = udfNameMap.get(fnName)!;
      const numArgs = expr.args.length;
      let startReg = targetReg;
      if (numArgs > 0) {
        startReg = allocReg();
        for (let i = 1; i < numArgs; i++) {
          allocReg();
        }
        for (let i = 0; i < numArgs; i++) {
          emitExpression(
            expr.args[i],
            table,
            emitter,
            cursor,
            startReg + i,
            allocReg,
            udfNameMap,
            resolveReg,
            tables,
            joinNullFlags,
          );
        }
      }
      emitter.emitUint8(OpCode.OP_CALL_UDF);
      emitter.emitUint16(udfId);
      emitter.emitUint8(startReg);
      emitter.emitUint8(numArgs);
      emitter.emitUint8(targetReg);
      return;
    }

    throw new UnknownFunctionError(fnName);
  }
}

function emitLoadConstant(
  emitter: BytecodeEmitter,
  reg: number,
  val: any,
  colType?: DataType,
): void {
  if (val === null || val === undefined) {
    emitter.emitUint8(OpCode.OP_LOAD_NULL);
    emitter.emitUint8(reg);
  } else if (typeof val === "number") {
    if (colType === DataType.FLOAT64 || !isInt32(val)) {
      emitter.emitUint8(OpCode.OP_LOAD_FLOAT);
      emitter.emitUint8(reg);
      emitter.emitFloat64(val);
    } else {
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(reg);
      emitter.emitInt32(Math.floor(val));
    }
  } else if (typeof val === "bigint") {
    emitter.emitUint8(OpCode.OP_LOAD_INT64);
    emitter.emitUint8(reg);
    emitter.emitInt64(val);
  } else if (typeof val === "string") {
    emitter.emitUint8(OpCode.OP_LOAD_TEXT);
    emitter.emitUint8(reg);
    emitter.emitString(val);
  } else if (typeof val === "boolean") {
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(reg);
    emitter.emitInt32(val ? 1 : 0);
  } else if (val instanceof Uint8Array) {
    emitter.emitUint8(OpCode.OP_LOAD_BLOB);
    emitter.emitUint8(reg);
    emitter.emitBytes(val);
  }
}

export interface CandidateIndexScan {
  index: IndexDescriptor;
  scanType: "point" | "range" | "multi_point";
  seekFilter?: QueryFilter;
  filterIndex: number; // index into leafFilters, -1 if synthetic for orderBy
  keyType: DataType;
  compositeValue?: Uint8Array;
  inValues?: any[];
  satisfiesOrderBy?: boolean;
}

/**
 * Returns minimum scalar key value for DataType when seeking the start of an index.
 */
export function getMinKeyValueForType(type: DataType): any {
  switch (type) {
    case DataType.INT32:
      return -2147483648;
    case DataType.INT64:
      return -9223372036854775808n;
    case DataType.FLOAT64:
      return -Infinity;
    case DataType.TEXT:
    case DataType.UUID:
    case DataType.ULID:
      return "";
    case DataType.BLOB:
      return new Uint8Array(0);
    default:
      return 0;
  }
}

/**
 * Tests whether a secondary index satisfies the query's ORDER BY keys directly.
 * Forward B-Tree scans naturally stream in ASC order.
 */
export function isIndexAlignedWithOrderBy(
  index: IndexDescriptor,
  table: TableMeta,
  orderBy?: SortKey[],
  equalityColumns?: Set<string>,
): boolean {
  if (!orderBy || orderBy.length === 0) return false;
  // All orderBy keys must be ascending (or default asc)
  for (const k of orderBy) {
    if (k.direction === "desc") return false;
  }

  const colCount = Math.min(index.columnCount, index.columnIndices.length);
  if (colCount <= 0) return false;
  const indexColNames: string[] = [];
  for (let i = 0; i < colCount; i++) {
    const colMeta = table.columns[index.columnIndices[i]];
    if (!colMeta) return false;
    indexColNames.push(colMeta.name.toLowerCase());
  }

  // Skip leading index columns that are fixed by equality filters
  let idxPos = 0;
  if (equalityColumns && equalityColumns.size > 0) {
    while (
      idxPos < indexColNames.length &&
      equalityColumns.has(indexColNames[idxPos])
    ) {
      idxPos++;
    }
  }

  // Check if subsequent index columns match the orderBy columns in order
  let orderPos = 0;
  while (idxPos < indexColNames.length && orderPos < orderBy.length) {
    const orderCol = orderBy[orderPos].colName?.toLowerCase();
    if (!orderCol || orderCol !== indexColNames[idxPos]) {
      return false;
    }
    idxPos++;
    orderPos++;
  }

  return orderPos === orderBy.length;
}

/**
 * Tests whether a join plan preserves the requested ORDER BY.
 * In a nested loop join, if all ORDER BY keys belong to the driving table (Table 0)
 * and are sorted in ASC order, the outer loop determines the output order.
 */
export function canJoinPreserveOrder(
  drivingTable: TableMeta,
  joinedTables: JoinPlan[],
  orderBy?: SortKey[],
  allTables?: TableMeta[],
  selectExprs?: ParsedSelectExpr[],
): boolean {
  if (!orderBy || orderBy.length === 0) return false;
  for (const k of orderBy) {
    if (k.direction === "desc") return false;
    const colName = k.colName;
    if (!colName) return false;

    if (allTables && allTables.length > 0) {
      let resolved = resolveColumnAcrossTables(colName, allTables);
      if (!resolved && selectExprs) {
        const se = selectExprs.find((s) => s.alias === colName);
        if (se && se.expr.type === "col") {
          resolved = resolveColumnAcrossTables(se.expr.name, allTables);
        }
      }
      if (!resolved || resolved.tableIdx !== 0) {
        return false;
      }
    } else {
      const shortCol = colName.includes(".")
        ? colName.slice(colName.lastIndexOf(".") + 1)
        : colName;
      const isDrivingCol = drivingTable.columns.some(
        (c) => c.name.toLowerCase() === shortCol.toLowerCase(),
      );
      if (!isDrivingCol) return false;
    }
  }

  return true;
}

export function chooseIndexScan(
  table: TableMeta,
  candidateFilters: QueryFilter[],
  leafFilters?: QueryFilter[],
  orderBy?: SortKey[],
): CandidateIndexScan | null {
  if (!table.indexes || table.indexes.length === 0) return null;
  const allLeaves = leafFilters ?? candidateFilters;

  const tblPrefix = `${table.name.toLowerCase()}.`;
  const matchesCol = (filterCol: string | undefined, colName: string): boolean => {
    if (!filterCol) return false;
    if (filterCol === colName) return true;
    const fLower = filterCol.toLowerCase();
    const cLower = colName.toLowerCase();
    return fLower === cLower || fLower === tblPrefix + cLower;
  };

  const equalityCols = new Set<string>();
  for (const f of candidateFilters) {
    if (
      f.type === "cmp" &&
      (f.op === "=" || f.op === undefined) &&
      f.colName &&
      f.value !== undefined &&
      f.value !== null
    ) {
      const lower = f.colName.toLowerCase();
      equalityCols.add(lower.startsWith(tblPrefix) ? lower.slice(tblPrefix.length) : lower);
    }
  }

  const tagCandidate = (cand: CandidateIndexScan): CandidateIndexScan => {
    if (orderBy && orderBy.length > 0) {
      if (
        cand.scanType === "point" &&
        (cand.index.flags & (IndexFlag.PRIMARY | IndexFlag.UNIQUE)) !== 0
      ) {
        cand.satisfiesOrderBy = true;
      } else if (
        isIndexAlignedWithOrderBy(cand.index, table, orderBy, equalityCols)
      ) {
        if (cand.scanType === "multi_point" && cand.inValues) {
          const dir = orderBy[0].direction === "desc" ? -1 : 1;
          cand.inValues.sort((a, b) => {
            if (typeof a === "number" && typeof b === "number") {
              return (a - b) * dir;
            }
            if (typeof a === "bigint" && typeof b === "bigint") {
              return (a < b ? -1 : a > b ? 1 : 0) * dir;
            }
            if (a instanceof Uint8Array && b instanceof Uint8Array) {
              const minLen = Math.min(a.byteLength, b.byteLength);
              for (let k = 0; k < minLen; k++) {
                if (a[k] !== b[k]) return (a[k] - b[k]) * dir;
              }
              return (a.byteLength - b.byteLength) * dir;
            }
            return String(a).localeCompare(String(b)) * dir;
          });
        }
        cand.satisfiesOrderBy = true;
      }
    }
    return cand;
  };

  const buildMultiPointValues = (values: any[]): any[] | null => {
    const MAX_MULTI_POINT_UNROLL = 64;
    const MAX_MULTI_POINT_BYTES = 2048;
    const seenScalars = new Set<any>();
    const seenBlobs = new Set<string>();
    const uniqueValues: any[] = [];
    for (const v of values) {
      if (v === null || v === undefined) continue;
      if (v instanceof Uint8Array) {
        let hex = "";
        for (let k = 0; k < v.byteLength; k++) {
          hex += v[k].toString(16).padStart(2, "0");
        }
        if (seenBlobs.has(hex)) continue;
        seenBlobs.add(hex);
        uniqueValues.push(v);
      } else {
        if (seenScalars.has(v)) continue;
        seenScalars.add(v);
        uniqueValues.push(v);
      }
      if (uniqueValues.length > MAX_MULTI_POINT_UNROLL) return null;
    }
    if (uniqueValues.length === 0) return null;
    let approxKeyBytes = 0;
    for (const v of uniqueValues) {
      approxKeyBytes +=
        typeof v === "string"
          ? v.length * 3 + 16
          : v instanceof Uint8Array
            ? v.byteLength + 16
            : 16;
      if (approxKeyBytes > MAX_MULTI_POINT_BYTES) return null;
    }
    return uniqueValues;
  };

  // 1. Single-column equality match or IN match on PRIMARY KEY (highest priority)
  for (const idx of table.indexes) {
    if ((idx.flags & IndexFlag.PRIMARY) !== 0 && idx.columnCount === 1) {
      const colMeta = table.columns[idx.columnIndices[0]];
      if (!colMeta) continue;
      for (let i = 0; i < candidateFilters.length; i++) {
        const f = candidateFilters[i];
        if (
          f.type === "cmp" &&
          (f.op === "=" || f.op === undefined) &&
          matchesCol(f.colName, colMeta.name) &&
          f.value !== undefined &&
          f.value !== null
        ) {
          return tagCandidate({
            index: idx,
            scanType: "point",
            seekFilter: f,
            filterIndex: allLeaves.indexOf(f),
            keyType: colMeta.type,
          });
        }
        if (
          f.type === "in" &&
          !f.notIn &&
          matchesCol(f.colName, colMeta.name) &&
          Array.isArray(f.values) &&
          f.values.length > 0
        ) {
          // Cap multi_point unrolling so generated bytecode stays well within BYTECODE_SIZE (8 KB).
          // Larger IN lists fall back to a compact OP_IN hash-set scan.
          const uniqueValues = buildMultiPointValues(f.values);
          if (uniqueValues) {
            return tagCandidate({
              index: idx,
              scanType: "multi_point",
              seekFilter: f,
              filterIndex: allLeaves.indexOf(f),
              keyType: colMeta.type,
              inValues: uniqueValues,
            });
          }
        }
      }
    }
  }

  // 2. Single-column equality match or IN match on UNIQUE secondary index
  for (const idx of table.indexes) {
    if ((idx.flags & IndexFlag.UNIQUE) !== 0 && idx.columnCount === 1) {
      const colMeta = table.columns[idx.columnIndices[0]];
      if (!colMeta) continue;
      for (let i = 0; i < candidateFilters.length; i++) {
        const f = candidateFilters[i];
        if (
          f.type === "cmp" &&
          (f.op === "=" || f.op === undefined) &&
          matchesCol(f.colName, colMeta.name) &&
          f.value !== undefined &&
          f.value !== null
        ) {
          return tagCandidate({
            index: idx,
            scanType: "point",
            seekFilter: f,
            filterIndex: allLeaves.indexOf(f),
            keyType: colMeta.type,
          });
        }
        if (
          f.type === "in" &&
          !f.notIn &&
          matchesCol(f.colName, colMeta.name) &&
          Array.isArray(f.values) &&
          f.values.length > 0
        ) {
          // Cap multi_point unrolling so generated bytecode stays well within BYTECODE_SIZE (8 KB).
          // Larger IN lists fall back to a compact OP_IN hash-set scan.
          const uniqueValues = buildMultiPointValues(f.values);
          if (uniqueValues) {
            return tagCandidate({
              index: idx,
              scanType: "multi_point",
              seekFilter: f,
              filterIndex: allLeaves.indexOf(f),
              keyType: colMeta.type,
              inValues: uniqueValues,
            });
          }
        }
      }
    }
  }

  // 3. Composite index exact equality match (all indexed columns matched with =)
  for (const idx of table.indexes) {
    if (idx.columnCount > 1) {
      const matchedFilters: { colName: string; filter: QueryFilter }[] = [];
      let allFound = true;

      for (let c = 0; c < idx.columnCount; c++) {
        const colMeta = table.columns[idx.columnIndices[c]];
        if (!colMeta) {
          allFound = false;
          break;
        }
        const f = candidateFilters.find(
          (lf) =>
            lf.type === "cmp" &&
            (lf.op === "=" || lf.op === undefined) &&
            matchesCol(lf.colName, colMeta.name) &&
            lf.value !== undefined &&
            lf.value !== null,
        );
        if (f) {
          matchedFilters.push({ colName: colMeta.name, filter: f });
        } else {
          allFound = false;
          break;
        }
      }

      if (allFound) {
        const dummyRow: Record<string, any> = {};
        for (const m of matchedFilters) {
          dummyRow[m.colName] = m.filter.value;
        }
        const compositeKeyBytes = serialize_composite_key(
          table.columns,
          idx.columnIndices,
          idx.columnCount,
          dummyRow,
        );

        return tagCandidate({
          index: idx,
          scanType:
            (idx.flags & (IndexFlag.UNIQUE | IndexFlag.PRIMARY)) !== 0
              ? "point"
              : "range",
          seekFilter: matchedFilters[0].filter,
          filterIndex: allLeaves.indexOf(matchedFilters[0].filter),
          keyType: DataType.BLOB,
          compositeValue: compositeKeyBytes,
        });
      }
    }
  }

  // 4. Single-column equality match on non-unique index
  for (const idx of table.indexes) {
    if (idx.columnCount === 1) {
      const colMeta = table.columns[idx.columnIndices[0]];
      if (!colMeta) continue;
      for (let i = 0; i < candidateFilters.length; i++) {
        const f = candidateFilters[i];
        if (
          f.type === "cmp" &&
          (f.op === "=" || f.op === undefined) &&
          matchesCol(f.colName, colMeta.name) &&
          f.value !== undefined &&
          f.value !== null
        ) {
          return tagCandidate({
            index: idx,
            scanType: "range",
            seekFilter: f,
            filterIndex: allLeaves.indexOf(f),
            keyType: colMeta.type,
          });
        }
      }
    }
  }

  // 5. Single-column range match (>= or >)
  for (const idx of table.indexes) {
    if (idx.columnCount === 1) {
      const colMeta = table.columns[idx.columnIndices[0]];
      if (!colMeta) continue;
      for (let i = 0; i < candidateFilters.length; i++) {
        const f = candidateFilters[i];
        if (
          f.type === "cmp" &&
          (f.op === ">=" || f.op === ">") &&
          matchesCol(f.colName, colMeta.name) &&
          f.value !== undefined &&
          f.value !== null
        ) {
          return tagCandidate({
            index: idx,
            scanType: "range",
            seekFilter: f,
            filterIndex: allLeaves.indexOf(f),
            keyType: colMeta.type,
          });
        }
      }
    }
  }

  // 6. Interesting Order scan: match index to satisfy ORDER BY directly
  if (orderBy && orderBy.length > 0) {
    for (const idx of table.indexes) {
      if (isIndexAlignedWithOrderBy(idx, table, orderBy, equalityCols)) {
        if (idx.columnCount === 1) {
          const colMeta = table.columns[idx.columnIndices[0]];
          if (!colMeta) continue;
          return {
            index: idx,
            scanType: "range",
            seekFilter: undefined as any,
            filterIndex: -1,
            keyType: colMeta.type,
            satisfiesOrderBy: true,
          };
        } else {
          // Composite index: prefix with equality filter values if present, rest with min values
          const dummyRow: Record<string, any> = {};
          let validCols = true;
          for (let c = 0; c < idx.columnCount; c++) {
            const col = table.columns[idx.columnIndices[c]];
            if (!col) {
              validCols = false;
              break;
            }
            const eqFilter = candidateFilters.find(
              (f) =>
                f.type === "cmp" &&
                (f.op === "=" || f.op === undefined) &&
                matchesCol(f.colName, col.name) &&
                f.value !== undefined &&
                f.value !== null,
            );
            if (eqFilter) {
              dummyRow[col.name] = eqFilter.value;
            } else {
              dummyRow[col.name] = getMinKeyValueForType(col.type);
            }
          }
          if (!validCols) continue;
          const compositeKeyBytes = serialize_composite_key(
            table.columns,
            idx.columnIndices,
            idx.columnCount,
            dummyRow,
          );
          return {
            index: idx,
            scanType: "range",
            seekFilter: undefined as any,
            filterIndex: -1,
            keyType: DataType.BLOB,
            compositeValue: compositeKeyBytes,
            satisfiesOrderBy: true,
          };
        }
      }
    }
  }

  return null;
}

export interface JoinIndexCandidate {
  index: IndexDescriptor;
  isUnique: boolean;
  innerCol: ResolvedColumn;
  outerCol: ResolvedColumn;
  indexCursor: number;
}

export function chooseJoinIndex(
  joinPlan: JoinPlan,
  innerTable: TableMeta,
  innerTableIdx: number,
  allTables: TableMeta[],
  indexCursor: number,
): JoinIndexCandidate | null {
  if (
    joinPlan.op !== "=" ||
    !innerTable.indexes ||
    innerTable.indexes.length === 0
  ) {
    return null;
  }

  const resolvedLeft = resolveColumnAcrossTables(joinPlan.leftCol, allTables);
  const resolvedRight = resolveColumnAcrossTables(joinPlan.rightCol, allTables);
  if (!resolvedLeft || !resolvedRight) return null;

  let innerCol: ResolvedColumn | null = null;
  let outerCol: ResolvedColumn | null = null;

  if (
    resolvedLeft.tableIdx === innerTableIdx &&
    resolvedRight.tableIdx < innerTableIdx
  ) {
    innerCol = resolvedLeft;
    outerCol = resolvedRight;
  } else if (
    resolvedRight.tableIdx === innerTableIdx &&
    resolvedLeft.tableIdx < innerTableIdx
  ) {
    innerCol = resolvedRight;
    outerCol = resolvedLeft;
  }

  if (!innerCol || !outerCol) return null;

  let bestIdx: IndexDescriptor | null = null;
  let bestRank = 999;

  for (const idx of innerTable.indexes) {
    if (idx.columnCount === 1 && idx.columnIndices[0] === innerCol.colIdx) {
      const isPk = (idx.flags & IndexFlag.PRIMARY) !== 0;
      const isUnique = (idx.flags & IndexFlag.UNIQUE) !== 0;
      const rank = isPk ? 1 : isUnique ? 2 : 3;
      if (rank < bestRank) {
        bestRank = rank;
        bestIdx = idx;
      }
    }
  }

  if (!bestIdx) return null;

  const isUnique =
    (bestIdx.flags & (IndexFlag.PRIMARY | IndexFlag.UNIQUE)) !== 0;
  return {
    index: bestIdx,
    isUnique,
    innerCol,
    outerCol,
    indexCursor,
  };
}

/**
 * Compiles a QueryPlan into an executable bytecode array.
 */
export function compileQuery(
  plan: QueryPlan,
  options?: {
    planner?: QueryPlanner;
  },
): Uint8Array {
  const originalTables: TableMeta[] = [
    plan.table,
    ...(plan.joinedTables?.map((j) => j.table) ?? []),
  ];

  // Optimize plan through unified QueryPlanner
  const queryPlanner = resolveQueryPlanner(options?.planner ?? plan.planner);

  const opt = queryPlanner.optimize(plan);
  const allTables: TableMeta[] = opt.orderedTables ?? originalTables;
  const whereMetrics = opt.whereMetrics;
  const planMetrics = opt.metrics;

  if (opt.isAlwaysFalse) {
    const emptyEmitter = new BytecodeEmitter();
    emptyEmitter.emitUint8(OpCode.OP_HALT);
    const res = emptyEmitter.toByteArray();
    if (plan.outputColumns) (res as any).outputColumns = plan.outputColumns;
    (res as any).allTables = allTables;
    (res as any).whereMetrics = whereMetrics;
    return res;
  }

  const workingPlan = opt.plan;
  if (workingPlan !== plan) {
    Object.assign(plan, workingPlan);
  }

  const isJoinQuery =
    plan.joinedTables !== undefined && plan.joinedTables.length > 0;

  const rootFilter =
    opt.rootFilter !== undefined ? opt.rootFilter : buildRootFilter(plan.filters);
  const leafFilters = rootFilter ? collectLeafFilters(rootFilter) : [];
  const topConjunctions = getTopLevelConjunctionFilters(rootFilter);

  // Partition filters for early pushdown per join loop level
  const pushedFilters: QueryFilter[][] = Array.from(
    { length: allTables.length },
    () => [],
  );
  const pushedFilterSet = new Set<QueryFilter>();

  if (isJoinQuery && planMetrics) {
    for (let i = 0; i < allTables.length; i++) {
      const origIdx = originalTables.indexOf(allTables[i]);
      if (origIdx !== -1) {
        const filters = planMetrics.singleTableFilters.get(origIdx) ?? [];
        if (
          i === 0 ||
          (plan.joinedTables && plan.joinedTables[i - 1]?.type === "inner")
        ) {
          pushedFilters[i] = filters;
          for (const f of filters) {
            pushedFilterSet.add(f);
          }
        }
      }
    }
  }

  const remainingFilters: QueryFilter[] = [];
  for (const f of topConjunctions) {
    if (!pushedFilterSet.has(f)) {
      remainingFilters.push(f);
    }
  }
  const rootRemainingFilter = buildRootFilter(remainingFilters);

  // Join Order Preservation check for Table 0 (outer driving table)
  const canPreserve =
    isJoinQuery &&
    canJoinPreserveOrder(
      allTables[0],
      plan.joinedTables!,
      plan.orderBy,
      allTables,
      plan.selectExprs,
    );

  const orderKeysForTable0 = canPreserve
    ? plan.orderBy!.map((k) => {
        const col = k.colName ?? "";
        const shortCol = col.includes(".")
          ? col.slice(col.lastIndexOf(".") + 1)
          : col;
        return { ...k, colName: shortCol };
      })
    : undefined;

  let table0Scan = isJoinQuery
    ? chooseIndexScan(
        allTables[0],
        pushedFilters[0],
        leafFilters,
        orderKeysForTable0,
      )
    : null;
  // Driving-table join loop only supports single point or range seeks; multi_point
  // requires an outer value loop that is handled in single-table mode only.
  if (table0Scan?.scanType === "multi_point") {
    table0Scan = null;
  }

  const isJoinOrderPreserved = canPreserve && !!table0Scan?.satisfiesOrderBy;

  let nextCursor = allTables.length;
  let indexCursor0 = -1;
  if (table0Scan && nextCursor < 16) {
    indexCursor0 = nextCursor++;
  }

  const joinIndices: (JoinIndexCandidate | null)[] = new Array(
    allTables.length,
  ).fill(null);
  if (isJoinQuery && plan.joinedTables) {
    for (let i = 1; i < allTables.length; i++) {
      const jPlan = plan.joinedTables[i - 1];
      if (nextCursor < 16) {
        const cand = chooseJoinIndex(
          jPlan,
          allTables[i],
          i,
          allTables,
          nextCursor,
        );
        if (cand) {
          joinIndices[i] = cand;
          nextCursor++;
        }
      }
    }
  }

  const totalCursors = nextCursor;
  if (totalCursors > 16) {
    throw new TooManyCursorsError(totalCursors, 16);
  }

  // Short-circuit: top-level conjunction IN () can never match any row
  for (const f of topConjunctions) {
    if (f.type === "in" && !f.notIn && (!f.values || f.values.length === 0)) {
      const emptyEmitter = new BytecodeEmitter();
      emptyEmitter.emitUint8(OpCode.OP_HALT);
      const res = emptyEmitter.toByteArray();
      if (plan.outputColumns) (res as any).outputColumns = plan.outputColumns;
      return res;
    }
  }

  const inSets: Set<any>[] = [];
  const filterSetMap = new Map<QueryFilter, number>();
  for (const f of leafFilters) {
    if (f.type === "in") {
      const setIdx = inSets.length;
      filterSetMap.set(f, setIdx);
      const s = new Set<any>();
      if (f.values) {
        for (const v of f.values) {
          if (v !== null && v !== undefined) {
            s.add(v);
            if (typeof v === "bigint") {
              s.add(Number(v));
            } else if (typeof v === "number" && Number.isSafeInteger(v)) {
              s.add(BigInt(v));
            }
          }
        }
      }
      inSets.push(s);
    }
  }

  const leafRegMap = new Map<QueryFilter, number>();
  for (let i = 0; i < leafFilters.length; i++) {
    leafRegMap.set(leafFilters[i], i);
  }

  if (leafFilters.length * 2 >= 64) {
    throw new TooManyRegistersError(leafFilters.length * 2);
  }

  if (plan.orderBy && plan.orderBy.length > 8) {
    throw new TooManyOrderByColumnsError(plan.orderBy.length);
  }

  if (plan.groupBy && plan.groupBy.length > 8) {
    throw new TooManyGroupByColumnsError(plan.groupBy.length);
  }

  const emitter = new BytecodeEmitter();

  if (plan.limit !== undefined && plan.limit <= 0) {
    emitter.emitUint8(OpCode.OP_HALT);
    return emitter.toByteArray();
  }

  let nextReg = leafFilters.length * 2;
  const hasOffset = plan.offset !== undefined && plan.offset > 0;
  const hasLimit = plan.limit !== undefined && plan.limit > 0;
  const regOffset = hasOffset ? nextReg++ : -1;
  const regLimit = hasLimit ? nextReg++ : -1;

  if (nextReg >= 64) {
    throw new TooManyRegistersError(nextReg);
  }

  const table = plan.table;

  const finalizeBytecode = (
    extra?: Record<string, any>,
    includeOutputColumns: boolean = true,
    includePlanMetrics: boolean = true,
  ): Uint8Array => {
    const result = emitter.toByteArray();
    (result as any).inSets = inSets;
    if (includeOutputColumns && plan.outputColumns) {
      (result as any).outputColumns = plan.outputColumns;
    }
    if (includePlanMetrics && planMetrics) {
      (result as any).planMetrics = planMetrics;
      (result as any).estimatedCost = planMetrics.totalCost;
      (result as any).estimatedRows = planMetrics.estimatedRows;
      (result as any).joinOrder = planMetrics.joinOrder;
    }
    if (extra) {
      Object.assign(result as any, extra);
    }
    return result;
  };

  // 1. Preamble: Load constant filter values into registers
  for (let i = 0; i < leafFilters.length; i++) {
    const filter = leafFilters[i];
    if (filter.type === "cmp") {
      const regConst = i * 2 + 1;
      const resolved =
        typeof filter.value === "number" && filter.colName
          ? resolveColumnAcrossTables(filter.colName, allTables)
          : undefined;
      emitLoadConstant(emitter, regConst, filter.value, resolved?.col.type);
    }
  }

  // Load offset / limit into registers
  if (hasOffset) {
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(regOffset);
    emitter.emitInt32(plan.offset!);
  }
  if (hasLimit) {
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(regLimit);
    emitter.emitInt32(plan.limit!);
  }

  // Case 1: In-Arena Hash Aggregation (GROUP BY / Aggregates)
  if (
    (plan.aggregates && plan.aggregates.length > 0) ||
    (plan.groupBy && plan.groupBy.length > 0)
  ) {
    const G = plan.groupBy?.length ?? 0;
    const aggregates = plan.aggregates ?? [];
    const A = aggregates.length;

    // Determine output columns
    const outputColumns: ColumnMeta[] = [];
    for (const gItem of plan.groupBy ?? []) {
      const gColName =
        typeof gItem === "string"
          ? gItem
          : (gItem.colName ??
            (gItem.expr ? deriveDefaultAlias(gItem.expr) : "group_key"));

      const matchingSelect = plan.selectExprs?.find((s) => {
        if (s.alias === gColName) return true;
        if (typeof gItem === "object" && gItem.expr) {
          return JSON.stringify(s.expr) === JSON.stringify(gItem.expr);
        }
        if (typeof gItem === "string" && gItem.includes("(")) {
          try {
            const parsed = parseExpression(gItem);
            return JSON.stringify(s.expr) === JSON.stringify(parsed);
          } catch {
            return false;
          }
        }
        return false;
      });

      const finalColName = matchingSelect?.alias ?? gColName;
      const col = table.columns.find(
        (c) => c.name === gColName || c.name === finalColName,
      );
      if (col) {
        outputColumns.push({ ...col, name: finalColName });
      } else {
        outputColumns.push({
          name: finalColName,
          type: DataType.TEXT,
          flags: ColumnFlag.NONE,
          colOffset: 0,
        });
      }
    }
    for (let j = 0; j < aggregates.length; j++) {
      const agg = aggregates[j];
      const aggName =
        agg.alias ?? (agg.colName ? `${agg.func}_${agg.colName}` : agg.func);
      const aggType = agg.func === "count" ? DataType.INT32 : DataType.FLOAT64;
      outputColumns.push({
        name: aggName,
        type: aggType,
        flags: ColumnFlag.NONE,
        colOffset: 0,
      });
    }

    // Register layout:
    const numFilterRegs = nextReg;
    const groupKeyStartReg = numFilterRegs;
    const aggValStartReg = groupKeyStartReg + G;
    const outAccReg = aggValStartReg + 4;
    const outGroupKeyReg = outAccReg + 4;
    const finalAggStartReg = outGroupKeyReg + G;
    const totalRegs = finalAggStartReg + A;

    if (totalRegs >= 64) {
      throw new TooManyRegistersError(totalRegs);
    }

    // OP_AGG_INIT: agg_id = 0, start_key_reg, num_keys = G, mode = 0 (hash)
    emitter.emitUint8(OpCode.OP_AGG_INIT);
    emitter.emitUint8(0);
    emitter.emitUint8(groupKeyStartReg);
    emitter.emitUint8(G);
    emitter.emitUint8(0);

    // Open Cursor
    emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
    emitter.emitUint8(0);
    emitter.emitUint32(table.rootPageId);

    // Rewind Cursor
    emitter.emitUint8(OpCode.OP_REWIND);
    emitter.emitUint8(0);
    const rewindJumpPatch = emitter.emitUint16(0);

    // Table scan loop
    const loopStartPos = emitter.currentOffset();
    const nextRowPatches: number[] = [];

    emitFilterTree(
      rootFilter,
      table,
      emitter,
      leafRegMap,
      nextRowPatches,
      plan.udfNameMap,
      undefined,
      filterSetMap,
      totalRegs,
    );

    // Extract group keys into registers
    if (plan.groupBy) {
      for (let k = 0; k < plan.groupBy.length; k++) {
        const gItem = plan.groupBy[k];
        const targetReg = groupKeyStartReg + k;
        let tempReg = Math.max(totalRegs + 4, 40);
        const allocReg = () => {
          if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
          return tempReg++;
        };

        if (typeof gItem === "object" && gItem.expr) {
          emitExpression(
            gItem.expr,
            table,
            emitter,
            0,
            targetReg,
            allocReg,
            plan.udfNameMap,
          );
        } else {
          const colName = typeof gItem === "string" ? gItem : gItem.colName!;
          const aliasExpr = plan.selectExprs?.find(
            (s) => s.alias === colName,
          )?.expr;
          if (aliasExpr) {
            emitExpression(
              aliasExpr,
              table,
              emitter,
              0,
              targetReg,
              allocReg,
              plan.udfNameMap,
            );
          } else {
            const colIdx = table.columns.findIndex((c) => c.name === colName);
            if (colIdx !== -1) {
              const col = table.columns[colIdx];
              emitReadColumn(emitter, 0, colIdx, targetReg, col.type);
            } else {
              try {
                const parsed = parseExpression(colName);
                emitExpression(
                  parsed,
                  table,
                  emitter,
                  0,
                  targetReg,
                  allocReg,
                  plan.udfNameMap,
                );
              } catch {
                throw new Error(
                  `Grouping column "${colName}" not found in table "${table.name}"`,
                );
              }
            }
          }
        }
      }
    }

    // If grouping without any aggregate functions, perform a COUNT step to register the group keys in the hash table
    if (A === 0 && G > 0) {
      emitter.emitUint8(OpCode.OP_AGG_STEP);
      emitter.emitUint8(0);
      emitter.emitUint8(groupKeyStartReg);
      emitter.emitUint8(G);
      emitter.emitUint8(255);
      emitter.emitUint8(0);
    }

    // Step each aggregate expression into its own dedicated accumulator slot (j = 0..A-1)
    for (let j = 0; j < aggregates.length; j++) {
      const agg = aggregates[j];
      let baseFuncId = 0;
      if (agg.func === "count") {
        baseFuncId = 0;
      } else if (agg.func === "sum") {
        baseFuncId = 1;
      } else if (agg.func === "avg") {
        baseFuncId = 2;
      } else if (agg.func === "min") {
        baseFuncId = 3;
      } else if (agg.func === "max") {
        baseFuncId = 4;
      }

      let valReg = 255;
      if (agg.colName && agg.colName !== "*") {
        const colIdx = table.columns.findIndex((c) => c.name === agg.colName);
        if (colIdx !== -1) {
          const col = table.columns[colIdx];
          valReg = aggValStartReg;
          emitReadColumn(emitter, 0, colIdx, valReg, col.type);
        } else {
          try {
            const parsed = parseExpression(agg.colName);
            let tempAggReg = Math.max(totalRegs + 4, 40);
            const allocAggReg = () => {
              if (tempAggReg >= 64) throw new TooManyRegistersError(tempAggReg);
              return tempAggReg++;
            };
            valReg = aggValStartReg;
            emitExpression(
              parsed,
              table,
              emitter,
              0,
              valReg,
              allocAggReg,
              plan.udfNameMap,
            );
          } catch {}
        }
      }

      emitter.emitUint8(OpCode.OP_AGG_STEP);
      emitter.emitUint8(0);
      emitter.emitUint8(groupKeyStartReg);
      emitter.emitUint8(G);
      emitter.emitUint8(valReg);
      emitter.emitUint8((j << 3) | baseFuncId);
    }

    // next_row_label
    const nextRowPos = emitter.currentOffset();
    for (const patch of nextRowPatches) {
      emitter.patchUint16(patch, nextRowPos);
    }

    // Advance cursor
    emitter.emitUint8(OpCode.OP_NEXT_ROW);
    emitter.emitUint8(0);
    const nextRowEofPatch = emitter.emitUint16(0);

    // Loop back
    emitter.emitUint8(OpCode.OP_JUMP);
    emitter.emitUint16(loopStartPos);

    // EOF: table scan completed
    const eofPos = emitter.currentOffset();
    emitter.patchUint16(rewindJumpPatch, eofPos);
    emitter.patchUint16(nextRowEofPatch, eofPos);

    // Aggregate emit loop
    const aggEmitLoopPos = emitter.currentOffset();
    emitter.emitUint8(OpCode.OP_AGG_NEXT);
    emitter.emitUint8(0); // agg_id
    emitter.emitUint8(outGroupKeyReg);
    emitter.emitUint8(outAccReg);
    const processGroupPatch = emitter.emitUint16(0);

    // EOF on aggregates
    const aggHaltPos = emitter.currentOffset();
    emitter.emitUint8(OpCode.OP_HALT);

    // Process group label
    const processGroupPos = emitter.currentOffset();
    emitter.patchUint16(processGroupPatch, processGroupPos);

    // Finalize each aggregate from its dedicated accumulator slot (j = 0..A-1)
    for (let j = 0; j < aggregates.length; j++) {
      const agg = aggregates[j];
      const outReg = finalAggStartReg + j;
      let sumReg = outAccReg;
      let baseFuncId = 0;
      if (agg.func === "count") {
        sumReg = outAccReg;
        baseFuncId = 0;
      } else if (agg.func === "sum") {
        sumReg = outAccReg;
        baseFuncId = 1;
      } else if (agg.func === "avg") {
        sumReg = outAccReg;
        baseFuncId = 2;
      } else if (agg.func === "min") {
        sumReg = outAccReg + 2;
        baseFuncId = 3;
      } else if (agg.func === "max") {
        sumReg = outAccReg + 3;
        baseFuncId = 4;
      }

      emitter.emitUint8(OpCode.OP_AGG_FINAL);
      emitter.emitUint8(sumReg);
      emitter.emitUint8(outAccReg + 1); // countReg
      emitter.emitUint8(outReg);
      emitter.emitUint8((j << 3) | baseFuncId);
    }

    // Symbol/register resolver for HAVING evaluation
    const resolveReg = (name?: string, expr?: ExprNode): number | undefined => {
      // 1. Check aggregates
      for (let j = 0; j < aggregates.length; j++) {
        const agg = aggregates[j];
        const aggReg = finalAggStartReg + j;

        if (name) {
          if (agg.alias && agg.alias === name) return aggReg;
          const defaultName = agg.colName
            ? `${agg.func}_${agg.colName}`
            : agg.func;
          if (defaultName === name) return aggReg;
          const sig = `${agg.func}(${agg.colName ?? "*"})`;
          if (sig === name.replace(/\s+/g, "")) return aggReg;
          if (agg.func === name) return aggReg;
        }

        if (expr && expr.type === "fn") {
          const fnName = expr.name.toLowerCase();
          if (agg.func === fnName) {
            if (fnName === "count") {
              const arg0 = expr.args[0];
              const argCol =
                arg0 && arg0.type === "col" ? arg0.name : undefined;
              if (
                agg.colName === undefined ||
                agg.colName === "*" ||
                agg.colName === argCol
              ) {
                return aggReg;
              }
            } else {
              const arg0 = expr.args[0];
              const argCol =
                arg0 && arg0.type === "col" ? arg0.name : undefined;
              if (agg.colName === argCol) {
                return aggReg;
              }
            }
          }
        }
      }

      // 2. Check group keys
      if (plan.groupBy) {
        for (let k = 0; k < plan.groupBy.length; k++) {
          const gItem = plan.groupBy[k];
          const gReg = outGroupKeyReg + k;
          const gColName = typeof gItem === "string" ? gItem : gItem.colName;
          const gExpr = typeof gItem === "object" ? gItem.expr : undefined;

          if (name) {
            if (gColName === name) return gReg;
            if (gExpr && deriveDefaultAlias(gExpr) === name) return gReg;
            const selectAlias = plan.selectExprs?.find((s) => s.alias === name);
            if (selectAlias) {
              if (gColName === selectAlias.alias) return gReg;
              if (
                gExpr &&
                JSON.stringify(gExpr) === JSON.stringify(selectAlias.expr)
              )
                return gReg;
              if (typeof gItem === "string" && gItem.includes("(")) {
                try {
                  const parsed = parseExpression(gItem);
                  if (
                    JSON.stringify(parsed) === JSON.stringify(selectAlias.expr)
                  )
                    return gReg;
                } catch {}
              }
            }
          }

          if (expr) {
            if (gExpr && JSON.stringify(gExpr) === JSON.stringify(expr)) {
              return gReg;
            }
            if (expr.type === "col" && gColName === expr.name) {
              return gReg;
            }
            if (typeof gItem === "string" && gItem.includes("(")) {
              try {
                const parsed = parseExpression(gItem);
                if (JSON.stringify(parsed) === JSON.stringify(expr))
                  return gReg;
              } catch {}
            }
          }
        }
      }

      return undefined;
    };

    // Evaluate HAVING clause if present
    if (plan.having && plan.having.length > 0) {
      let rootHaving: QueryFilter | null = null;
      if (plan.having.length === 1) {
        rootHaving = plan.having[0];
      } else {
        rootHaving = { type: "and", children: plan.having };
      }

      const failPatches: number[] = [];
      let tempHavingReg = Math.max(totalRegs + 4, 40);
      const allocHavingReg = () => {
        if (tempHavingReg >= 64) throw new TooManyRegistersError(tempHavingReg);
        return tempHavingReg++;
      };

      emitHavingTree(
        rootHaving,
        table,
        emitter,
        resolveReg,
        allocHavingReg,
        failPatches,
        plan.udfNameMap,
      );

      for (const patch of failPatches) {
        emitter.patchUint16(patch, aggEmitLoopPos);
      }
    }

    if (hasOffset) {
      emitter.emitUint8(OpCode.OP_OFFSET);
      emitter.emitUint8(regOffset);
      emitter.emitUint16(aggEmitLoopPos);
    }

    // Emit result row: group keys followed by aggregated results
    emitter.emitUint8(OpCode.OP_RESULT_ROW);
    emitter.emitUint8(outGroupKeyReg);
    emitter.emitUint8(G + A);

    if (hasLimit) {
      emitter.emitUint8(OpCode.OP_LIMIT);
      emitter.emitUint8(regLimit);
      emitter.emitUint16(aggHaltPos);
    }

    // Jump back to next aggregate
    emitter.emitUint8(OpCode.OP_JUMP);
    emitter.emitUint16(aggEmitLoopPos);

    (plan as any).outputColumns = outputColumns;
    return finalizeBytecode({ outputColumns }, false, false);
  }

  // Check if an active index covers the query filters or directly satisfies ORDER BY
  const indexScan = !isJoinQuery
    ? chooseIndexScan(table, topConjunctions, leafFilters, plan.orderBy)
    : null;

  // Case 2: In-Arena Sorter (ORDER BY)
  // If an active index already satisfies the requested sort order (Interesting Orders optimization),
  // we bypass the in-arena sorter completely and stream sorted rows directly via index cursor!
  if (
    !isJoinQuery &&
    plan.orderBy &&
    plan.orderBy.length > 0 &&
    !indexScan?.satisfiesOrderBy
  ) {
    const K = plan.orderBy.length;
    const sortKeyStartReg = nextReg;
    const totalRegs = sortKeyStartReg + K;

    if (totalRegs >= 64) {
      throw new TooManyRegistersError(totalRegs);
    }

    const keyInfo: VmKeyInfo = {
      numKeys: K,
      directions: plan.orderBy.map((k) => (k.direction === "desc" ? 1 : 0)),
      nullOrders: plan.orderBy.map((k) =>
        k.nullOrder === "nulls_last"
          ? 1
          : k.nullOrder === "nulls_first"
            ? 0
            : k.direction === "desc"
              ? 1
              : 0,
      ),
      limit: plan.limit,
      offset: plan.offset,
    };
    plan.keyInfos = [keyInfo];

    // OP_SORTER_OPEN
    emitter.emitUint8(OpCode.OP_SORTER_OPEN);
    emitter.emitUint8(0); // sorter_id
    emitter.emitUint8(0); // key_info_idx

    // Open Cursor
    emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
    emitter.emitUint8(0);
    emitter.emitUint32(table.rootPageId);

    // Rewind Cursor
    emitter.emitUint8(OpCode.OP_REWIND);
    emitter.emitUint8(0);
    const rewindJumpPatch = emitter.emitUint16(0);

    // Table scan loop
    const loopStartPos = emitter.currentOffset();
    const nextRowPatches: number[] = [];

    emitFilterTree(
      rootFilter,
      table,
      emitter,
      leafRegMap,
      nextRowPatches,
      plan.udfNameMap,
      undefined,
      filterSetMap,
      totalRegs,
    );

    // Extract sort keys into registers
    for (let k = 0; k < K; k++) {
      const sortKey = plan.orderBy[k];
      const targetReg = sortKeyStartReg + k;
      let tempReg = totalRegs;
      const allocReg = () => {
        if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
        return tempReg++;
      };

      if (sortKey.expr) {
        emitExpression(
          sortKey.expr,
          table,
          emitter,
          0,
          targetReg,
          allocReg,
          plan.udfNameMap,
        );
      } else if (sortKey.colName) {
        const colName = sortKey.colName;
        // 1. Check if colName matches a select alias
        const aliasExpr = plan.selectExprs?.find(
          (s) => s.alias === colName,
        )?.expr;
        if (aliasExpr) {
          emitExpression(
            aliasExpr,
            table,
            emitter,
            0,
            targetReg,
            allocReg,
            plan.udfNameMap,
          );
        } else {
          // 2. Check if colName is a physical table column
          const colIdx = table.columns.findIndex((c) => c.name === colName);
          if (colIdx !== -1) {
            const col = table.columns[colIdx];
            emitReadColumn(emitter, 0, colIdx, targetReg, col.type);
          } else {
            // 3. Fallback: parse as expression
            try {
              const parsed = parseExpression(colName);
              emitExpression(
                parsed,
                table,
                emitter,
                0,
                targetReg,
                allocReg,
                plan.udfNameMap,
              );
            } catch {
              throw new Error(
                `Order by column "${colName}" not found in table "${table.name}"`,
              );
            }
          }
        }
      }
    }

    // Insert into sorter
    emitter.emitUint8(OpCode.OP_SORTER_INSERT);
    emitter.emitUint8(0); // sorter_id
    emitter.emitUint8(sortKeyStartReg);
    emitter.emitUint8(K);
    emitter.emitUint8(0); // cursor 0

    // next_row_label
    const nextRowPos = emitter.currentOffset();
    for (const patch of nextRowPatches) {
      emitter.patchUint16(patch, nextRowPos);
    }

    // Advance cursor
    emitter.emitUint8(OpCode.OP_NEXT_ROW);
    emitter.emitUint8(0);
    const nextRowEofPatch = emitter.emitUint16(0);

    // Loop back
    emitter.emitUint8(OpCode.OP_JUMP);
    emitter.emitUint16(loopStartPos);

    // EOF: table scan completed
    const eofPos = emitter.currentOffset();
    emitter.patchUint16(rewindJumpPatch, eofPos);
    emitter.patchUint16(nextRowEofPatch, eofPos);

    // Sort entries
    emitter.emitUint8(OpCode.OP_SORTER_SORT);
    emitter.emitUint8(0); // sorter_id

    // Sorter emit loop
    const emitLoopPos = emitter.currentOffset();
    emitter.emitUint8(OpCode.OP_SORTER_NEXT);
    emitter.emitUint8(0); // sorter_id
    emitter.emitUint16(emitLoopPos); // jumps back until EOF

    // Fallthrough on EOF:
    emitter.emitUint8(OpCode.OP_HALT);

    return finalizeBytecode({ keyInfos: plan.keyInfos }, false);
  }

  // Case 3: Scan (Unsorted, non-aggregate) / Nested Loop Joins
  const hasSelectExprs =
    plan.selectExprs !== undefined &&
    plan.selectExprs.length > 0 &&
    !(
      plan.selectExprs.length === 1 &&
      plan.selectExprs[0].expr.type === "col" &&
      plan.selectExprs[0].expr.name === "*"
    );

  let outSelectExprs: ParsedSelectExpr[] = [];
  if (hasSelectExprs) {
    outSelectExprs = plan.selectExprs!;
  } else if (isJoinQuery) {
    const seenNames = new Set<string>();
    const dupNames = new Set<string>();
    for (const t of allTables) {
      for (const c of t.columns) {
        if (seenNames.has(c.name.toLowerCase())) {
          dupNames.add(c.name.toLowerCase());
        }
        seenNames.add(c.name.toLowerCase());
      }
    }
    for (const t of allTables) {
      for (const c of t.columns) {
        const alias = dupNames.has(c.name.toLowerCase())
          ? `${t.name}.${c.name}`
          : c.name;
        outSelectExprs.push({
          expr: { type: "col", name: `${t.name}.${c.name}` },
          alias,
        });
      }
    }
  }

  let outStartReg = -1;
  if (hasSelectExprs || isJoinQuery) {
    const cols: ColumnMeta[] = outSelectExprs.map((se) => ({
      name: se.alias,
      type: inferExprType(se.expr, table, plan.udfDefs, allTables),
      flags: ColumnFlag.NONE,
      colOffset: 0,
    }));
    plan.outputColumns = cols;
    outStartReg = nextReg;
    nextReg += outSelectExprs.length;
    if (nextReg >= 64) {
      throw new TooManyRegistersError(nextReg);
    }
  }

  if (isJoinQuery) {
    const N = allTables.length;
    const regMatched: number[] = new Array(N);
    const regNullRow: number[] = new Array(N);
    const nullFlagRegs = new Map<number, number>();
    for (let i = 1; i < N; i++) {
      const joinPlan = plan.joinedTables![i - 1];
      if (joinPlan.type === "left") {
        regMatched[i] = nextReg++;
        regNullRow[i] = nextReg++;
        nullFlagRegs.set(i, regNullRow[i]);
      }
    }
    const regJoinLeft = nextReg++;
    const regJoinRight = nextReg++;
    const regZero = nextReg++;
    const joinNullFlags: JoinNullFlags | undefined =
      nullFlagRegs.size > 0 ? { nullFlagRegs, regZero } : undefined;

    let regKey0 = -1;
    if (table0Scan && indexCursor0 !== -1) {
      if (table0Scan.compositeValue) {
        regKey0 = nextReg++;
        if (nextReg >= 64) throw new TooManyRegistersError(nextReg);
        emitter.emitUint8(OpCode.OP_LOAD_BLOB);
        emitter.emitUint8(regKey0);
        emitter.emitBytes(table0Scan.compositeValue);
      } else if (table0Scan.scanType === "multi_point") {
        regKey0 = nextReg++;
        if (nextReg >= 64) throw new TooManyRegistersError(nextReg);
      } else if (table0Scan.filterIndex >= 0) {
        regKey0 = table0Scan.filterIndex * 2 + 1;
      } else {
        // Synthetic range seek for ORDER BY index scan: load minimum possible value
        regKey0 = nextReg++;
        if (nextReg >= 64) throw new TooManyRegistersError(nextReg);
        const minVal = getMinKeyValueForType(table0Scan.keyType);
        emitLoadConstant(emitter, regKey0, minVal, table0Scan.keyType);
      }
    }

    if (nextReg >= 64) {
      throw new TooManyRegistersError(nextReg);
    }

    // Initialize constant 0 register once for LEFT JOIN match / null-row checks
    if (joinNullFlags) {
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(regZero);
      emitter.emitInt32(0);
    }

    // Open Cursors for all tables
    for (let i = 0; i < N; i++) {
      emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
      emitter.emitUint8(i);
      emitter.emitUint32(allTables[i].rootPageId);
    }

    // Open Table 0 index cursor if table0Scan is active
    if (table0Scan && indexCursor0 !== -1) {
      emitter.emitUint8(OpCode.OP_OPEN_INDEX);
      emitter.emitUint8(indexCursor0);
      emitter.emitUint32(table0Scan.index.rootPageId);
    }

    // Open index cursors for accelerated joins
    for (let i = 1; i < N; i++) {
      const jIdx = joinIndices[i];
      if (jIdx) {
        emitter.emitUint8(OpCode.OP_OPEN_INDEX);
        emitter.emitUint8(jIdx.indexCursor);
        emitter.emitUint32(jIdx.index.rootPageId);
      }
    }

    const rewindJumpPatches: number[] = new Array(N);
    const loopStartPositions: number[] = new Array(N);
    const bodyStartPositions: number[] = new Array(N);
    const nextRowPatchesPerTable: number[][] = Array.from(
      { length: N },
      () => [],
    );
    const nextRowEofPatches: number[] = new Array(N);
    const limitHaltPatches: number[] = [];

    // Outer table (Table 0) Seek or Rewind
    if (table0Scan && indexCursor0 !== -1) {
      if (table0Scan.scanType === "point") {
        emitter.emitUint8(OpCode.OP_INDEX_SEEK_EQ);
        emitter.emitUint8(indexCursor0);
        emitter.emitUint8(0);
        emitter.emitUint8(regKey0);
        emitter.emitUint8(table0Scan.keyType);
        rewindJumpPatches[0] = emitter.emitUint16(0);
      } else {
        emitter.emitUint8(OpCode.OP_INDEX_SEEK_GE);
        emitter.emitUint8(indexCursor0);
        emitter.emitUint8(0);
        emitter.emitUint8(regKey0);
        emitter.emitUint8(table0Scan.keyType);
        rewindJumpPatches[0] = emitter.emitUint16(0);
      }
    } else {
      emitter.emitUint8(OpCode.OP_REWIND);
      emitter.emitUint8(0);
      rewindJumpPatches[0] = emitter.emitUint16(0);
    }

    loopStartPositions[0] = emitter.currentOffset();

    // Early filter pushdown for Table 0
    if (pushedFilters[0] && pushedFilters[0].length > 0) {
      const root0 = buildRootFilter(pushedFilters[0]);
      emitFilterTree(
        root0,
        allTables[0],
        emitter,
        leafRegMap,
        nextRowPatchesPerTable[0],
        plan.udfNameMap,
        allTables,
        filterSetMap,
        nextReg,
      );
    }

    // Nested Joined Tables (1..N-1)
    for (let i = 1; i < N; i++) {
      const joinPlan = plan.joinedTables![i - 1];
      const jIdx = joinIndices[i];

      if (joinPlan.type === "left") {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regMatched[i]);
        emitter.emitInt32(0);
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regNullRow[i]);
        emitter.emitInt32(0);
      }

      if (jIdx && jIdx.isUnique) {
        // Point seek into unique index (guarded if outer table is a prior LEFT JOIN in null-row mode)
        emitReadColumnGuarded(
          emitter,
          jIdx.outerCol.cursor,
          jIdx.outerCol.colIdx,
          regJoinLeft,
          jIdx.outerCol.col.type,
          joinNullFlags,
        );

        emitter.emitUint8(OpCode.OP_INDEX_SEEK_EQ);
        emitter.emitUint8(jIdx.indexCursor);
        emitter.emitUint8(i); // data cursor
        emitter.emitUint8(regJoinLeft);
        emitter.emitUint8(jIdx.outerCol.col.type);
        rewindJumpPatches[i] = emitter.emitUint16(0); // If not found, jumps to eofPos of table i

        loopStartPositions[i] = emitter.currentOffset();

        if (
          joinPlan.type === "inner" &&
          pushedFilters[i] &&
          pushedFilters[i].length > 0
        ) {
          const rootI = buildRootFilter(pushedFilters[i]);
          emitFilterTree(
            rootI,
            allTables[i],
            emitter,
            leafRegMap,
            nextRowPatchesPerTable[i],
            plan.udfNameMap,
            allTables,
            filterSetMap,
            nextReg,
          );
        }

        if (joinPlan.type === "left") {
          emitter.emitUint8(OpCode.OP_LOAD_INT);
          emitter.emitUint8(regMatched[i]);
          emitter.emitInt32(1);
        }
      } else if (jIdx && !jIdx.isUnique) {
        // Range seek into non-unique index (guarded if outer table is a prior LEFT JOIN in null-row mode)
        emitReadColumnGuarded(
          emitter,
          jIdx.outerCol.cursor,
          jIdx.outerCol.colIdx,
          regJoinLeft,
          jIdx.outerCol.col.type,
          joinNullFlags,
        );

        emitter.emitUint8(OpCode.OP_INDEX_SEEK_GE);
        emitter.emitUint8(jIdx.indexCursor);
        emitter.emitUint8(i); // data cursor
        emitter.emitUint8(regJoinLeft);
        emitter.emitUint8(jIdx.outerCol.col.type);
        rewindJumpPatches[i] = emitter.emitUint16(0); // If no entries >= key, jumps to eofPos

        loopStartPositions[i] = emitter.currentOffset();

        emitReadColumn(
          emitter,
          i,
          jIdx.innerCol.colIdx,
          regJoinRight,
          jIdx.innerCol.col.type,
        );

        emitter.emitUint8(OpCode.OP_EQ);
        emitter.emitUint8(regJoinLeft);
        emitter.emitUint8(regJoinRight);
        const condMatchPatch = emitter.emitUint16(0);

        // Mismatch: we scanned past all duplicates for this key! Jump to eofPos
        emitter.emitUint8(OpCode.OP_JUMP);
        nextRowPatchesPerTable[i].push(emitter.emitUint16(0));

        // Match
        emitter.patchUint16(condMatchPatch, emitter.currentOffset());

        if (
          joinPlan.type === "inner" &&
          pushedFilters[i] &&
          pushedFilters[i].length > 0
        ) {
          const rootI = buildRootFilter(pushedFilters[i]);
          emitFilterTree(
            rootI,
            allTables[i],
            emitter,
            leafRegMap,
            nextRowPatchesPerTable[i],
            plan.udfNameMap,
            allTables,
            filterSetMap,
            nextReg,
          );
        }

        if (joinPlan.type === "left") {
          emitter.emitUint8(OpCode.OP_LOAD_INT);
          emitter.emitUint8(regMatched[i]);
          emitter.emitInt32(1);
        }
      } else {
        // Cartesian Fallback
        emitter.emitUint8(OpCode.OP_REWIND);
        emitter.emitUint8(i);
        rewindJumpPatches[i] = emitter.emitUint16(0);

        loopStartPositions[i] = emitter.currentOffset();

        const resolvedLeft = resolveColumnAcrossTables(
          joinPlan.leftCol,
          allTables,
        );
        if (!resolvedLeft) {
          throw new Error(
            `Join column "${joinPlan.leftCol}" not found in tables`,
          );
        }
        const resolvedRight = resolveColumnAcrossTables(
          joinPlan.rightCol,
          allTables,
        );
        if (!resolvedRight) {
          throw new Error(
            `Join column "${joinPlan.rightCol}" not found in tables`,
          );
        }

        emitReadColumnGuarded(
          emitter,
          resolvedLeft.cursor,
          resolvedLeft.colIdx,
          regJoinLeft,
          resolvedLeft.col.type,
          joinNullFlags,
        );
        emitReadColumnGuarded(
          emitter,
          resolvedRight.cursor,
          resolvedRight.colIdx,
          regJoinRight,
          resolvedRight.col.type,
          joinNullFlags,
        );

        let cmpOp: OpCode;
        switch (joinPlan.op) {
          case "=":
            cmpOp = OpCode.OP_EQ;
            break;
          case "!=":
            cmpOp = OpCode.OP_NE;
            break;
          case ">":
            cmpOp = OpCode.OP_GT;
            break;
          case ">=":
            cmpOp = OpCode.OP_GE;
            break;
          case "<":
            cmpOp = OpCode.OP_LT;
            break;
          case "<=":
            cmpOp = OpCode.OP_LE;
            break;
          default:
            cmpOp = OpCode.OP_EQ;
        }

        emitter.emitUint8(cmpOp);
        emitter.emitUint8(regJoinLeft);
        emitter.emitUint8(regJoinRight);
        const condMatchPatch = emitter.emitUint16(0);

        // Mismatch: jump to nextRow for table i
        emitter.emitUint8(OpCode.OP_JUMP);
        nextRowPatchesPerTable[i].push(emitter.emitUint16(0));

        // Match
        emitter.patchUint16(condMatchPatch, emitter.currentOffset());

        if (
          joinPlan.type === "inner" &&
          pushedFilters[i] &&
          pushedFilters[i].length > 0
        ) {
          const rootI = buildRootFilter(pushedFilters[i]);
          emitFilterTree(
            rootI,
            allTables[i],
            emitter,
            leafRegMap,
            nextRowPatchesPerTable[i],
            plan.udfNameMap,
            allTables,
            filterSetMap,
            nextReg,
          );
        }

        if (joinPlan.type === "left") {
          emitter.emitUint8(OpCode.OP_LOAD_INT);
          emitter.emitUint8(regMatched[i]);
          emitter.emitInt32(1);
        }
      }

      // Entry point into downstream join loops (i+1..N-1) and final WHERE/SELECT.
      // When a LEFT JOIN has 0 matches, we set regNullRow[i] = 1 and jump here so all
      // downstream joins (INNER or LEFT) and final filters/projections execute normally!
      bodyStartPositions[i] = emitter.currentOffset();
    }

    // Innermost: remaining WHERE filters (honoring LEFT JOIN null-row flags)
    emitFilterTree(
      rootRemainingFilter,
      table,
      emitter,
      leafRegMap,
      nextRowPatchesPerTable[N - 1],
      plan.udfNameMap,
      allTables,
      filterSetMap,
      nextReg,
      joinNullFlags,
    );

    const hasOrderBy = plan.orderBy !== undefined && plan.orderBy.length > 0;
    const shouldApplyLimitOffset = !hasOrderBy || isJoinOrderPreserved;

    let offsetSkipPatch = -1;
    if (hasOffset && shouldApplyLimitOffset) {
      emitter.emitUint8(OpCode.OP_OFFSET);
      emitter.emitUint8(regOffset);
      offsetSkipPatch = emitter.emitUint16(0);
    }

    let exprTempReg = nextReg;
    const allocExprReg = () => {
      if (exprTempReg >= 64) throw new TooManyRegistersError(exprTempReg);
      return exprTempReg++;
    };

    for (let k = 0; k < outSelectExprs.length; k++) {
      emitExpression(
        outSelectExprs[k].expr,
        table,
        emitter,
        0,
        outStartReg + k,
        allocExprReg,
        plan.udfNameMap,
        undefined,
        allTables,
        joinNullFlags,
      );
    }

    emitter.emitUint8(OpCode.OP_RESULT_ROW);
    emitter.emitUint8(outStartReg);
    emitter.emitUint8(outSelectExprs.length);

    if (hasLimit && shouldApplyLimitOffset) {
      emitter.emitUint8(OpCode.OP_LIMIT);
      emitter.emitUint8(regLimit);
      limitHaltPatches.push(emitter.emitUint16(0));
    }

    // Close loops from innermost to outermost
    for (let i = N - 1; i >= 1; i--) {
      const nextRowPos = emitter.currentOffset();
      if (i === N - 1 && offsetSkipPatch !== -1) {
        emitter.patchUint16(offsetSkipPatch, nextRowPos);
      }
      for (const patch of nextRowPatchesPerTable[i]) {
        emitter.patchUint16(patch, nextRowPos);
      }

      const joinPlan = plan.joinedTables![i - 1];
      let exitNullRowPassPatch = -1;
      if (joinPlan.type === "left") {
        // If we are finishing the synthetic NULL-row pass (regNullRow[i] !== 0),
        // exit this join loop immediately without advancing cursor i.
        emitter.emitUint8(OpCode.OP_EQ);
        emitter.emitUint8(regNullRow[i]);
        emitter.emitUint8(regZero);
        const advanceRealPatch = emitter.emitUint16(0);

        emitter.emitUint8(OpCode.OP_JUMP);
        exitNullRowPassPatch = emitter.emitUint16(0);

        emitter.patchUint16(advanceRealPatch, emitter.currentOffset());
      }

      const jIdx = joinIndices[i];
      if (jIdx && jIdx.isUnique) {
        // Point seek: at most 1 match
        const eofPos = emitter.currentOffset();
        emitter.patchUint16(rewindJumpPatches[i], eofPos);
      } else if (jIdx && !jIdx.isUnique) {
        // Non-unique index: advance index cursor to next entry
        emitter.emitUint8(OpCode.OP_INDEX_NEXT);
        emitter.emitUint8(jIdx.indexCursor);
        emitter.emitUint8(i); // data cursor
        nextRowEofPatches[i] = emitter.emitUint16(0);

        emitter.emitUint8(OpCode.OP_JUMP);
        emitter.emitUint16(loopStartPositions[i]);

        const eofPos = emitter.currentOffset();
        emitter.patchUint16(rewindJumpPatches[i], eofPos);
        emitter.patchUint16(nextRowEofPatches[i], eofPos);
      } else {
        // Cartesian fallback: OP_NEXT_ROW
        emitter.emitUint8(OpCode.OP_NEXT_ROW);
        emitter.emitUint8(i);
        nextRowEofPatches[i] = emitter.emitUint16(0);

        emitter.emitUint8(OpCode.OP_JUMP);
        emitter.emitUint16(loopStartPositions[i]);

        const eofPos = emitter.currentOffset();
        emitter.patchUint16(rewindJumpPatches[i], eofPos);
        emitter.patchUint16(nextRowEofPatches[i], eofPos);
      }

      if (joinPlan.type === "left") {
        // If cursor i had 0 matches, perform a single synthetic NULL-row pass through
        // bodyStartPositions[i] (which runs all downstream joins, WHERE, and SELECT).
        emitter.emitUint8(OpCode.OP_EQ);
        emitter.emitUint8(regMatched[i]);
        emitter.emitUint8(regZero);
        const enterNullRowPatch = emitter.emitUint16(0);

        emitter.emitUint8(OpCode.OP_JUMP);
        const skipNullRowPatch = emitter.emitUint16(0);

        emitter.patchUint16(enterNullRowPatch, emitter.currentOffset());
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regMatched[i]);
        emitter.emitInt32(1);
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regNullRow[i]);
        emitter.emitInt32(1);
        emitter.emitUint8(OpCode.OP_JUMP);
        emitter.emitUint16(bodyStartPositions[i]);

        const afterLoopPos = emitter.currentOffset();
        emitter.patchUint16(skipNullRowPatch, afterLoopPos);
        if (exitNullRowPassPatch !== -1) {
          emitter.patchUint16(exitNullRowPassPatch, afterLoopPos);
        }
      }
    }

    const nextRowPos0 = emitter.currentOffset();
    for (const patch of nextRowPatchesPerTable[0]) {
      emitter.patchUint16(patch, nextRowPos0);
    }

    if (table0Scan && indexCursor0 !== -1) {
      if (table0Scan.scanType === "point") {
        emitter.emitUint8(OpCode.OP_JUMP);
        nextRowEofPatches[0] = emitter.emitUint16(0);
      } else {
        emitter.emitUint8(OpCode.OP_INDEX_NEXT);
        emitter.emitUint8(indexCursor0);
        emitter.emitUint8(0);
        nextRowEofPatches[0] = emitter.emitUint16(0);

        emitter.emitUint8(OpCode.OP_JUMP);
        emitter.emitUint16(loopStartPositions[0]);
      }
    } else {
      emitter.emitUint8(OpCode.OP_NEXT_ROW);
      emitter.emitUint8(0);
      nextRowEofPatches[0] = emitter.emitUint16(0);

      emitter.emitUint8(OpCode.OP_JUMP);
      emitter.emitUint16(loopStartPositions[0]);
    }

    const eofPos0 = emitter.currentOffset();
    emitter.patchUint16(rewindJumpPatches[0], eofPos0);
    emitter.patchUint16(nextRowEofPatches[0], eofPos0);
    for (const patch of limitHaltPatches) {
      emitter.patchUint16(patch, eofPos0);
    }

    emitter.emitUint8(OpCode.OP_HALT);

    const joinedTableScans = plan.joinedTables?.map((j, idx) => {
      const tableIdx = idx + 1;
      const cand = joinIndices[tableIdx];
      return {
        tableIndex: tableIdx,
        tableName: j.table.name,
        scanType: cand ? ("IndexScan" as const) : ("TableScan" as const),
        indexName: cand ? cand.index.name : undefined,
      };
    });
    if (isJoinOrderPreserved) {
      plan.isOrderSatisfied = true;
    }
    const extra: Record<string, any> = {
      joinedTableScans,
      allTables,
      table0Scan,
      isOrderSatisfied: isJoinOrderPreserved,
    };
    if (whereMetrics) {
      extra.whereMetrics = whereMetrics;
    }
    return finalizeBytecode(extra);
  }

  const emitSelectedRow = (): void => {
    if (hasSelectExprs) {
      const allocExprReg = createRegAllocator(nextReg);
      for (let i = 0; i < plan.selectExprs!.length; i++) {
        emitExpression(
          plan.selectExprs![i].expr,
          table,
          emitter,
          0,
          outStartReg + i,
          allocExprReg,
          plan.udfNameMap,
        );
      }
      emitter.emitUint8(OpCode.OP_RESULT_ROW);
      emitter.emitUint8(outStartReg);
      emitter.emitUint8(plan.selectExprs!.length);
    } else {
      emitter.emitUint8(OpCode.OP_EMIT_ROW);
      emitter.emitUint8(0);
    }
  };

  if (indexScan) {
    let regKey: number;
    if (indexScan.compositeValue) {
      regKey = nextReg++;
      if (regKey >= 64) throw new TooManyRegistersError(regKey);
      emitter.emitUint8(OpCode.OP_LOAD_BLOB);
      emitter.emitUint8(regKey);
      emitter.emitBytes(indexScan.compositeValue);
    } else if (indexScan.scanType === "multi_point") {
      regKey = nextReg++;
      if (regKey >= 64) throw new TooManyRegistersError(regKey);
    } else if (indexScan.filterIndex >= 0) {
      regKey = indexScan.filterIndex * 2 + 1;
    } else {
      // Synthetic index scan for ORDER BY: load min key value for the index column
      regKey = nextReg++;
      if (regKey >= 64) throw new TooManyRegistersError(regKey);
      const minVal = getMinKeyValueForType(indexScan.keyType);
      emitLoadConstant(emitter, regKey, minVal, indexScan.keyType);
    }

    const finalizeIndexScan = (includeMetrics: boolean = true): Uint8Array => {
      const extra: Record<string, any> = { indexScan };
      if (includeMetrics && indexScan?.satisfiesOrderBy) {
        extra.isOrderSatisfied = true;
        plan.isOrderSatisfied = true;
      }
      return finalizeBytecode(extra, true, includeMetrics);
    };

    if (indexScan.scanType === "point") {
      emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
      emitter.emitUint8(0);
      emitter.emitUint32(table.rootPageId);

      emitter.emitUint8(OpCode.OP_OPEN_INDEX);
      emitter.emitUint8(1);
      emitter.emitUint32(indexScan.index.rootPageId);

      emitter.emitUint8(OpCode.OP_INDEX_SEEK_EQ);
      emitter.emitUint8(1); // index cursor
      emitter.emitUint8(0); // data cursor
      emitter.emitUint8(regKey);
      emitter.emitUint8(indexScan.keyType);
      const seekNotFoundPatch = emitter.emitUint16(0);

      const nextRowPatches: number[] = [];
      emitFilterTree(
        rootFilter,
        table,
        emitter,
        leafRegMap,
        nextRowPatches,
        plan.udfNameMap,
        undefined,
        filterSetMap,
        nextReg,
      );

      let offsetSkipPatch = -1;
      if (hasOffset) {
        emitter.emitUint8(OpCode.OP_OFFSET);
        emitter.emitUint8(regOffset);
        offsetSkipPatch = emitter.emitUint16(0);
      }

      emitSelectedRow();

      emitter.emitUint8(OpCode.OP_JUMP);
      const jumpEofPatch = emitter.emitUint16(0);

      const eofPos = emitter.currentOffset();
      emitter.patchUint16(seekNotFoundPatch, eofPos);
      emitter.patchUint16(jumpEofPatch, eofPos);
      if (offsetSkipPatch !== -1) {
        emitter.patchUint16(offsetSkipPatch, eofPos);
      }
      for (const patch of nextRowPatches) {
        emitter.patchUint16(patch, eofPos);
      }

      emitter.emitUint8(OpCode.OP_HALT);
      return finalizeIndexScan();
    } else if (indexScan.scanType === "multi_point") {
      const numValues = indexScan.inValues ? indexScan.inValues.length : 0;
      if (numValues === 0) {
        emitter.emitUint8(OpCode.OP_HALT);
        return finalizeIndexScan(false);
      }

      emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
      emitter.emitUint8(0);
      emitter.emitUint32(table.rootPageId);

      emitter.emitUint8(OpCode.OP_OPEN_INDEX);
      emitter.emitUint8(1);
      emitter.emitUint32(indexScan.index.rootPageId);

      const limitHaltPatches: number[] = [];

      for (let vIdx = 0; vIdx < numValues; vIdx++) {
        const val = indexScan.inValues![vIdx];
        emitLoadConstant(emitter, regKey, val, indexScan.keyType);

        emitter.emitUint8(OpCode.OP_INDEX_SEEK_EQ);
        emitter.emitUint8(1); // index cursor
        emitter.emitUint8(0); // data cursor
        emitter.emitUint8(regKey);
        emitter.emitUint8(indexScan.keyType);
        const seekNotFoundPatch = emitter.emitUint16(0);

        const nextRowPatches: number[] = [];
        emitFilterTree(
          rootFilter,
          table,
          emitter,
          leafRegMap,
          nextRowPatches,
          plan.udfNameMap,
          undefined,
          filterSetMap,
          nextReg,
        );

        let offsetSkipPatch = -1;
        if (hasOffset) {
          emitter.emitUint8(OpCode.OP_OFFSET);
          emitter.emitUint8(regOffset);
          offsetSkipPatch = emitter.emitUint16(0);
        }

        emitSelectedRow();

        if (hasLimit) {
          emitter.emitUint8(OpCode.OP_LIMIT);
          emitter.emitUint8(regLimit);
          limitHaltPatches.push(emitter.emitUint16(0));
        }

        const isLastVal = vIdx === numValues - 1;
        let jumpNextValPatch = -1;
        if (!isLastVal) {
          emitter.emitUint8(OpCode.OP_JUMP);
          jumpNextValPatch = emitter.emitUint16(0);
        }

        const nextValPos = emitter.currentOffset();
        emitter.patchUint16(seekNotFoundPatch, nextValPos);
        for (const patch of nextRowPatches) {
          emitter.patchUint16(patch, nextValPos);
        }
        if (offsetSkipPatch !== -1) {
          emitter.patchUint16(offsetSkipPatch, nextValPos);
        }
        if (jumpNextValPatch !== -1) {
          emitter.patchUint16(jumpNextValPatch, nextValPos);
        }
      }

      const eofPos = emitter.currentOffset();
      for (const patch of limitHaltPatches) {
        emitter.patchUint16(patch, eofPos);
      }
      emitter.emitUint8(OpCode.OP_HALT);
      return finalizeIndexScan();
    } else {
      // Range seek in index
      emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
      emitter.emitUint8(0);
      emitter.emitUint32(table.rootPageId);

      emitter.emitUint8(OpCode.OP_OPEN_INDEX);
      emitter.emitUint8(1);
      emitter.emitUint32(indexScan.index.rootPageId);

      emitter.emitUint8(OpCode.OP_INDEX_SEEK_GE);
      emitter.emitUint8(1);
      emitter.emitUint8(0);
      emitter.emitUint8(regKey);
      emitter.emitUint8(indexScan.keyType);
      const seekEofPatch = emitter.emitUint16(0);

      const loopStartPos = emitter.currentOffset();
      const nextRowPatches: number[] = [];

      emitFilterTree(
        rootFilter,
        table,
        emitter,
        leafRegMap,
        nextRowPatches,
        plan.udfNameMap,
        undefined,
        filterSetMap,
        nextReg,
      );

      let offsetSkipPatch = -1;
      if (hasOffset) {
        emitter.emitUint8(OpCode.OP_OFFSET);
        emitter.emitUint8(regOffset);
        offsetSkipPatch = emitter.emitUint16(0);
      }

      emitSelectedRow();

      let limitHaltPatch = -1;
      if (hasLimit) {
        emitter.emitUint8(OpCode.OP_LIMIT);
        emitter.emitUint8(regLimit);
        limitHaltPatch = emitter.emitUint16(0);
      }

      const nextRowPos = emitter.currentOffset();
      if (offsetSkipPatch !== -1) {
        emitter.patchUint16(offsetSkipPatch, nextRowPos);
      }
      for (const patch of nextRowPatches) {
        emitter.patchUint16(patch, nextRowPos);
      }

      emitter.emitUint8(OpCode.OP_INDEX_NEXT);
      emitter.emitUint8(1);
      emitter.emitUint8(0);
      const nextRowEofPatch = emitter.emitUint16(0);

      emitter.emitUint8(OpCode.OP_JUMP);
      emitter.emitUint16(loopStartPos);

      const eofPos = emitter.currentOffset();
      emitter.patchUint16(seekEofPatch, eofPos);
      emitter.patchUint16(nextRowEofPatch, eofPos);
      if (limitHaltPatch !== -1) {
        emitter.patchUint16(limitHaltPatch, eofPos);
      }

      emitter.emitUint8(OpCode.OP_HALT);
      return finalizeIndexScan();
    }
  }

  // Open Cursor (Fallback Table Scan)
  emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
  emitter.emitUint8(0);
  emitter.emitUint32(table.rootPageId);

  emitter.emitUint8(OpCode.OP_REWIND);
  emitter.emitUint8(0);
  const rewindJumpPatch = emitter.emitUint16(0);

  const loopStartPos = emitter.currentOffset();
  const nextRowPatches: number[] = [];

  emitFilterTree(
    rootFilter,
    table,
    emitter,
    leafRegMap,
    nextRowPatches,
    plan.udfNameMap,
    undefined,
    filterSetMap,
    nextReg,
  );

  let offsetSkipPatch = -1;
  if (hasOffset) {
    emitter.emitUint8(OpCode.OP_OFFSET);
    emitter.emitUint8(regOffset);
    offsetSkipPatch = emitter.emitUint16(0);
  }

  emitSelectedRow();

  let limitHaltPatch = -1;
  if (hasLimit) {
    emitter.emitUint8(OpCode.OP_LIMIT);
    emitter.emitUint8(regLimit);
    limitHaltPatch = emitter.emitUint16(0);
  }

  const nextRowPos = emitter.currentOffset();
  if (offsetSkipPatch !== -1) {
    emitter.patchUint16(offsetSkipPatch, nextRowPos);
  }
  for (const patch of nextRowPatches) {
    emitter.patchUint16(patch, nextRowPos);
  }

  emitter.emitUint8(OpCode.OP_NEXT_ROW);
  emitter.emitUint8(0);
  const nextRowEofPatch = emitter.emitUint16(0);

  emitter.emitUint8(OpCode.OP_JUMP);
  emitter.emitUint16(loopStartPos);

  const eofPos = emitter.currentOffset();
  emitter.patchUint16(rewindJumpPatch, eofPos);
  emitter.patchUint16(nextRowEofPatch, eofPos);
  if (limitHaltPatch !== -1) {
    emitter.patchUint16(limitHaltPatch, eofPos);
  }

  emitter.emitUint8(OpCode.OP_HALT);

  return finalizeBytecode(whereMetrics ? { whereMetrics } : undefined);
}

export interface DisassembledInstruction {
  addr: number;
  opcode: string;
  p1: string;
  p2: string;
  p3: string;
  comment: string;
}

const textDecoder = new TextDecoder();

const DISASM_CURSOR_JUMP_OPS = new Map<number, [string, string]>([
  [OpCode.OP_REWIND, ["OP_REWIND", "Rewind cursor to first row; jump to {a} if empty"]],
  [OpCode.OP_NEXT_ROW, ["OP_NEXT_ROW", "Advance cursor to next row; jump to {a} if EOF"]],
  [OpCode.OP_LAST, ["OP_LAST", "Position cursor to last row; jump to {a} if empty"]],
  [OpCode.OP_PREV_ROW, ["OP_PREV_ROW", "Advance cursor to previous row; jump to {a} if BOF"]],
]);

const DISASM_COLUMN_OPS = new Map<number, [string, string]>([
  [OpCode.OP_COLUMN_INT, ["OP_COLUMN_INT", "INT"]],
  [OpCode.OP_COLUMN_FLOAT, ["OP_COLUMN_FLOAT", "FLOAT"]],
  [OpCode.OP_COLUMN_TEXT, ["OP_COLUMN_TEXT", "TEXT"]],
  [OpCode.OP_COLUMN_BLOB, ["OP_COLUMN_BLOB", "BLOB"]],
  [OpCode.OP_COLUMN_UUID, ["OP_COLUMN_UUID", "UUID"]],
  [OpCode.OP_COLUMN_ULID, ["OP_COLUMN_ULID", "ULID"]],
]);

const DISASM_CMP_OPS = new Map<number, [string, string]>([
  [OpCode.OP_EQ, ["OP_EQ", "=="]],
  [OpCode.OP_NE, ["OP_NE", "!="]],
  [OpCode.OP_GT, ["OP_GT", ">"]],
  [OpCode.OP_GE, ["OP_GE", ">="]],
  [OpCode.OP_LT, ["OP_LT", "<"]],
  [OpCode.OP_LE, ["OP_LE", "<="]],
  [OpCode.OP_STR_LIKE, ["OP_STR_LIKE", "LIKE"]],
  [OpCode.OP_STR_NOT_LIKE, ["OP_STR_NOT_LIKE", "NOT LIKE"]],
  [OpCode.OP_STR_CONTAINS, ["OP_STR_CONTAINS", "CONTAINS"]],
  [OpCode.OP_STR_STARTS_WITH, ["OP_STR_STARTS_WITH", "STARTS_WITH"]],
  [OpCode.OP_STR_ENDS_WITH, ["OP_STR_ENDS_WITH", "ENDS_WITH"]],
  [OpCode.OP_STR_FUZZY_MATCH, ["OP_STR_FUZZY_MATCH", "FUZZY_MATCH"]],
]);

const DISASM_UNARY_REG_OPS = new Map<number, string>([
  [OpCode.OP_STR_LOWER, "OP_STR_LOWER"],
  [OpCode.OP_STR_UPPER, "OP_STR_UPPER"],
  [OpCode.OP_STR_LENGTH, "OP_STR_LENGTH"],
  [OpCode.OP_STR_TRIM, "OP_STR_TRIM"],
  [OpCode.OP_MATH_ABS, "OP_MATH_ABS"],
  [OpCode.OP_MATH_ROUND, "OP_MATH_ROUND"],
  [OpCode.OP_MATH_FLOOR, "OP_MATH_FLOOR"],
  [OpCode.OP_MATH_CEIL, "OP_MATH_CEIL"],
]);

const DISASM_ARITH_OPS = new Map<number, string>([
  [OpCode.OP_ADD, "OP_ADD"],
  [OpCode.OP_SUB, "OP_SUB"],
  [OpCode.OP_MUL, "OP_MUL"],
  [OpCode.OP_DIV, "OP_DIV"],
  [OpCode.OP_MOD, "OP_MOD"],
]);

const DISASM_AGG_FUNCS = ["COUNT", "SUM", "AVG", "MIN", "MAX"];

/**
 * Disassembles binary bytecode into human-readable instructions.
 */
export function disassembleBytecode(
  bytecode: Uint8Array,
  table?: TableMeta,
): DisassembledInstruction[] {
  const instructions: DisassembledInstruction[] = [];
  const view = new DataView(
    bytecode.buffer,
    bytecode.byteOffset,
    bytecode.byteLength,
  );
  let pc = 0;

  const getColName = (idx: number) =>
    table?.columns[idx]?.name ? `'${table.columns[idx].name}'` : `col_${idx}`;
  const fmtAddr = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;
  const u16 = () => {
    const v = view.getUint16(pc, true);
    pc += 2;
    return v;
  };
  const push = (
    addr: number,
    opcode: string,
    p1: string,
    p2: string,
    p3: string,
    comment: string,
  ) => {
    instructions.push({ addr, opcode, p1, p2, p3, comment });
  };

  while (pc < bytecode.byteLength) {
    const addr = pc;
    const op = bytecode[pc++];

    const curJump = DISASM_CURSOR_JUMP_OPS.get(op);
    if (curJump) {
      const c = bytecode[pc++];
      const tgt = fmtAddr(u16());
      push(addr, curJump[0], `c[${c}]`, tgt, "", curJump[1].replace("{a}", tgt));
      continue;
    }

    const colOp = DISASM_COLUMN_OPS.get(op);
    if (colOp) {
      const c = bytecode[pc++];
      const col = bytecode[pc++];
      const r = bytecode[pc++];
      const colLabel = getColName(col);
      push(addr, colOp[0], `c[${c}]`, `${col} (${colLabel})`, `r[${r}]`, `Read ${colLabel} as ${colOp[1]} into r[${r}]`);
      continue;
    }

    const cmpOp = DISASM_CMP_OPS.get(op);
    if (cmpOp) {
      const a = bytecode[pc++];
      const b = bytecode[pc++];
      const tgt = fmtAddr(u16());
      push(addr, cmpOp[0], `r[${a}]`, `r[${b}]`, tgt, `If r[${a}] ${cmpOp[1]} r[${b}] -> jump to ${tgt}`);
      continue;
    }

    const unaryOp = DISASM_UNARY_REG_OPS.get(op);
    if (unaryOp) {
      const src = bytecode[pc++];
      const dst = bytecode[pc++];
      push(addr, unaryOp, `r[${src}]`, `r[${dst}]`, "", `${unaryOp}: r[${dst}] = ${unaryOp.toLowerCase()}(r[${src}])`);
      continue;
    }

    const arithOp = DISASM_ARITH_OPS.get(op);
    if (arithOp) {
      const a = bytecode[pc++];
      const b = bytecode[pc++];
      const dst = bytecode[pc++];
      push(addr, arithOp, `r[${a}]`, `r[${b}]`, `r[${dst}]`, `${arithOp}: r[${dst}] = r[${a}] ${arithOp.replace("OP_", "")} r[${b}]`);
      continue;
    }

    switch (op) {
      case OpCode.OP_HALT:
        push(addr, "OP_HALT", "", "", "", "Halt VM execution (STATUS_DONE)");
        break;

      case OpCode.OP_OPEN_CURSOR:
      case OpCode.OP_OPEN_INDEX: {
        const c = bytecode[pc++];
        const root = view.getUint32(pc, true);
        pc += 4;
        const isIdx = op === OpCode.OP_OPEN_INDEX;
        push(
          addr,
          isIdx ? "OP_OPEN_INDEX" : "OP_OPEN_CURSOR",
          `c[${c}]`,
          `page=${root}`,
          "",
          isIdx
            ? `Open index cursor ${c} on root page ${root}`
            : `Open cursor ${c} on root page ${root}${table ? ` ('${table.name}')` : ""}`,
        );
        break;
      }

      case OpCode.OP_INDEX_SEEK_EQ:
      case OpCode.OP_INDEX_SEEK_GE: {
        const idxC = bytecode[pc++];
        const dataC = bytecode[pc++];
        const regKey = bytecode[pc++];
        const keyType = bytecode[pc++];
        const tgt = fmtAddr(u16());
        const isEq = op === OpCode.OP_INDEX_SEEK_EQ;
        push(
          addr,
          isEq ? "OP_INDEX_SEEK_EQ" : "OP_INDEX_SEEK_GE",
          `idx=c[${idxC}], data=c[${dataC}]`,
          `key=r[${regKey}], type=${keyType}`,
          tgt,
          isEq
            ? `Seek exact key in index; position data cursor or jump to ${tgt} if not found`
            : `Seek first entry >= key in index; position data cursor or jump to ${tgt} if EOF`,
        );
        break;
      }

      case OpCode.OP_INDEX_NEXT: {
        const idxC = bytecode[pc++];
        const dataC = bytecode[pc++];
        const tgt = fmtAddr(u16());
        push(addr, "OP_INDEX_NEXT", `idx=c[${idxC}], data=c[${dataC}]`, tgt, "", `Advance index cursor to next entry; jump to ${tgt} if EOF`);
        break;
      }

      case OpCode.OP_IS_NULL:
      case OpCode.OP_IS_NOT_NULL: {
        const c = bytecode[pc++];
        const col = bytecode[pc++];
        const tgt = fmtAddr(u16());
        const isNull = op === OpCode.OP_IS_NULL;
        const colLabel = getColName(col);
        push(addr, isNull ? "OP_IS_NULL" : "OP_IS_NOT_NULL", `c[${c}]`, `${col} (${colLabel})`, tgt, `If ${colLabel} ${isNull ? "IS NULL" : "IS NOT NULL"} -> jump to ${tgt}`);
        break;
      }

      case OpCode.OP_JUMP: {
        const tgt = fmtAddr(u16());
        push(addr, "OP_JUMP", tgt, "", "", `Unconditional jump to ${tgt}`);
        break;
      }

      case OpCode.OP_IN: {
        const r = bytecode[pc++];
        const setIdx = u16();
        const tgt = fmtAddr(u16());
        push(addr, "OP_IN", `r[${r}]`, `set[${setIdx}]`, tgt, `If r[${r}] IN set[${setIdx}] -> jump to ${tgt}`);
        break;
      }

      case OpCode.OP_LOAD_INT: {
        const r = bytecode[pc++];
        const val = view.getInt32(pc, true);
        pc += 4;
        push(addr, "OP_LOAD_INT", `r[${r}]`, `${val}`, "", `Load literal int ${val} into r[${r}]`);
        break;
      }

      case OpCode.OP_LOAD_INT64: {
        const r = bytecode[pc++];
        const val = view.getBigInt64(pc, true).toString();
        pc += 8;
        push(addr, "OP_LOAD_INT64", `r[${r}]`, `${val}n`, "", `Load literal int64 ${val}n into r[${r}]`);
        break;
      }

      case OpCode.OP_LOAD_FLOAT: {
        const r = bytecode[pc++];
        const val = view.getFloat64(pc, true);
        pc += 8;
        push(addr, "OP_LOAD_FLOAT", `r[${r}]`, `${val}`, "", `Load literal float ${val} into r[${r}]`);
        break;
      }

      case OpCode.OP_LOAD_TEXT: {
        const r = bytecode[pc++];
        const len = u16();
        const str = textDecoder.decode(new Uint8Array(bytecode.buffer, bytecode.byteOffset + pc, len));
        pc += len;
        push(addr, "OP_LOAD_TEXT", `r[${r}]`, `"${str}"`, "", `Load literal text "${str}" into r[${r}]`);
        break;
      }

      case OpCode.OP_LOAD_BLOB: {
        const r = bytecode[pc++];
        const len = u16();
        pc += len;
        push(addr, "OP_LOAD_BLOB", `r[${r}]`, `len=${len}`, "", `Load literal BLOB (${len} bytes) into r[${r}]`);
        break;
      }

      case OpCode.OP_LOAD_NULL: {
        const r = bytecode[pc++];
        push(addr, "OP_LOAD_NULL", `r[${r}]`, "NULL", "", `Set r[${r}] to NULL`);
        break;
      }

      case OpCode.OP_EMIT_ROW: {
        const c = bytecode[pc++];
        push(addr, "OP_EMIT_ROW", `c[${c}]`, "", "", "Row passed all filters -> emit to Output Result Buffer");
        break;
      }

      case OpCode.OP_RESULT_ROW: {
        const start = bytecode[pc++];
        const cols = bytecode[pc++];
        push(addr, "OP_RESULT_ROW", `r[${start}]`, `cols=${cols}`, "", `Serialize registers r[${start}..${start + cols - 1}] to Result Buffer`);
        break;
      }

      case OpCode.OP_OFFSET:
      case OpCode.OP_LIMIT: {
        const r = bytecode[pc++];
        const tgt = fmtAddr(u16());
        const isOff = op === OpCode.OP_OFFSET;
        push(
          addr,
          isOff ? "OP_OFFSET" : "OP_LIMIT",
          `r[${r}]`,
          tgt,
          "",
          isOff
            ? `If r[${r}] > 0 -> decrement and skip row to ${tgt}`
            : `If r[${r}] <= 1 -> halt to ${tgt}, else decrement`,
        );
        break;
      }

      case OpCode.OP_CALL_UDF: {
        const udfId = u16();
        const start = bytecode[pc++];
        const nArgs = bytecode[pc++];
        const dst = bytecode[pc++];
        push(addr, "OP_CALL_UDF", `udf#${udfId}`, `r[${start}..${start + nArgs - 1}]`, `r[${dst}]`, `Call UDF #${udfId} with ${nArgs} args -> r[${dst}]`);
        break;
      }

      case OpCode.OP_STR_SUBSTR: {
        const src = bytecode[pc++];
        const start = bytecode[pc++];
        const len = bytecode[pc++];
        const dst = bytecode[pc++];
        push(addr, "OP_STR_SUBSTR", `r[${src}]`, `start=r[${start}], len=r[${len}]`, `r[${dst}]`, `Extract substring from r[${src}] into r[${dst}]`);
        break;
      }

      case OpCode.OP_STR_LEVENSHTEIN: {
        const a = bytecode[pc++];
        const b = bytecode[pc++];
        const dst = bytecode[pc++];
        push(addr, "OP_STR_LEVENSHTEIN", `r[${a}]`, `r[${b}]`, `r[${dst}]`, `r[${dst}] = levenshtein(r[${a}], r[${b}])`);
        break;
      }

      case OpCode.OP_STR_CONCAT:
      case OpCode.OP_COALESCE: {
        const name = op === OpCode.OP_STR_CONCAT ? "OP_STR_CONCAT" : "OP_COALESCE";
        const start = bytecode[pc++];
        const n = bytecode[pc++];
        const dst = bytecode[pc++];
        push(addr, name, `r[${start}..${start + n - 1}]`, `count=${n}`, `r[${dst}]`, `${name}: r[${dst}]`);
        break;
      }

      case OpCode.OP_COPY: {
        const src = bytecode[pc++];
        const dst = bytecode[pc++];
        push(addr, "OP_COPY", `r[${src}]`, `r[${dst}]`, "", `Copy r[${src}] to r[${dst}]`);
        break;
      }

      case OpCode.OP_SORTER_OPEN: {
        const id = bytecode[pc++];
        const ki = bytecode[pc++];
        push(addr, "OP_SORTER_OPEN", `s[${id}]`, `keyInfo=${ki}`, "", `Open sorter ${id} with keyInfo ${ki}`);
        break;
      }

      case OpCode.OP_SORTER_INSERT: {
        const id = bytecode[pc++];
        const start = bytecode[pc++];
        const nKeys = bytecode[pc++];
        const c = bytecode[pc++];
        push(addr, "OP_SORTER_INSERT", `s[${id}]`, `r[${start}..+${nKeys}]`, `c[${c}]`, `Insert row from cursor ${c} into sorter ${id}`);
        break;
      }

      case OpCode.OP_SORTER_SORT: {
        const id = bytecode[pc++];
        push(addr, "OP_SORTER_SORT", `s[${id}]`, "", "", `Sort entries in sorter ${id}`);
        break;
      }

      case OpCode.OP_SORTER_NEXT: {
        const id = bytecode[pc++];
        const tgt = fmtAddr(u16());
        push(addr, "OP_SORTER_NEXT", `s[${id}]`, tgt, "", `Emit next sorted row from sorter ${id}; jump to ${tgt} while more rows`);
        break;
      }

      case OpCode.OP_AGG_INIT: {
        const id = bytecode[pc++];
        const start = bytecode[pc++];
        const nKeys = bytecode[pc++];
        const mode = bytecode[pc++];
        push(addr, "OP_AGG_INIT", `agg[${id}]`, `keys=r[${start}..+${nKeys}]`, `mode=${mode === 0 ? "hash" : "stream"}`, `Initialize aggregator ${id} (${mode === 0 ? "hash table" : "stream"})`);
        break;
      }

      case OpCode.OP_AGG_STEP: {
        const id = bytecode[pc++];
        const start = bytecode[pc++];
        const nKeys = bytecode[pc++];
        const valReg = bytecode[pc++];
        const raw = bytecode[pc++];
        const fn = DISASM_AGG_FUNCS[raw & 0x07] ?? `${raw & 0x07}`;
        push(addr, "OP_AGG_STEP", `agg[${id}]`, `val=${valReg === 255 ? "*" : `r[${valReg}]`}`, fn, `Update accumulator ${fn} (slot ${raw >> 3}) for group r[${start}..+${nKeys}]`);
        break;
      }

      case OpCode.OP_AGG_NEXT: {
        const id = bytecode[pc++];
        const outKey = bytecode[pc++];
        const outAcc = bytecode[pc++];
        const tgt = fmtAddr(u16());
        push(addr, "OP_AGG_NEXT", `agg[${id}]`, `out_keys=r[${outKey}], out_acc=r[${outAcc}]`, tgt, `Iterate next group bucket; jump to ${tgt}`);
        break;
      }

      case OpCode.OP_AGG_FINAL: {
        const sumReg = bytecode[pc++];
        const cntReg = bytecode[pc++];
        const outReg = bytecode[pc++];
        const raw = bytecode[pc++];
        const fn = DISASM_AGG_FUNCS[raw & 0x07] ?? `${raw & 0x07}`;
        push(addr, "OP_AGG_FINAL", `sum=r[${sumReg}], cnt=r[${cntReg}]`, `r[${outReg}]`, fn, `Finalize ${fn} (slot ${raw >> 3}) into r[${outReg}]`);
        break;
      }

      case OpCode.OP_REG_IS_NULL:
      case OpCode.OP_REG_IS_NOT_NULL: {
        const r = bytecode[pc++];
        const tgt = fmtAddr(u16());
        const isNull = op === OpCode.OP_REG_IS_NULL;
        push(addr, isNull ? "OP_REG_IS_NULL" : "OP_REG_IS_NOT_NULL", `r[${r}]`, tgt, "", `Jump to ${tgt} if r[${r}] is ${isNull ? "NULL" : "NOT NULL"}`);
        break;
      }

      default:
        push(addr, `OP_UNKNOWN(0x${op.toString(16)})`, "", "", "", "Unknown opcode");
        break;
    }
  }

  return instructions;
}

/**
 * Formats a list of disassembled instructions into an ASCII table string.
 */
export function formatDisassembly(
  instructions: DisassembledInstruction[],
): string {
  const pad = (s: string, n: number) => s.padEnd(n, " ");
  const fmtAddr = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;

  let out = `${pad("ADDR", 8)} ${pad("OPCODE", 18)} ${pad("P1", 12)} ${pad("P2", 20)} ${pad("P3", 10)} COMMENT\n`;
  out += "-".repeat(95) + "\n";

  for (const ins of instructions) {
    out += `${pad(fmtAddr(ins.addr), 8)} ${pad(ins.opcode, 18)} ${pad(ins.p1, 12)} ${pad(ins.p2, 20)} ${pad(ins.p3, 10)} ${ins.comment}\n`;
  }

  return out;
}
