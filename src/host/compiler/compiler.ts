import {
  OpCode,
  DataType,
  TableMeta,
  ColumnMeta,
  ColumnFlag,
  TooManyRegistersError,
  TooManyOrderByColumnsError,
  TooManyGroupByColumnsError,
  TooManyCursorsError,
  UnknownFunctionError,
} from "../../types/index.js";
import { VmKeyInfo } from "../../shared/vm_context.js";
import {
  ExprNode,
  ParsedSelectExpr,
  parseExpression,
  deriveDefaultAlias,
} from "./expr_parser.js";

export type ComparisonOp =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "LIKE"
  | "NOT LIKE"
  | "CONTAINS"
  | "STARTS_WITH"
  | "ENDS_WITH"
  | "like"
  | "not like"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "startswith"
  | "endswith";

export function getCmpOpcode(op: string | undefined): OpCode {
  if (!op) return OpCode.OP_EQ;
  const norm = String(op).trim().toUpperCase().replace(/\s+/g, " ");
  if (norm === "=" || norm === "==") return OpCode.OP_EQ;
  if (norm === "!=" || norm === "<>") return OpCode.OP_NE;
  if (norm === ">") return OpCode.OP_GT;
  if (norm === ">=") return OpCode.OP_GE;
  if (norm === "<") return OpCode.OP_LT;
  if (norm === "<=") return OpCode.OP_LE;
  if (norm === "LIKE") return OpCode.OP_STR_LIKE;
  if (norm === "NOT LIKE") return OpCode.OP_STR_NOT_LIKE;
  if (norm === "CONTAINS") return OpCode.OP_STR_CONTAINS;
  if (norm === "STARTS_WITH" || norm === "STARTSWITH") return OpCode.OP_STR_STARTS_WITH;
  if (norm === "ENDS_WITH" || norm === "ENDSWITH") return OpCode.OP_STR_ENDS_WITH;
  return OpCode.OP_EQ;
}

export type QueryFilterType = "null" | "cmp" | "expr" | "and" | "or" | "not";

export interface QueryFilter {
  type: QueryFilterType;
  colName?: string;
  isNull?: boolean; // true for isNull, false for isNotNull
  op?: ComparisonOp;
  value?: any;
  expr?: ExprNode;
  children?: QueryFilter[]; // for 'and', 'or'
  child?: QueryFilter;      // for 'not'
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
}

export type JoinType = 'inner' | 'left';

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
}

export class BytecodeEmitter {
  private buffer: number[] = [];
  private textEncoder = new TextEncoder();

  emitUint8(val: number): number {
    const pos = this.buffer.length;
    this.buffer.push(val & 0xff);
    return pos;
  }

  emitUint16(val: number): number {
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

  emitFloat64(val: number): number {
    const pos = this.buffer.length;
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, val, true);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < 8; i++) {
      this.buffer.push(u8[i]);
    }
    return pos;
  }

  emitString(str: string): number {
    const bytes = this.textEncoder.encode(str);
    const pos = this.emitUint16(bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i++) {
      this.buffer.push(bytes[i]);
    }
    return pos;
  }

  patchUint16(pos: number, val: number): void {
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

export function normalizeFilter(filter: QueryFilter): QueryFilter {
  if (filter.type === "and") {
    return {
      type: "and",
      children: filter.children ? filter.children.map(normalizeFilter) : [],
    };
  }

  if (filter.type === "or") {
    return {
      type: "or",
      children: filter.children ? filter.children.map(normalizeFilter) : [],
    };
  }

  if (filter.type === "not") {
    const child = filter.child;
    if (!child) return filter;

    // Double negation: NOT (NOT x) => x
    if (child.type === "not" && child.child) {
      return normalizeFilter(child.child);
    }

    // De Morgan: NOT (A AND B) => (NOT A) OR (NOT B)
    if (child.type === "and") {
      return {
        type: "or",
        children: child.children
          ? child.children.map((c) => normalizeFilter({ type: "not", child: c }))
          : [],
      };
    }

    // De Morgan: NOT (A OR B) => (NOT A) AND (NOT B)
    if (child.type === "or") {
      return {
        type: "and",
        children: child.children
          ? child.children.map((c) => normalizeFilter({ type: "not", child: c }))
          : [],
      };
    }

    // NOT (col IS NULL) => col IS NOT NULL
    // NOT (col IS NOT NULL) => col IS NULL
    if (child.type === "null") {
      return {
        type: "null",
        colName: child.colName,
        isNull: !child.isNull,
      };
    }

    // NOT (cmp)
    if (child.type === "cmp") {
      const inverseOps: Record<string, ComparisonOp> = {
        "=": "!=",
        "!=": "=",
        ">": "<=",
        ">=": "<",
        "<": ">=",
        "<=": ">",
        LIKE: "NOT LIKE",
        "NOT LIKE": "LIKE",
      };

      if (child.op && inverseOps[child.op]) {
        return {
          type: "cmp",
          colName: child.colName,
          op: inverseOps[child.op],
          value: child.value,
        };
      }

      // For CONTAINS, STARTS_WITH, ENDS_WITH:
      // In 3VL: NOT(col CONTAINS val) requires col IS NOT NULL AND NOT(col CONTAINS val)
      return {
        type: "and",
        children: [
          { type: "null", colName: child.colName, isNull: false },
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
    if (f.type === "null" || f.type === "cmp" || f.type === "expr") {
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
  if (colName.includes('.')) {
    const parts = colName.split('.');
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

function emitLeafJumpOnTrue(
  filter: QueryFilter,
  leafIdx: number,
  table: TableMeta,
  emitter: BytecodeEmitter,
  truePatches: number[],
  udfNameMap?: Map<string, number>,
  tables?: TableMeta[],
): void {
  const all = tables ?? [table];
  if (filter.type === "expr") {
    const regRes = leafIdx * 2;
    const regOne = leafIdx * 2 + 1;
    let tempReg = 50;
    const allocReg = () => {
      if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
      return tempReg++;
    };
    emitExpression(filter.expr!, table, emitter, 0, regRes, allocReg, udfNameMap, undefined, all);
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(regOne);
    emitter.emitInt32(1);

    emitter.emitUint8(OpCode.OP_EQ);
    emitter.emitUint8(regRes);
    emitter.emitUint8(regOne);
    truePatches.push(emitter.emitUint16(0));
    return;
  }

  if (filter.type === "null") {
    if (!filter.colName) {
      throw new Error(`Filter leaf node missing colName`);
    }
    const resolved = resolveColumnAcrossTables(filter.colName, all);
    if (!resolved) {
      throw new Error(
        `Column "${filter.colName}" not found in tables`,
      );
    }
    if (filter.isNull) {
      emitter.emitUint8(OpCode.OP_IS_NULL);
    } else {
      emitter.emitUint8(OpCode.OP_IS_NOT_NULL);
    }
    emitter.emitUint8(resolved.cursor);
    emitter.emitUint8(resolved.colIdx);
    truePatches.push(emitter.emitUint16(0));
    return;
  }

  const regCol = leafIdx * 2;
  const regConst = leafIdx * 2 + 1;

  if (filter.expr) {
    let tempReg = 50;
    const allocReg = () => {
      if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
      return tempReg++;
    };
    emitExpression(filter.expr, table, emitter, 0, regCol, allocReg, udfNameMap, undefined, all);
  } else {
    if (!filter.colName) {
      throw new Error(`Filter leaf node missing colName`);
    }
    const resolved = resolveColumnAcrossTables(filter.colName, all);
    if (resolved) {
      emitReadColumn(emitter, resolved.cursor, resolved.colIdx, regCol, resolved.col.type);
    } else {
      try {
        const parsed = parseExpression(filter.colName);
        let tempReg = 50;
        const allocReg = () => {
          if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
          return tempReg++;
        };
        emitExpression(parsed, table, emitter, 0, regCol, allocReg, udfNameMap, undefined, all);
      } catch {
        throw new Error(
          `Column "${filter.colName}" not found in tables`,
        );
      }
    }
  }

  const cmpOpcode = getCmpOpcode(filter.op);

  emitter.emitUint8(cmpOpcode);
  emitter.emitUint8(regCol);
  emitter.emitUint8(regConst);
  truePatches.push(emitter.emitUint16(0));
}

function emitLeafJumpOnFalse(
  filter: QueryFilter,
  leafIdx: number,
  table: TableMeta,
  emitter: BytecodeEmitter,
  falsePatches: number[],
  udfNameMap?: Map<string, number>,
  tables?: TableMeta[],
): void {
  const all = tables ?? [table];
  if (filter.type === "expr") {
    const regRes = leafIdx * 2;
    const regOne = leafIdx * 2 + 1;
    let tempReg = 50;
    const allocReg = () => {
      if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
      return tempReg++;
    };
    emitExpression(filter.expr!, table, emitter, 0, regRes, allocReg, udfNameMap, undefined, all);
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(regOne);
    emitter.emitInt32(1);

    emitter.emitUint8(OpCode.OP_EQ);
    emitter.emitUint8(regRes);
    emitter.emitUint8(regOne);
    const passPatch = emitter.emitUint16(0);

    emitter.emitUint8(OpCode.OP_JUMP);
    falsePatches.push(emitter.emitUint16(0));

    emitter.patchUint16(passPatch, emitter.currentOffset());
    return;
  }

  if (filter.type === "null") {
    if (!filter.colName) {
      throw new Error(`Filter leaf node missing colName`);
    }
    const resolved = resolveColumnAcrossTables(filter.colName, all);
    if (!resolved) {
      throw new Error(
        `Column "${filter.colName}" not found in tables`,
      );
    }
    if (filter.isNull) {
      emitter.emitUint8(OpCode.OP_IS_NOT_NULL);
    } else {
      emitter.emitUint8(OpCode.OP_IS_NULL);
    }
    emitter.emitUint8(resolved.cursor);
    emitter.emitUint8(resolved.colIdx);
    falsePatches.push(emitter.emitUint16(0));
    return;
  }

  const regCol = leafIdx * 2;
  const regConst = leafIdx * 2 + 1;

  if (filter.expr) {
    let tempReg = 50;
    const allocReg = () => {
      if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
      return tempReg++;
    };
    emitExpression(filter.expr, table, emitter, 0, regCol, allocReg, udfNameMap, undefined, all);
  } else {
    if (!filter.colName) {
      throw new Error(`Filter leaf node missing colName`);
    }
    const resolved = resolveColumnAcrossTables(filter.colName, all);
    if (resolved) {
      emitReadColumn(emitter, resolved.cursor, resolved.colIdx, regCol, resolved.col.type);
    } else {
      try {
        const parsed = parseExpression(filter.colName);
        let tempReg = 50;
        const allocReg = () => {
          if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
          return tempReg++;
        };
        emitExpression(parsed, table, emitter, 0, regCol, allocReg, udfNameMap, undefined, all);
      } catch {
        throw new Error(
          `Column "${filter.colName}" not found in tables`,
        );
      }
    }
  }

  const cmpOpcode = getCmpOpcode(filter.op);

  emitter.emitUint8(cmpOpcode);
  emitter.emitUint8(regCol);
  emitter.emitUint8(regConst);
  const passPatch = emitter.emitUint16(0);

  emitter.emitUint8(OpCode.OP_JUMP);
  falsePatches.push(emitter.emitUint16(0));

  emitter.patchUint16(passPatch, emitter.currentOffset());
}

function emitLeafCondition(
  filter: QueryFilter,
  leafIdx: number,
  table: TableMeta,
  emitter: BytecodeEmitter,
  truePatches: number[],
  falsePatches: number[],
  fallthrough: "true" | "false" | "none",
  udfNameMap?: Map<string, number>,
  tables?: TableMeta[],
): void {
  if (fallthrough === "true") {
    emitLeafJumpOnFalse(filter, leafIdx, table, emitter, falsePatches, udfNameMap, tables);
  } else if (fallthrough === "false") {
    emitLeafJumpOnTrue(filter, leafIdx, table, emitter, truePatches, udfNameMap, tables);
  } else {
    emitLeafJumpOnTrue(filter, leafIdx, table, emitter, truePatches, udfNameMap, tables);
    emitter.emitUint8(OpCode.OP_JUMP);
    falsePatches.push(emitter.emitUint16(0));
  }
}

function compileFilterNode(
  node: QueryFilter,
  emitter: BytecodeEmitter,
  table: TableMeta,
  leafRegMap: Map<QueryFilter, number>,
  truePatches: number[],
  falsePatches: number[],
  fallthrough: "true" | "false" | "none",
  udfNameMap?: Map<string, number>,
  tables?: TableMeta[],
): void {
  if (node.type === "cmp" || node.type === "null" || node.type === "expr") {
    const leafIdx = leafRegMap.get(node) ?? 0;
    emitLeafCondition(
      node,
      leafIdx,
      table,
      emitter,
      truePatches,
      falsePatches,
      fallthrough,
      udfNameMap,
      tables,
    );
    return;
  }

  if (node.type === "not") {
    if (!node.child) {
      return;
    }
    const leaf = node.child;
    const leafIdx = leafRegMap.get(leaf) ?? 0;
    if (fallthrough === "true") {
      emitLeafJumpOnTrue(leaf, leafIdx, table, emitter, falsePatches, udfNameMap, tables);
    } else if (fallthrough === "false") {
      emitLeafJumpOnFalse(leaf, leafIdx, table, emitter, truePatches, udfNameMap, tables);
    } else {
      emitLeafJumpOnFalse(leaf, leafIdx, table, emitter, truePatches, udfNameMap, tables);
      emitter.emitUint8(OpCode.OP_JUMP);
      falsePatches.push(emitter.emitUint16(0));
    }
    return;
  }

  if (node.type === "and") {
    const children = node.children ?? [];
    if (children.length === 0) {
      if (fallthrough === "false") {
        emitter.emitUint8(OpCode.OP_JUMP);
        truePatches.push(emitter.emitUint16(0));
      }
      return;
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      if (!isLast) {
        const subTruePatches: number[] = [];
        compileFilterNode(
          child,
          emitter,
          table,
          leafRegMap,
          subTruePatches,
          falsePatches,
          "true",
          udfNameMap,
          tables,
        );
        const nextChildPos = emitter.currentOffset();
        for (const patch of subTruePatches) {
          emitter.patchUint16(patch, nextChildPos);
        }
      } else {
        compileFilterNode(
          child,
          emitter,
          table,
          leafRegMap,
          truePatches,
          falsePatches,
          fallthrough,
          udfNameMap,
          tables,
        );
      }
    }
    return;
  }

  if (node.type === "or") {
    const children = node.children ?? [];
    if (children.length === 0) {
      if (fallthrough === "true") {
        emitter.emitUint8(OpCode.OP_JUMP);
        falsePatches.push(emitter.emitUint16(0));
      }
      return;
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      if (!isLast) {
        const subFalsePatches: number[] = [];
        compileFilterNode(
          child,
          emitter,
          table,
          leafRegMap,
          truePatches,
          subFalsePatches,
          "false",
          udfNameMap,
          tables,
        );
        const nextChildPos = emitter.currentOffset();
        for (const patch of subFalsePatches) {
          emitter.patchUint16(patch, nextChildPos);
        }
      } else {
        compileFilterNode(
          child,
          emitter,
          table,
          leafRegMap,
          truePatches,
          falsePatches,
          fallthrough,
          udfNameMap,
          tables,
        );
      }
    }
    return;
  }
}

function emitHavingLeafJumpOnFalse(
  filter: QueryFilter,
  table: TableMeta,
  emitter: BytecodeEmitter,
  resolveReg: (name?: string, expr?: ExprNode) => number | undefined,
  allocReg: () => number,
  falsePatches: number[],
  udfNameMap?: Map<string, number>,
): void {
  if (filter.type === "cmp") {
    let regLhs: number;
    const resolved = resolveReg(filter.colName, filter.expr);
    if (resolved !== undefined) {
      regLhs = resolved;
    } else if (filter.expr) {
      regLhs = allocReg();
      emitExpression(filter.expr, table, emitter, -1, regLhs, allocReg, udfNameMap, resolveReg);
    } else if (filter.colName) {
      regLhs = allocReg();
      const parsed = parseExpression(filter.colName);
      emitExpression(parsed, table, emitter, -1, regLhs, allocReg, udfNameMap, resolveReg);
    } else {
      regLhs = allocReg();
      emitter.emitUint8(OpCode.OP_LOAD_NULL);
      emitter.emitUint8(regLhs);
    }

    const regConst = allocReg();
    const val = filter.value;
    if (val === null || val === undefined) {
      emitter.emitUint8(OpCode.OP_LOAD_NULL);
      emitter.emitUint8(regConst);
    } else if (typeof val === "number") {
      if (Number.isInteger(val)) {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regConst);
        emitter.emitInt32(val);
      } else {
        emitter.emitUint8(OpCode.OP_LOAD_FLOAT);
        emitter.emitUint8(regConst);
        emitter.emitFloat64(val);
      }
    } else if (typeof val === "string") {
      emitter.emitUint8(OpCode.OP_LOAD_TEXT);
      emitter.emitUint8(regConst);
      emitter.emitString(val);
    } else if (typeof val === "boolean") {
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(regConst);
      emitter.emitInt32(val ? 1 : 0);
    } else if (typeof val === "bigint") {
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(regConst);
      emitter.emitInt32(Number(val));
    }

    const cmpOpcode = getCmpOpcode(filter.op);

    emitter.emitUint8(cmpOpcode);
    emitter.emitUint8(regLhs);
    emitter.emitUint8(regConst);
    const passPatch = emitter.emitUint16(0);

    emitter.emitUint8(OpCode.OP_JUMP);
    falsePatches.push(emitter.emitUint16(0));

    emitter.patchUint16(passPatch, emitter.currentOffset());
    return;
  }

  if (filter.type === "null") {
    let regLhs: number;
    const resolved = resolveReg(filter.colName, filter.expr);
    if (resolved !== undefined) {
      regLhs = resolved;
    } else if (filter.expr) {
      regLhs = allocReg();
      emitExpression(filter.expr, table, emitter, -1, regLhs, allocReg, udfNameMap, resolveReg);
    } else if (filter.colName) {
      regLhs = allocReg();
      const parsed = parseExpression(filter.colName);
      emitExpression(parsed, table, emitter, -1, regLhs, allocReg, udfNameMap, resolveReg);
    } else {
      regLhs = allocReg();
      emitter.emitUint8(OpCode.OP_LOAD_NULL);
      emitter.emitUint8(regLhs);
    }

    if (filter.isNull) {
      emitter.emitUint8(OpCode.OP_REG_IS_NOT_NULL);
      emitter.emitUint8(regLhs);
      falsePatches.push(emitter.emitUint16(0));
    } else {
      emitter.emitUint8(OpCode.OP_REG_IS_NULL);
      emitter.emitUint8(regLhs);
      falsePatches.push(emitter.emitUint16(0));
    }
    return;
  }

  if (filter.type === "expr" && filter.expr) {
    const regRes = allocReg();
    emitExpression(filter.expr, table, emitter, -1, regRes, allocReg, udfNameMap, resolveReg);

    const regOne = allocReg();
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(regOne);
    emitter.emitInt32(1);

    emitter.emitUint8(OpCode.OP_EQ);
    emitter.emitUint8(regRes);
    emitter.emitUint8(regOne);
    const passPatch = emitter.emitUint16(0);

    emitter.emitUint8(OpCode.OP_JUMP);
    falsePatches.push(emitter.emitUint16(0));

    emitter.patchUint16(passPatch, emitter.currentOffset());
    return;
  }
}

function emitHavingLeafJumpOnTrue(
  filter: QueryFilter,
  table: TableMeta,
  emitter: BytecodeEmitter,
  resolveReg: (name?: string, expr?: ExprNode) => number | undefined,
  allocReg: () => number,
  truePatches: number[],
  udfNameMap?: Map<string, number>,
): void {
  if (filter.type === "cmp") {
    let regLhs: number;
    const resolved = resolveReg(filter.colName, filter.expr);
    if (resolved !== undefined) {
      regLhs = resolved;
    } else if (filter.expr) {
      regLhs = allocReg();
      emitExpression(filter.expr, table, emitter, -1, regLhs, allocReg, udfNameMap, resolveReg);
    } else if (filter.colName) {
      regLhs = allocReg();
      const parsed = parseExpression(filter.colName);
      emitExpression(parsed, table, emitter, -1, regLhs, allocReg, udfNameMap, resolveReg);
    } else {
      regLhs = allocReg();
      emitter.emitUint8(OpCode.OP_LOAD_NULL);
      emitter.emitUint8(regLhs);
    }

    const regConst = allocReg();
    const val = filter.value;
    if (val === null || val === undefined) {
      emitter.emitUint8(OpCode.OP_LOAD_NULL);
      emitter.emitUint8(regConst);
    } else if (typeof val === "number") {
      if (Number.isInteger(val)) {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regConst);
        emitter.emitInt32(val);
      } else {
        emitter.emitUint8(OpCode.OP_LOAD_FLOAT);
        emitter.emitUint8(regConst);
        emitter.emitFloat64(val);
      }
    } else if (typeof val === "string") {
      emitter.emitUint8(OpCode.OP_LOAD_TEXT);
      emitter.emitUint8(regConst);
      emitter.emitString(val);
    } else if (typeof val === "boolean") {
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(regConst);
      emitter.emitInt32(val ? 1 : 0);
    } else if (typeof val === "bigint") {
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(regConst);
      emitter.emitInt32(Number(val));
    }

    const cmpOpcode = getCmpOpcode(filter.op);

    emitter.emitUint8(cmpOpcode);
    emitter.emitUint8(regLhs);
    emitter.emitUint8(regConst);
    truePatches.push(emitter.emitUint16(0));
    return;
  }

  if (filter.type === "null") {
    let regLhs: number;
    const resolved = resolveReg(filter.colName, filter.expr);
    if (resolved !== undefined) {
      regLhs = resolved;
    } else if (filter.expr) {
      regLhs = allocReg();
      emitExpression(filter.expr, table, emitter, -1, regLhs, allocReg, udfNameMap, resolveReg);
    } else if (filter.colName) {
      regLhs = allocReg();
      const parsed = parseExpression(filter.colName);
      emitExpression(parsed, table, emitter, -1, regLhs, allocReg, udfNameMap, resolveReg);
    } else {
      regLhs = allocReg();
      emitter.emitUint8(OpCode.OP_LOAD_NULL);
      emitter.emitUint8(regLhs);
    }

    if (filter.isNull) {
      emitter.emitUint8(OpCode.OP_REG_IS_NULL);
      emitter.emitUint8(regLhs);
      truePatches.push(emitter.emitUint16(0));
    } else {
      emitter.emitUint8(OpCode.OP_REG_IS_NOT_NULL);
      emitter.emitUint8(regLhs);
      truePatches.push(emitter.emitUint16(0));
    }
    return;
  }

  if (filter.type === "expr" && filter.expr) {
    const regRes = allocReg();
    emitExpression(filter.expr, table, emitter, -1, regRes, allocReg, udfNameMap, resolveReg);

    const regOne = allocReg();
    emitter.emitUint8(OpCode.OP_LOAD_INT);
    emitter.emitUint8(regOne);
    emitter.emitInt32(1);

    emitter.emitUint8(OpCode.OP_EQ);
    emitter.emitUint8(regRes);
    emitter.emitUint8(regOne);
    truePatches.push(emitter.emitUint16(0));
    return;
  }
}

function emitHavingLeafCondition(
  filter: QueryFilter,
  table: TableMeta,
  emitter: BytecodeEmitter,
  resolveReg: (name?: string, expr?: ExprNode) => number | undefined,
  allocReg: () => number,
  truePatches: number[],
  falsePatches: number[],
  fallthrough: "true" | "false" | "none",
  udfNameMap?: Map<string, number>,
): void {
  if (fallthrough === "true") {
    emitHavingLeafJumpOnFalse(filter, table, emitter, resolveReg, allocReg, falsePatches, udfNameMap);
  } else if (fallthrough === "false") {
    emitHavingLeafJumpOnTrue(filter, table, emitter, resolveReg, allocReg, truePatches, udfNameMap);
  } else {
    emitHavingLeafJumpOnTrue(filter, table, emitter, resolveReg, allocReg, truePatches, udfNameMap);
    emitter.emitUint8(OpCode.OP_JUMP);
    falsePatches.push(emitter.emitUint16(0));
  }
}

function compileHavingFilterNode(
  node: QueryFilter,
  emitter: BytecodeEmitter,
  table: TableMeta,
  resolveReg: (name?: string, expr?: ExprNode) => number | undefined,
  allocReg: () => number,
  truePatches: number[],
  falsePatches: number[],
  fallthrough: "true" | "false" | "none",
  udfNameMap?: Map<string, number>,
): void {
  if (node.type === "cmp" || node.type === "null" || node.type === "expr") {
    emitHavingLeafCondition(
      node,
      table,
      emitter,
      resolveReg,
      allocReg,
      truePatches,
      falsePatches,
      fallthrough,
      udfNameMap,
    );
    return;
  }

  if (node.type === "not") {
    if (!node.child) return;
    const leaf = node.child;
    if (fallthrough === "true") {
      compileHavingFilterNode(leaf, emitter, table, resolveReg, allocReg, falsePatches, truePatches, "false", udfNameMap);
    } else if (fallthrough === "false") {
      compileHavingFilterNode(leaf, emitter, table, resolveReg, allocReg, truePatches, falsePatches, "true", udfNameMap);
    } else {
      compileHavingFilterNode(leaf, emitter, table, resolveReg, allocReg, falsePatches, truePatches, "none", udfNameMap);
    }
    return;
  }

  if (node.type === "and") {
    const children = node.children ?? [];
    if (children.length === 0) {
      if (fallthrough === "false") {
        emitter.emitUint8(OpCode.OP_JUMP);
        truePatches.push(emitter.emitUint16(0));
      }
      return;
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      if (!isLast) {
        const subTruePatches: number[] = [];
        compileHavingFilterNode(
          child,
          emitter,
          table,
          resolveReg,
          allocReg,
          subTruePatches,
          falsePatches,
          "true",
          udfNameMap,
        );
        const nextChildPos = emitter.currentOffset();
        for (const patch of subTruePatches) {
          emitter.patchUint16(patch, nextChildPos);
        }
      } else {
        compileHavingFilterNode(
          child,
          emitter,
          table,
          resolveReg,
          allocReg,
          truePatches,
          falsePatches,
          fallthrough,
          udfNameMap,
        );
      }
    }
    return;
  }

  if (node.type === "or") {
    const children = node.children ?? [];
    if (children.length === 0) {
      if (fallthrough === "true") {
        emitter.emitUint8(OpCode.OP_JUMP);
        falsePatches.push(emitter.emitUint16(0));
      }
      return;
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      if (!isLast) {
        const subFalsePatches: number[] = [];
        compileHavingFilterNode(
          child,
          emitter,
          table,
          resolveReg,
          allocReg,
          truePatches,
          subFalsePatches,
          "false",
          udfNameMap,
        );
        const nextChildPos = emitter.currentOffset();
        for (const patch of subFalsePatches) {
          emitter.patchUint16(patch, nextChildPos);
        }
      } else {
        compileHavingFilterNode(
          child,
          emitter,
          table,
          resolveReg,
          allocReg,
          truePatches,
          falsePatches,
          fallthrough,
          udfNameMap,
        );
      }
    }
    return;
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
  compileHavingFilterNode(
    root,
    emitter,
    table,
    resolveReg,
    allocReg,
    truePatches,
    failPatches,
    "true",
    udfNameMap,
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
): void {
  if (!root) return;
  const truePatches: number[] = [];
  compileFilterNode(
    root,
    emitter,
    table,
    leafRegMap,
    truePatches,
    nextRowPatches,
    "true",
    udfNameMap,
    tables,
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
  if (expr.type === 'literal') {
    if (typeof expr.value === 'number') {
      return Number.isInteger(expr.value) ? DataType.INT32 : DataType.FLOAT64;
    }
    if (typeof expr.value === 'string') return DataType.TEXT;
    return DataType.TEXT;
  }
  if (expr.type === 'col') {
    const all = tables ?? [table];
    const resolved = resolveColumnAcrossTables(expr.name, all);
    return resolved ? resolved.col.type : DataType.TEXT;
  }
  if (expr.type === 'binary') {
    return DataType.FLOAT64;
  }
  if (expr.type === 'fn') {
    const fn = expr.name.toLowerCase();
    if (udfDefs && udfDefs.has(fn)) {
      const def = udfDefs.get(fn)!;
      if (def.returnType !== undefined) {
        return def.returnType;
      }
    }
    if (['upper', 'lower', 'substr', 'trim', 'concat'].includes(fn)) return DataType.TEXT;
    if (['length', 'count', 'starts_with', 'startswith', 'ends_with', 'endswith', 'like', 'contains'].includes(fn)) return DataType.INT32;
    if (['abs', 'round', 'floor', 'ceil', 'sum', 'avg', 'min', 'max'].includes(fn)) {
      if (expr.args.length > 0 && expr.args[0].type === 'col') {
        const resolved = resolveColumnAcrossTables((expr.args[0] as any).name, tables ?? [table]);
        if (resolved && resolved.col.type === DataType.INT32 && fn !== 'avg') return DataType.INT32;
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
): void {
  if (resolveReg) {
    const colName = expr.type === 'col' ? expr.name : undefined;
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

  if (expr.type === 'literal') {
    const val = expr.value;
    if (val === null || val === undefined) {
      emitter.emitUint8(OpCode.OP_LOAD_NULL);
      emitter.emitUint8(targetReg);
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(targetReg);
        emitter.emitInt32(val);
      } else {
        emitter.emitUint8(OpCode.OP_LOAD_FLOAT);
        emitter.emitUint8(targetReg);
        emitter.emitFloat64(val);
      }
    } else if (typeof val === 'string') {
      emitter.emitUint8(OpCode.OP_LOAD_TEXT);
      emitter.emitUint8(targetReg);
      emitter.emitString(val);
    } else if (typeof val === 'boolean') {
      emitter.emitUint8(OpCode.OP_LOAD_INT);
      emitter.emitUint8(targetReg);
      emitter.emitInt32(val ? 1 : 0);
    }
    return;
  }

  if (expr.type === 'col') {
    if (cursor === -1) {
      throw new Error(`Column "${expr.name}" in HAVING clause must be an aggregate or grouping column`);
    }
    const all = tables ?? [table];
    const resolved = resolveColumnAcrossTables(expr.name, all);
    if (!resolved) {
      if (expr.name === '*') {
        emitter.emitUint8(OpCode.OP_LOAD_NULL);
        emitter.emitUint8(targetReg);
        return;
      }
      throw new Error(`Column "${expr.name}" does not exist in table "${table.name}"`);
    }
    emitReadColumn(emitter, resolved.cursor, resolved.colIdx, targetReg, resolved.col.type);
    return;
  }

  if (expr.type === 'binary') {
    const regLeft = allocReg();
    const regRight = allocReg();
    emitExpression(expr.left, table, emitter, cursor, regLeft, allocReg, udfNameMap, resolveReg, tables);
    emitExpression(expr.right, table, emitter, cursor, regRight, allocReg, udfNameMap, resolveReg, tables);

    let opCode = OpCode.OP_ADD;
    if (expr.op === '+') opCode = OpCode.OP_ADD;
    else if (expr.op === '-') opCode = OpCode.OP_SUB;
    else if (expr.op === '*') opCode = OpCode.OP_MUL;
    else if (expr.op === '/') opCode = OpCode.OP_DIV;
    else if (expr.op === '%') opCode = OpCode.OP_MOD;
    else if (
      expr.op === '=' ||
      expr.op === '!=' ||
      expr.op === '<' ||
      expr.op === '<=' ||
      expr.op === '>' ||
      expr.op === '>='
    ) {
      let cmpOp = OpCode.OP_EQ;
      if (expr.op === '=') cmpOp = OpCode.OP_EQ;
      else if (expr.op === '!=') cmpOp = OpCode.OP_NE;
      else if (expr.op === '<') cmpOp = OpCode.OP_LT;
      else if (expr.op === '<=') cmpOp = OpCode.OP_LE;
      else if (expr.op === '>') cmpOp = OpCode.OP_GT;
      else if (expr.op === '>=') cmpOp = OpCode.OP_GE;

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

  if (expr.type === 'fn') {
    const fnName = expr.name.toLowerCase();

    const unaryOps: Record<string, OpCode> = {
      upper: OpCode.OP_STR_UPPER,
      lower: OpCode.OP_STR_LOWER,
      length: OpCode.OP_STR_LENGTH,
      trim: OpCode.OP_STR_TRIM,
      abs: OpCode.OP_MATH_ABS,
      round: OpCode.OP_MATH_ROUND,
      floor: OpCode.OP_MATH_FLOOR,
      ceil: OpCode.OP_MATH_CEIL,
    };

    if (unaryOps[fnName]) {
      const srcReg = allocReg();
      const arg = expr.args[0] ?? { type: 'literal', value: null };
      emitExpression(arg, table, emitter, cursor, srcReg, allocReg, udfNameMap, resolveReg, tables);
      emitter.emitUint8(unaryOps[fnName]);
      emitter.emitUint8(srcReg);
      emitter.emitUint8(targetReg);
      return;
    }

    if (fnName === 'substr') {
      const srcReg = allocReg();
      const startReg = allocReg();
      const lenReg = allocReg();
      emitExpression(expr.args[0], table, emitter, cursor, srcReg, allocReg, udfNameMap, resolveReg, tables);
      emitExpression(expr.args[1] ?? { type: 'literal', value: 1 }, table, emitter, cursor, startReg, allocReg, udfNameMap, resolveReg, tables);
      if (expr.args[2] !== undefined) {
        emitExpression(expr.args[2], table, emitter, cursor, lenReg, allocReg, udfNameMap, resolveReg, tables);
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

    const patternOps: Record<string, OpCode> = {
      starts_with: OpCode.OP_STR_STARTS_WITH,
      startswith: OpCode.OP_STR_STARTS_WITH,
      ends_with: OpCode.OP_STR_ENDS_WITH,
      endswith: OpCode.OP_STR_ENDS_WITH,
      like: OpCode.OP_STR_LIKE,
      contains: OpCode.OP_STR_CONTAINS,
    };
    if (patternOps[fnName]) {
      const regStr = allocReg();
      const regPat = allocReg();
      emitExpression(expr.args[0] ?? { type: 'literal', value: null }, table, emitter, cursor, regStr, allocReg, udfNameMap, resolveReg, tables);
      emitExpression(expr.args[1] ?? { type: 'literal', value: '' }, table, emitter, cursor, regPat, allocReg, udfNameMap, resolveReg, tables);

      emitter.emitUint8(patternOps[fnName]);
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

    if (fnName === 'concat' || fnName === 'coalesce') {
      const numArgs = expr.args.length;
      const startReg = allocReg();
      for (let i = 1; i < numArgs; i++) {
        allocReg();
      }
      for (let i = 0; i < numArgs; i++) {
        emitExpression(expr.args[i], table, emitter, cursor, startReg + i, allocReg, udfNameMap, resolveReg, tables);
      }
      const op = fnName === 'concat' ? OpCode.OP_STR_CONCAT : OpCode.OP_COALESCE;
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
          emitExpression(expr.args[i], table, emitter, cursor, startReg + i, allocReg, udfNameMap, resolveReg, tables);
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

/**
 * Compiles a QueryPlan into an executable bytecode array.
 */
export function compileQuery(plan: QueryPlan): Uint8Array {
  const totalCursors = 1 + (plan.joinedTables?.length ?? 0);
  if (totalCursors > 16) {
    throw new TooManyCursorsError(totalCursors, 16);
  }

  const isJoinQuery = plan.joinedTables !== undefined && plan.joinedTables.length > 0;
  const allTables: TableMeta[] = [plan.table, ...(plan.joinedTables?.map((j) => j.table) ?? [])];

  const rootFilter = buildRootFilter(plan.filters);
  const leafFilters = rootFilter ? collectLeafFilters(rootFilter) : [];
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

  // 1. Preamble: Load constant filter values into registers
  for (let i = 0; i < leafFilters.length; i++) {
    const filter = leafFilters[i];
    if (filter.type === "cmp") {
      const regConst = i * 2 + 1;
      const val = filter.value;

      if (val === null || val === undefined) {
        emitter.emitUint8(OpCode.OP_LOAD_NULL);
        emitter.emitUint8(regConst);
      } else if (typeof val === "number") {
        const resolved = filter.colName
          ? resolveColumnAcrossTables(filter.colName, allTables)
          : undefined;
        if (resolved && resolved.col.type === DataType.FLOAT64) {
          emitter.emitUint8(OpCode.OP_LOAD_FLOAT);
          emitter.emitUint8(regConst);
          emitter.emitFloat64(val);
        } else if (!Number.isInteger(val)) {
          emitter.emitUint8(OpCode.OP_LOAD_FLOAT);
          emitter.emitUint8(regConst);
          emitter.emitFloat64(val);
        } else {
          emitter.emitUint8(OpCode.OP_LOAD_INT);
          emitter.emitUint8(regConst);
          emitter.emitInt32(Math.floor(val));
        }
      } else if (typeof val === "bigint") {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regConst);
        emitter.emitInt32(Number(val));
      } else if (typeof val === "string") {
        emitter.emitUint8(OpCode.OP_LOAD_TEXT);
        emitter.emitUint8(regConst);
        emitter.emitString(val);
      } else if (typeof val === "boolean") {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regConst);
        emitter.emitInt32(val ? 1 : 0);
      }
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
        typeof gItem === 'string'
          ? gItem
          : (gItem.colName ?? (gItem.expr ? deriveDefaultAlias(gItem.expr) : 'group_key'));

      const matchingSelect = plan.selectExprs?.find((s) => {
        if (s.alias === gColName) return true;
        if (typeof gItem === 'object' && gItem.expr) {
          return JSON.stringify(s.expr) === JSON.stringify(gItem.expr);
        }
        if (typeof gItem === 'string' && gItem.includes('(')) {
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
      const col = table.columns.find((c) => c.name === gColName || c.name === finalColName);
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

    emitFilterTree(rootFilter, table, emitter, leafRegMap, nextRowPatches, plan.udfNameMap);

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

        if (typeof gItem === 'object' && gItem.expr) {
          emitExpression(gItem.expr, table, emitter, 0, targetReg, allocReg, plan.udfNameMap);
        } else {
          const colName = typeof gItem === 'string' ? gItem : gItem.colName!;
          const aliasExpr = plan.selectExprs?.find((s) => s.alias === colName)?.expr;
          if (aliasExpr) {
            emitExpression(aliasExpr, table, emitter, 0, targetReg, allocReg, plan.udfNameMap);
          } else {
            const colIdx = table.columns.findIndex((c) => c.name === colName);
            if (colIdx !== -1) {
              const col = table.columns[colIdx];
              emitReadColumn(emitter, 0, colIdx, targetReg, col.type);
            } else {
              try {
                const parsed = parseExpression(colName);
                emitExpression(parsed, table, emitter, 0, targetReg, allocReg, plan.udfNameMap);
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

    // Identify unique aggregate operations to step
    const hasCount = aggregates.some((a) => a.func === "count");
    const hasAvg = aggregates.some((a) => a.func === "avg");
    const hasSum = aggregates.some((a) => a.func === "sum");
    const hasMin = aggregates.some((a) => a.func === "min");
    const hasMax = aggregates.some((a) => a.func === "max");

    // 1. COUNT step (funcId 0)
    if (hasCount || hasAvg || hasSum) {
      const countAgg = aggregates.find((a) => a.func === "count");
      let valReg = 255;
      if (countAgg && countAgg.colName && countAgg.colName !== "*") {
        const colIdx = table.columns.findIndex(
          (c) => c.name === countAgg.colName,
        );
        if (colIdx !== -1) {
          const col = table.columns[colIdx];
          valReg = aggValStartReg;
          emitReadColumn(emitter, 0, colIdx, valReg, col.type);
        }
      }
      emitter.emitUint8(OpCode.OP_AGG_STEP);
      emitter.emitUint8(0);
      emitter.emitUint8(groupKeyStartReg);
      emitter.emitUint8(G);
      emitter.emitUint8(valReg);
      emitter.emitUint8(0);
    }

    // 2. SUM step (funcId 1) - used for SUM and AVG
    if (hasSum || hasAvg) {
      const sumAgg = aggregates.find(
        (a) => a.func === "sum" || a.func === "avg",
      );
      let valReg = 255;
      if (sumAgg && sumAgg.colName && sumAgg.colName !== "*") {
        const colIdx = table.columns.findIndex(
          (c) => c.name === sumAgg.colName,
        );
        if (colIdx !== -1) {
          const col = table.columns[colIdx];
          valReg = aggValStartReg + 1;
          emitReadColumn(emitter, 0, colIdx, valReg, col.type);
        }
      }
      emitter.emitUint8(OpCode.OP_AGG_STEP);
      emitter.emitUint8(0);
      emitter.emitUint8(groupKeyStartReg);
      emitter.emitUint8(G);
      emitter.emitUint8(valReg);
      emitter.emitUint8(1);
    }

    // 3. MIN step (funcId 3)
    if (hasMin) {
      const minAgg = aggregates.find((a) => a.func === "min");
      let valReg = 255;
      if (minAgg && minAgg.colName && minAgg.colName !== "*") {
        const colIdx = table.columns.findIndex(
          (c) => c.name === minAgg.colName,
        );
        if (colIdx !== -1) {
          const col = table.columns[colIdx];
          valReg = aggValStartReg + 2;
          emitReadColumn(emitter, 0, colIdx, valReg, col.type);
        }
      }
      emitter.emitUint8(OpCode.OP_AGG_STEP);
      emitter.emitUint8(0);
      emitter.emitUint8(groupKeyStartReg);
      emitter.emitUint8(G);
      emitter.emitUint8(valReg);
      emitter.emitUint8(3);
    }

    // 4. MAX step (funcId 4)
    if (hasMax) {
      const maxAgg = aggregates.find((a) => a.func === "max");
      let valReg = 255;
      if (maxAgg && maxAgg.colName && maxAgg.colName !== "*") {
        const colIdx = table.columns.findIndex(
          (c) => c.name === maxAgg.colName,
        );
        if (colIdx !== -1) {
          const col = table.columns[colIdx];
          valReg = aggValStartReg + 3;
          emitReadColumn(emitter, 0, colIdx, valReg, col.type);
        }
      }
      emitter.emitUint8(OpCode.OP_AGG_STEP);
      emitter.emitUint8(0);
      emitter.emitUint8(groupKeyStartReg);
      emitter.emitUint8(G);
      emitter.emitUint8(valReg);
      emitter.emitUint8(4);
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

    // Finalize each aggregate
    for (let j = 0; j < aggregates.length; j++) {
      const agg = aggregates[j];
      const outReg = finalAggStartReg + j;
      let sumReg = outAccReg;
      let funcId = 0;
      if (agg.func === "count") {
        sumReg = outAccReg;
        funcId = 0;
      } else if (agg.func === "sum") {
        sumReg = outAccReg;
        funcId = 1;
      } else if (agg.func === "avg") {
        sumReg = outAccReg;
        funcId = 2;
      } else if (agg.func === "min") {
        sumReg = outAccReg + 2;
        funcId = 3;
      } else if (agg.func === "max") {
        sumReg = outAccReg + 3;
        funcId = 4;
      }

      emitter.emitUint8(OpCode.OP_AGG_FINAL);
      emitter.emitUint8(sumReg);
      emitter.emitUint8(outAccReg + 1); // countReg
      emitter.emitUint8(outReg);
      emitter.emitUint8(funcId);
    }

    // Symbol/register resolver for HAVING evaluation
    const resolveReg = (name?: string, expr?: ExprNode): number | undefined => {
      // 1. Check aggregates
      for (let j = 0; j < aggregates.length; j++) {
        const agg = aggregates[j];
        const aggReg = finalAggStartReg + j;

        if (name) {
          if (agg.alias && agg.alias === name) return aggReg;
          const defaultName = agg.colName ? `${agg.func}_${agg.colName}` : agg.func;
          if (defaultName === name) return aggReg;
          const sig = `${agg.func}(${agg.colName ?? '*'})`;
          if (sig === name.replace(/\s+/g, '')) return aggReg;
          if (agg.func === name) return aggReg;
        }

        if (expr && expr.type === 'fn') {
          const fnName = expr.name.toLowerCase();
          if (agg.func === fnName) {
            if (fnName === 'count') {
              const arg0 = expr.args[0];
              const argCol = arg0 && arg0.type === 'col' ? arg0.name : undefined;
              if (
                agg.colName === undefined ||
                agg.colName === '*' ||
                agg.colName === argCol
              ) {
                return aggReg;
              }
            } else {
              const arg0 = expr.args[0];
              const argCol = arg0 && arg0.type === 'col' ? arg0.name : undefined;
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
          const gColName = typeof gItem === 'string' ? gItem : gItem.colName;
          const gExpr = typeof gItem === 'object' ? gItem.expr : undefined;

          if (name) {
            if (gColName === name) return gReg;
            if (gExpr && deriveDefaultAlias(gExpr) === name) return gReg;
            const selectAlias = plan.selectExprs?.find((s) => s.alias === name);
            if (selectAlias) {
              if (gColName === selectAlias.alias) return gReg;
              if (gExpr && JSON.stringify(gExpr) === JSON.stringify(selectAlias.expr)) return gReg;
              if (typeof gItem === 'string' && gItem.includes('(')) {
                try {
                  const parsed = parseExpression(gItem);
                  if (JSON.stringify(parsed) === JSON.stringify(selectAlias.expr)) return gReg;
                } catch {}
              }
            }
          }

          if (expr) {
            if (gExpr && JSON.stringify(gExpr) === JSON.stringify(expr)) {
              return gReg;
            }
            if (expr.type === 'col' && gColName === expr.name) {
              return gReg;
            }
            if (typeof gItem === 'string' && gItem.includes('(')) {
              try {
                const parsed = parseExpression(gItem);
                if (JSON.stringify(parsed) === JSON.stringify(expr)) return gReg;
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
        rootHaving = { type: 'and', children: plan.having };
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

    const result = emitter.toByteArray();
    (result as any).outputColumns = outputColumns;
    (plan as any).outputColumns = outputColumns;
    return result;
  }

  // Case 2: In-Arena Sorter (ORDER BY)
  if (!isJoinQuery && plan.orderBy && plan.orderBy.length > 0) {
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

    emitFilterTree(rootFilter, table, emitter, leafRegMap, nextRowPatches, plan.udfNameMap);

    // Extract sort keys into registers
    for (let k = 0; k < K; k++) {
      const sortKey = plan.orderBy[k];
      const targetReg = sortKeyStartReg + k;
      let tempReg = 50;
      const allocReg = () => {
        if (tempReg >= 64) throw new TooManyRegistersError(tempReg);
        return tempReg++;
      };

      if (sortKey.expr) {
        emitExpression(sortKey.expr, table, emitter, 0, targetReg, allocReg, plan.udfNameMap);
      } else if (sortKey.colName) {
        const colName = sortKey.colName;
        // 1. Check if colName matches a select alias
        const aliasExpr = plan.selectExprs?.find((s) => s.alias === colName)?.expr;
        if (aliasExpr) {
          emitExpression(aliasExpr, table, emitter, 0, targetReg, allocReg, plan.udfNameMap);
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
              emitExpression(parsed, table, emitter, 0, targetReg, allocReg, plan.udfNameMap);
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

    const result = emitter.toByteArray();
    (result as any).keyInfos = plan.keyInfos;
    return result;
  }

  // Case 3: Scan (Unsorted, non-aggregate) / Nested Loop Joins
  const hasSelectExprs =
    plan.selectExprs !== undefined &&
    plan.selectExprs.length > 0 &&
    !(
      plan.selectExprs.length === 1 &&
      plan.selectExprs[0].expr.type === 'col' &&
      plan.selectExprs[0].expr.name === '*'
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
          expr: { type: 'col', name: `${t.name}.${c.name}` },
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
    for (let i = 1; i < N; i++) {
      const joinPlan = plan.joinedTables![i - 1];
      if (joinPlan.type === 'left') {
        regMatched[i] = nextReg++;
      }
    }
    const regJoinLeft = nextReg++;
    const regJoinRight = nextReg++;
    const regZero = nextReg++;
    if (nextReg >= 64) {
      throw new TooManyRegistersError(nextReg);
    }

    // Open Cursors for all tables
    for (let i = 0; i < N; i++) {
      emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
      emitter.emitUint8(i);
      emitter.emitUint32(allTables[i].rootPageId);
    }

    const rewindJumpPatches: number[] = new Array(N);
    const loopStartPositions: number[] = new Array(N);
    const nextRowPatchesPerTable: number[][] = Array.from({ length: N }, () => []);
    const nextRowEofPatches: number[] = new Array(N);
    const limitHaltPatches: number[] = [];

    // Outer table (Table 0) Rewind
    emitter.emitUint8(OpCode.OP_REWIND);
    emitter.emitUint8(0);
    rewindJumpPatches[0] = emitter.emitUint16(0);

    loopStartPositions[0] = emitter.currentOffset();

    // Nested Joined Tables (1..N-1)
    for (let i = 1; i < N; i++) {
      const joinPlan = plan.joinedTables![i - 1];
      if (joinPlan.type === 'left') {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regMatched[i]);
        emitter.emitInt32(0);
      }

      emitter.emitUint8(OpCode.OP_REWIND);
      emitter.emitUint8(i);
      rewindJumpPatches[i] = emitter.emitUint16(0);

      loopStartPositions[i] = emitter.currentOffset();

      const resolvedLeft = resolveColumnAcrossTables(joinPlan.leftCol, allTables);
      if (!resolvedLeft) {
        throw new Error(`Join column "${joinPlan.leftCol}" not found in tables`);
      }
      const resolvedRight = resolveColumnAcrossTables(joinPlan.rightCol, allTables);
      if (!resolvedRight) {
        throw new Error(`Join column "${joinPlan.rightCol}" not found in tables`);
      }

      emitReadColumn(
        emitter,
        resolvedLeft.cursor,
        resolvedLeft.colIdx,
        regJoinLeft,
        resolvedLeft.col.type,
      );
      emitReadColumn(
        emitter,
        resolvedRight.cursor,
        resolvedRight.colIdx,
        regJoinRight,
        resolvedRight.col.type,
      );

      let cmpOp: OpCode;
      switch (joinPlan.op) {
        case '=':
          cmpOp = OpCode.OP_EQ;
          break;
        case '!=':
          cmpOp = OpCode.OP_NE;
          break;
        case '>':
          cmpOp = OpCode.OP_GT;
          break;
        case '>=':
          cmpOp = OpCode.OP_GE;
          break;
        case '<':
          cmpOp = OpCode.OP_LT;
          break;
        case '<=':
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

      if (joinPlan.type === 'left') {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regMatched[i]);
        emitter.emitInt32(1);
      }
    }

    // Innermost: WHERE filters
    emitFilterTree(
      rootFilter,
      table,
      emitter,
      leafRegMap,
      nextRowPatchesPerTable[N - 1],
      plan.udfNameMap,
      allTables,
    );

    let offsetSkipPatch = -1;
    if (hasOffset) {
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
      );
    }

    emitter.emitUint8(OpCode.OP_RESULT_ROW);
    emitter.emitUint8(outStartReg);
    emitter.emitUint8(outSelectExprs.length);

    if (hasLimit) {
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

      emitter.emitUint8(OpCode.OP_NEXT_ROW);
      emitter.emitUint8(i);
      nextRowEofPatches[i] = emitter.emitUint16(0);

      emitter.emitUint8(OpCode.OP_JUMP);
      emitter.emitUint16(loopStartPositions[i]);

      const eofPos = emitter.currentOffset();
      emitter.patchUint16(rewindJumpPatches[i], eofPos);
      emitter.patchUint16(nextRowEofPatches[i], eofPos);

      const joinPlan = plan.joinedTables![i - 1];
      if (joinPlan.type === 'left') {
        emitter.emitUint8(OpCode.OP_LOAD_INT);
        emitter.emitUint8(regZero);
        emitter.emitInt32(0);

        emitter.emitUint8(OpCode.OP_EQ);
        emitter.emitUint8(regMatched[i]);
        emitter.emitUint8(regZero);
        const nullRowBranchPatch = emitter.emitUint16(0);

        emitter.emitUint8(OpCode.OP_JUMP);
        const skipNullRowPatch = emitter.emitUint16(0);

        emitter.patchUint16(nullRowBranchPatch, emitter.currentOffset());

        for (let k = 0; k < outSelectExprs.length; k++) {
          const se = outSelectExprs[k];
          let refTableIdx = -1;
          if (se.expr.type === 'col') {
            const resolved = resolveColumnAcrossTables(se.expr.name, allTables);
            if (resolved) {
              refTableIdx = resolved.tableIdx;
            }
          }
          if (refTableIdx >= i) {
            emitter.emitUint8(OpCode.OP_LOAD_NULL);
            emitter.emitUint8(outStartReg + k);
          } else {
            emitExpression(
              se.expr,
              table,
              emitter,
              0,
              outStartReg + k,
              allocExprReg,
              plan.udfNameMap,
              undefined,
              allTables,
            );
          }
        }

        const afterNullRowPatches: number[] = [];
        if (hasOffset) {
          emitter.emitUint8(OpCode.OP_OFFSET);
          emitter.emitUint8(regOffset);
          afterNullRowPatches.push(emitter.emitUint16(0));
        }

        emitter.emitUint8(OpCode.OP_RESULT_ROW);
        emitter.emitUint8(outStartReg);
        emitter.emitUint8(outSelectExprs.length);

        if (hasLimit) {
          emitter.emitUint8(OpCode.OP_LIMIT);
          emitter.emitUint8(regLimit);
          limitHaltPatches.push(emitter.emitUint16(0));
        }

        const afterNullRowPos = emitter.currentOffset();
        emitter.patchUint16(skipNullRowPatch, afterNullRowPos);
        for (const p of afterNullRowPatches) {
          emitter.patchUint16(p, afterNullRowPos);
        }
      }
    }

    const nextRowPos0 = emitter.currentOffset();
    for (const patch of nextRowPatchesPerTable[0]) {
      emitter.patchUint16(patch, nextRowPos0);
    }

    emitter.emitUint8(OpCode.OP_NEXT_ROW);
    emitter.emitUint8(0);
    nextRowEofPatches[0] = emitter.emitUint16(0);

    emitter.emitUint8(OpCode.OP_JUMP);
    emitter.emitUint16(loopStartPositions[0]);

    const eofPos0 = emitter.currentOffset();
    emitter.patchUint16(rewindJumpPatches[0], eofPos0);
    emitter.patchUint16(nextRowEofPatches[0], eofPos0);
    for (const patch of limitHaltPatches) {
      emitter.patchUint16(patch, eofPos0);
    }

    emitter.emitUint8(OpCode.OP_HALT);

    const result = emitter.toByteArray();
    if (plan.outputColumns) {
      (result as any).outputColumns = plan.outputColumns;
    }
    return result;
  }

  // Open Cursor
  emitter.emitUint8(OpCode.OP_OPEN_CURSOR);
  emitter.emitUint8(0);
  emitter.emitUint32(table.rootPageId);

  // Rewind Cursor
  emitter.emitUint8(OpCode.OP_REWIND);
  emitter.emitUint8(0);
  const rewindJumpPatch = emitter.emitUint16(0);

  // Loop start
  const loopStartPos = emitter.currentOffset();
  const nextRowPatches: number[] = [];

  emitFilterTree(rootFilter, table, emitter, leafRegMap, nextRowPatches, plan.udfNameMap);

  let offsetSkipPatch = -1;
  if (hasOffset) {
    emitter.emitUint8(OpCode.OP_OFFSET);
    emitter.emitUint8(regOffset);
    offsetSkipPatch = emitter.emitUint16(0);
  }

  // Emit matching row
  if (hasSelectExprs) {
    let exprTempReg = nextReg;
    const allocExprReg = () => {
      if (exprTempReg >= 64) throw new TooManyRegistersError(exprTempReg);
      return exprTempReg++;
    };
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

  let limitHaltPatch = -1;
  if (hasLimit) {
    emitter.emitUint8(OpCode.OP_LIMIT);
    emitter.emitUint8(regLimit);
    limitHaltPatch = emitter.emitUint16(0);
  }

  // next_row_label
  const nextRowPos = emitter.currentOffset();
  if (offsetSkipPatch !== -1) {
    emitter.patchUint16(offsetSkipPatch, nextRowPos);
  }
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

  // EOF Label
  const eofPos = emitter.currentOffset();
  emitter.patchUint16(rewindJumpPatch, eofPos);
  emitter.patchUint16(nextRowEofPatch, eofPos);
  if (limitHaltPatch !== -1) {
    emitter.patchUint16(limitHaltPatch, eofPos);
  }

  emitter.emitUint8(OpCode.OP_HALT);

  const result = emitter.toByteArray();
  if (plan.outputColumns) {
    (result as any).outputColumns = plan.outputColumns;
  }
  return result;
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

  const getColName = (idx: number) => {
    return table?.columns[idx]?.name
      ? `'${table.columns[idx].name}'`
      : `col_${idx}`;
  };

  const fmtAddr = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;

  while (pc < bytecode.byteLength) {
    const addr = pc;
    const op = bytecode[pc++];

    switch (op) {
      case OpCode.OP_HALT:
        instructions.push({
          addr,
          opcode: "OP_HALT",
          p1: "",
          p2: "",
          p3: "",
          comment: "Halt VM execution (STATUS_DONE)",
        });
        break;

      case OpCode.OP_OPEN_CURSOR: {
        const cursor = bytecode[pc++];
        const rootPage = view.getUint32(pc, true);
        pc += 4;
        instructions.push({
          addr,
          opcode: "OP_OPEN_CURSOR",
          p1: `c[${cursor}]`,
          p2: `page=${rootPage}`,
          p3: "",
          comment: `Open cursor ${cursor} on root page ${rootPage}${table ? ` ('${table.name}')` : ""}`,
        });
        break;
      }

      case OpCode.OP_REWIND: {
        const cursor = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_REWIND",
          p1: `c[${cursor}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `Rewind cursor to first row; jump to ${fmtAddr(jumpTarget)} if empty`,
        });
        break;
      }

      case OpCode.OP_NEXT_ROW: {
        const cursor = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_NEXT_ROW",
          p1: `c[${cursor}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `Advance cursor to next row; jump to ${fmtAddr(jumpTarget)} if EOF`,
        });
        break;
      }

      case OpCode.OP_LAST: {
        const cursor = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_LAST",
          p1: `c[${cursor}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `Position cursor to last row; jump to ${fmtAddr(jumpTarget)} if empty`,
        });
        break;
      }

      case OpCode.OP_PREV_ROW: {
        const cursor = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_PREV_ROW",
          p1: `c[${cursor}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `Advance cursor to previous row; jump to ${fmtAddr(jumpTarget)} if BOF`,
        });
        break;
      }

      case OpCode.OP_COLUMN_INT: {
        const cursor = bytecode[pc++];
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_COLUMN_INT",
          p1: `c[${cursor}]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as INT into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_COLUMN_FLOAT: {
        const cursor = bytecode[pc++];
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_COLUMN_FLOAT",
          p1: `c[${cursor}]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as FLOAT into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_COLUMN_TEXT: {
        const cursor = bytecode[pc++];
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_COLUMN_TEXT",
          p1: `c[${cursor}]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as TEXT into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_COLUMN_BLOB: {
        const cursor = bytecode[pc++];
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_COLUMN_BLOB",
          p1: `c[${cursor}]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as BLOB into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_COLUMN_UUID: {
        const cursor = bytecode[pc++];
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_COLUMN_UUID",
          p1: `c[${cursor}]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as UUID into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_COLUMN_ULID: {
        const cursor = bytecode[pc++];
        const colIdx = bytecode[pc++];
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_COLUMN_ULID",
          p1: `c[${cursor}]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: `r[${regIdx}]`,
          comment: `Read ${getColName(colIdx)} as ULID into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_IS_NULL: {
        const cursor = bytecode[pc++];
        const colIdx = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_IS_NULL",
          p1: `c[${cursor}]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: fmtAddr(jumpTarget),
          comment: `If ${getColName(colIdx)} IS NULL -> jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_IS_NOT_NULL: {
        const cursor = bytecode[pc++];
        const colIdx = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_IS_NOT_NULL",
          p1: `c[${cursor}]`,
          p2: `${colIdx} (${getColName(colIdx)})`,
          p3: fmtAddr(jumpTarget),
          comment: `If ${getColName(colIdx)} IS NOT NULL -> jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_EQ:
      case OpCode.OP_NE:
      case OpCode.OP_GT:
      case OpCode.OP_GE:
      case OpCode.OP_LT:
      case OpCode.OP_LE: {
        const opNames: Record<number, string> = {
          [OpCode.OP_EQ]: "OP_EQ",
          [OpCode.OP_NE]: "OP_NE",
          [OpCode.OP_GT]: "OP_GT",
          [OpCode.OP_GE]: "OP_GE",
          [OpCode.OP_LT]: "OP_LT",
          [OpCode.OP_LE]: "OP_LE",
        };
        const symbols: Record<number, string> = {
          [OpCode.OP_EQ]: "==",
          [OpCode.OP_NE]: "!=",
          [OpCode.OP_GT]: ">",
          [OpCode.OP_GE]: ">=",
          [OpCode.OP_LT]: "<",
          [OpCode.OP_LE]: "<=",
        };
        const regA = bytecode[pc++];
        const regB = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: opNames[op],
          p1: `r[${regA}]`,
          p2: `r[${regB}]`,
          p3: fmtAddr(jumpTarget),
          comment: `If r[${regA}] ${symbols[op]} r[${regB}] -> jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_JUMP: {
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_JUMP",
          p1: fmtAddr(jumpTarget),
          p2: "",
          p3: "",
          comment: `Unconditional jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_STR_LIKE:
      case OpCode.OP_STR_NOT_LIKE:
      case OpCode.OP_STR_CONTAINS:
      case OpCode.OP_STR_STARTS_WITH:
      case OpCode.OP_STR_ENDS_WITH: {
        const opNames: Record<number, string> = {
          [OpCode.OP_STR_LIKE]: "OP_STR_LIKE",
          [OpCode.OP_STR_NOT_LIKE]: "OP_STR_NOT_LIKE",
          [OpCode.OP_STR_CONTAINS]: "OP_STR_CONTAINS",
          [OpCode.OP_STR_STARTS_WITH]: "OP_STR_STARTS_WITH",
          [OpCode.OP_STR_ENDS_WITH]: "OP_STR_ENDS_WITH",
        };
        const descriptions: Record<number, string> = {
          [OpCode.OP_STR_LIKE]: "LIKE",
          [OpCode.OP_STR_NOT_LIKE]: "NOT LIKE",
          [OpCode.OP_STR_CONTAINS]: "CONTAINS",
          [OpCode.OP_STR_STARTS_WITH]: "STARTS_WITH",
          [OpCode.OP_STR_ENDS_WITH]: "ENDS_WITH",
        };
        const regA = bytecode[pc++];
        const regB = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: opNames[op],
          p1: `r[${regA}]`,
          p2: `r[${regB}]`,
          p3: fmtAddr(jumpTarget),
          comment: `If r[${regA}] ${descriptions[op]} r[${regB}] -> jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_LOAD_INT: {
        const regIdx = bytecode[pc++];
        const val = view.getInt32(pc, true);
        pc += 4;
        instructions.push({
          addr,
          opcode: "OP_LOAD_INT",
          p1: `r[${regIdx}]`,
          p2: `${val}`,
          p3: "",
          comment: `Load literal int ${val} into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_LOAD_FLOAT: {
        const regIdx = bytecode[pc++];
        const val = view.getFloat64(pc, true);
        pc += 8;
        instructions.push({
          addr,
          opcode: "OP_LOAD_FLOAT",
          p1: `r[${regIdx}]`,
          p2: `${val}`,
          p3: "",
          comment: `Load literal float ${val} into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_LOAD_TEXT: {
        const regIdx = bytecode[pc++];
        const len = view.getUint16(pc, true);
        pc += 2;
        const textBytes = new Uint8Array(
          bytecode.buffer,
          bytecode.byteOffset + pc,
          len,
        );
        const str = textDecoder.decode(textBytes);
        pc += len;
        instructions.push({
          addr,
          opcode: "OP_LOAD_TEXT",
          p1: `r[${regIdx}]`,
          p2: `"${str}"`,
          p3: "",
          comment: `Load literal text "${str}" into r[${regIdx}]`,
        });
        break;
      }

      case OpCode.OP_LOAD_NULL: {
        const regIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_LOAD_NULL",
          p1: `r[${regIdx}]`,
          p2: "NULL",
          p3: "",
          comment: `Set r[${regIdx}] to NULL`,
        });
        break;
      }

      case OpCode.OP_EMIT_ROW: {
        const cursor = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_EMIT_ROW",
          p1: `c[${cursor}]`,
          p2: "",
          p3: "",
          comment: `Row passed all filters -> emit to Output Result Buffer`,
        });
        break;
      }

      case OpCode.OP_RESULT_ROW: {
        const startReg = bytecode[pc++];
        const numCols = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_RESULT_ROW",
          p1: `r[${startReg}]`,
          p2: `cols=${numCols}`,
          p3: "",
          comment: `Serialize registers r[${startReg}..${startReg + numCols - 1}] to Result Buffer`,
        });
        break;
      }

      case OpCode.OP_OFFSET: {
        const offsetReg = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_OFFSET",
          p1: `r[${offsetReg}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `If r[${offsetReg}] > 0 -> decrement and skip row to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_LIMIT: {
        const limitReg = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_LIMIT",
          p1: `r[${limitReg}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `If r[${limitReg}] <= 1 -> halt to ${fmtAddr(jumpTarget)}, else decrement`,
        });
        break;
      }
      case OpCode.OP_CALL_UDF: {
        const udfId = view.getUint16(pc, true);
        pc += 2;
        const startArgReg = bytecode[pc++];
        const numArgs = bytecode[pc++];
        const destReg = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_CALL_UDF",
          p1: `udf#${udfId}`,
          p2: `r[${startArgReg}..${startArgReg + numArgs - 1}]`,
          p3: `r[${destReg}]`,
          comment: `Call UDF #${udfId} with ${numArgs} args -> r[${destReg}]`,
        });
        break;
      }

      case OpCode.OP_STR_LOWER:
      case OpCode.OP_STR_UPPER:
      case OpCode.OP_STR_LENGTH:
      case OpCode.OP_STR_TRIM:
      case OpCode.OP_MATH_ABS:
      case OpCode.OP_MATH_ROUND:
      case OpCode.OP_MATH_FLOOR:
      case OpCode.OP_MATH_CEIL: {
        const opNames: Record<number, string> = {
          [OpCode.OP_STR_LOWER]: "OP_STR_LOWER",
          [OpCode.OP_STR_UPPER]: "OP_STR_UPPER",
          [OpCode.OP_STR_LENGTH]: "OP_STR_LENGTH",
          [OpCode.OP_STR_TRIM]: "OP_STR_TRIM",
          [OpCode.OP_MATH_ABS]: "OP_MATH_ABS",
          [OpCode.OP_MATH_ROUND]: "OP_MATH_ROUND",
          [OpCode.OP_MATH_FLOOR]: "OP_MATH_FLOOR",
          [OpCode.OP_MATH_CEIL]: "OP_MATH_CEIL",
        };
        const srcReg = bytecode[pc++];
        const destReg = bytecode[pc++];
        instructions.push({
          addr,
          opcode: opNames[op],
          p1: `r[${srcReg}]`,
          p2: `r[${destReg}]`,
          p3: "",
          comment: `${opNames[op]}: r[${destReg}] = ${opNames[op].toLowerCase()}(r[${srcReg}])`,
        });
        break;
      }

      case OpCode.OP_STR_SUBSTR: {
        const srcReg = bytecode[pc++];
        const startReg = bytecode[pc++];
        const lenReg = bytecode[pc++];
        const destReg = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_STR_SUBSTR",
          p1: `r[${srcReg}]`,
          p2: `start=r[${startReg}], len=r[${lenReg}]`,
          p3: `r[${destReg}]`,
          comment: `Extract substring from r[${srcReg}] into r[${destReg}]`,
        });
        break;
      }

      case OpCode.OP_ADD:
      case OpCode.OP_SUB:
      case OpCode.OP_MUL:
      case OpCode.OP_DIV:
      case OpCode.OP_MOD: {
        const opNames: Record<number, string> = {
          [OpCode.OP_ADD]: "OP_ADD",
          [OpCode.OP_SUB]: "OP_SUB",
          [OpCode.OP_MUL]: "OP_MUL",
          [OpCode.OP_DIV]: "OP_DIV",
          [OpCode.OP_MOD]: "OP_MOD",
        };
        const regA = bytecode[pc++];
        const regB = bytecode[pc++];
        const destReg = bytecode[pc++];
        instructions.push({
          addr,
          opcode: opNames[op],
          p1: `r[${regA}]`,
          p2: `r[${regB}]`,
          p3: `r[${destReg}]`,
          comment: `${opNames[op]}: r[${destReg}] = r[${regA}] ${opNames[op].replace("OP_", "")} r[${regB}]`,
        });
        break;
      }

      case OpCode.OP_STR_CONCAT:
      case OpCode.OP_COALESCE: {
        const opNames: Record<number, string> = {
          [OpCode.OP_STR_CONCAT]: "OP_STR_CONCAT",
          [OpCode.OP_COALESCE]: "OP_COALESCE",
        };
        const startReg = bytecode[pc++];
        const numRegs = bytecode[pc++];
        const destReg = bytecode[pc++];
        instructions.push({
          addr,
          opcode: opNames[op],
          p1: `r[${startReg}..${startReg + numRegs - 1}]`,
          p2: `count=${numRegs}`,
          p3: `r[${destReg}]`,
          comment: `${opNames[op]}: r[${destReg}]`,
        });
        break;
      }

      case OpCode.OP_COPY: {
        const srcReg = bytecode[pc++];
        const destReg = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_COPY",
          p1: `r[${srcReg}]`,
          p2: `r[${destReg}]`,
          p3: "",
          comment: `Copy r[${srcReg}] to r[${destReg}]`,
        });
        break;
      }

      case OpCode.OP_SORTER_OPEN: {
        const sorterId = bytecode[pc++];
        const keyInfoIdx = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_SORTER_OPEN",
          p1: `s[${sorterId}]`,
          p2: `keyInfo=${keyInfoIdx}`,
          p3: "",
          comment: `Open sorter ${sorterId} with keyInfo ${keyInfoIdx}`,
        });
        break;
      }

      case OpCode.OP_SORTER_INSERT: {
        const sorterId = bytecode[pc++];
        const startReg = bytecode[pc++];
        const numKeys = bytecode[pc++];
        const cursor = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_SORTER_INSERT",
          p1: `s[${sorterId}]`,
          p2: `r[${startReg}..+${numKeys}]`,
          p3: `c[${cursor}]`,
          comment: `Insert row from cursor ${cursor} into sorter ${sorterId}`,
        });
        break;
      }

      case OpCode.OP_SORTER_SORT: {
        const sorterId = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_SORTER_SORT",
          p1: `s[${sorterId}]`,
          p2: "",
          p3: "",
          comment: `Sort entries in sorter ${sorterId}`,
        });
        break;
      }

      case OpCode.OP_SORTER_NEXT: {
        const sorterId = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_SORTER_NEXT",
          p1: `s[${sorterId}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `Emit next sorted row from sorter ${sorterId}; jump to ${fmtAddr(jumpTarget)} while more rows`,
        });
        break;
      }

      case OpCode.OP_AGG_INIT: {
        const aggId = bytecode[pc++];
        const startKeyReg = bytecode[pc++];
        const numKeys = bytecode[pc++];
        const mode = bytecode[pc++];
        instructions.push({
          addr,
          opcode: "OP_AGG_INIT",
          p1: `agg[${aggId}]`,
          p2: `keys=r[${startKeyReg}..+${numKeys}]`,
          p3: `mode=${mode === 0 ? "hash" : "stream"}`,
          comment: `Initialize aggregator ${aggId} (${mode === 0 ? "hash table" : "stream"})`,
        });
        break;
      }

      case OpCode.OP_AGG_STEP: {
        const aggId = bytecode[pc++];
        const startKeyReg = bytecode[pc++];
        const numKeys = bytecode[pc++];
        const valReg = bytecode[pc++];
        const funcId = bytecode[pc++];
        const funcNames = ["COUNT", "SUM", "AVG", "MIN", "MAX"];
        instructions.push({
          addr,
          opcode: "OP_AGG_STEP",
          p1: `agg[${aggId}]`,
          p2: `val=${valReg === 255 ? "*" : `r[${valReg}]`}`,
          p3: funcNames[funcId] ?? `${funcId}`,
          comment: `Update accumulator ${funcNames[funcId] ?? funcId} for group r[${startKeyReg}..+${numKeys}]`,
        });
        break;
      }

      case OpCode.OP_AGG_NEXT: {
        const aggId = bytecode[pc++];
        const outKeyReg = bytecode[pc++];
        const outAccReg = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_AGG_NEXT",
          p1: `agg[${aggId}]`,
          p2: `out_keys=r[${outKeyReg}], out_acc=r[${outAccReg}]`,
          p3: fmtAddr(jumpTarget),
          comment: `Iterate next group bucket; jump to ${fmtAddr(jumpTarget)}`,
        });
        break;
      }

      case OpCode.OP_AGG_FINAL: {
        const sumReg = bytecode[pc++];
        const countReg = bytecode[pc++];
        const outReg = bytecode[pc++];
        const funcId = bytecode[pc++];
        const funcNames = ["COUNT", "SUM", "AVG", "MIN", "MAX"];
        instructions.push({
          addr,
          opcode: "OP_AGG_FINAL",
          p1: `sum=r[${sumReg}], cnt=r[${countReg}]`,
          p2: `r[${outReg}]`,
          p3: funcNames[funcId] ?? `${funcId}`,
          comment: `Finalize ${funcNames[funcId] ?? funcId} into r[${outReg}]`,
        });
        break;
      }

      case OpCode.OP_REG_IS_NULL: {
        const reg = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_REG_IS_NULL",
          p1: `r[${reg}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `Jump to ${fmtAddr(jumpTarget)} if r[${reg}] is NULL`,
        });
        break;
      }

      case OpCode.OP_REG_IS_NOT_NULL: {
        const reg = bytecode[pc++];
        const jumpTarget = view.getUint16(pc, true);
        pc += 2;
        instructions.push({
          addr,
          opcode: "OP_REG_IS_NOT_NULL",
          p1: `r[${reg}]`,
          p2: fmtAddr(jumpTarget),
          p3: "",
          comment: `Jump to ${fmtAddr(jumpTarget)} if r[${reg}] is NOT NULL`,
        });
        break;
      }

      default:
        instructions.push({
          addr,
          opcode: `OP_UNKNOWN(0x${op.toString(16)})`,
          p1: "",
          p2: "",
          p3: "",
          comment: "Unknown opcode",
        });
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
