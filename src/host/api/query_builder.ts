import { DbRow } from '../../types/index.js';
import {
  ComparisonOp,
  QueryFilter,
  SortKey,
  AggExpr,
  AggFunc,
  DisassembledInstruction,
} from '../compiler/compiler.js';

export type SelectFunction =
  | 'count'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'upper'
  | 'lower'
  | 'length'
  | 'substr'
  | 'trim'
  | 'round'
  | 'floor'
  | 'ceil'
  | 'abs'
  | ((val: any, row: DbRow) => any);

export interface SelectColumnSpec {
  col?: string;
  as?: string;
  fn?: SelectFunction | string;
  args?: any[];
}

export interface NormalizedSelectField {
  sourceCol?: string;
  alias: string;
  fn?: SelectFunction | string;
  args?: any[];
}

export type SelectItem =
  | string
  | SelectColumnSpec
  | Record<string, string | SelectColumnSpec>;

export function normalizeSelectItem(item: any): NormalizedSelectField[] {
  if (!item) return [];

  if (Array.isArray(item)) {
    const fields: NormalizedSelectField[] = [];
    for (const sub of item) {
      fields.push(...normalizeSelectItem(sub));
    }
    return fields;
  }

  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (!trimmed) return [];

    const asMatch = trimmed.match(/^(.+?)\s+as\s+(.+)$/i);
    let expr: string;
    let alias: string;
    if (asMatch) {
      expr = asMatch[1].trim();
      alias = asMatch[2].trim();
    } else {
      expr = trimmed;
      alias = expr;
    }

    const fnMatch = expr.match(/^(\w+)\s*\((.*)\)$/);
    if (fnMatch) {
      const funcName = fnMatch[1].toLowerCase();
      const rawArg = fnMatch[2].trim();
      if (!asMatch) {
        alias = rawArg && rawArg !== '*' ? `${funcName}_${rawArg}` : funcName;
      }
      return [
        {
          sourceCol: rawArg === '*' ? undefined : rawArg,
          alias,
          fn: funcName,
        },
      ];
    }

    return [{ sourceCol: expr, alias }];
  }

  if (typeof item === 'object') {
    const hasCol = item.col !== undefined;
    const hasFn = item.fn !== undefined;
    const hasAs = item.as !== undefined;

    if (hasCol || hasFn || hasAs) {
      const col = item.col;
      const fn = item.fn;
      let as = item.as;
      if (!as) {
        if (typeof fn === 'string') {
          as = col && col !== '*' ? `${fn}_${col}` : fn;
        } else if (col) {
          as = col;
        } else {
          as = 'val';
        }
      }
      return [
        {
          sourceCol: col === '*' ? undefined : col,
          alias: as,
          fn,
          args: item.args,
        },
      ];
    }

    // Key-value dictionary: strictly {[col]: alias}
    const fields: NormalizedSelectField[] = [];
    for (const [col, val] of Object.entries(item)) {
      if (typeof val === 'string') {
        fields.push({
          sourceCol: col === '*' ? undefined : col,
          alias: val,
        });
      } else if (typeof val === 'object' && val !== null) {
        const spec = val as SelectColumnSpec;
        fields.push({
          sourceCol: spec.col ?? (col === '*' ? undefined : col),
          alias:
            spec.as ??
            (typeof spec.fn === 'string' ? `${spec.fn}_${col}` : col),
          fn: spec.fn,
          args: spec.args,
        });
      }
    }
    return fields;
  }

  return [];
}

export interface ExplainOutput {
  plan: {
    table: string;
    rootPageId: number;
    scanType: 'TableScan';
    filters: QueryFilter[];
    orderBy?: SortKey[];
    groupBy?: string[];
    aggregates?: AggExpr[];
    select?: NormalizedSelectField[];
    limit?: number;
    offset?: number;
  };
  bytecodeSize: number;
  instructions: DisassembledInstruction[];
  assembly: string;
}

export interface QueryExecutionOptions {
  limit: number | null;
  offset: number | null;
  sortCol: string | null;
  sortDir: 'asc' | 'desc';
  orderBy?: SortKey[];
  groupBy?: string[];
  aggregates?: AggExpr[];
  select?: NormalizedSelectField[];
}

export interface IDatabaseQueryExecutor {
  explainQuery(
    tableName: string,
    filters: QueryFilter[],
    options?: {
      orderBy?: SortKey[];
      groupBy?: string[];
      aggregates?: AggExpr[];
      select?: NormalizedSelectField[];
      limit?: number;
      offset?: number;
    },
  ): Promise<ExplainOutput>;
  executeQuery(
    tableName: string,
    filters: QueryFilter[],
    options: QueryExecutionOptions,
  ): Promise<DbRow[]>;
}

export class QueryBuilder {
  private db: IDatabaseQueryExecutor;
  private tableName: string;
  private filters: QueryFilter[] = [];
  private selectFields: NormalizedSelectField[] = [];
  private limitCount: number | null = null;
  private offsetCount: number | null = null;
  private sortCol: string | null = null;
  private sortDir: 'asc' | 'desc' = 'asc';
  private orderKeys: SortKey[] = [];
  private groupCols: string[] = [];
  private aggExprs: AggExpr[] = [];

  constructor(db: IDatabaseQueryExecutor, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  where(colName: string, op: ComparisonOp, value: any): this;
  where(callback: (qb: QueryBuilder) => void): this;
  where(
    colOrCb: string | ((qb: QueryBuilder) => void),
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCb === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCb(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.filters.push(subFilter);
      }
    } else {
      this.filters.push({ type: 'cmp', colName: colOrCb, op: op!, value });
    }
    return this;
  }

  orWhere(colName: string, op: ComparisonOp, value: any): this;
  orWhere(callback: (qb: QueryBuilder) => void): this;
  orWhere(
    colOrCb: string | ((qb: QueryBuilder) => void),
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCb === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCb(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.addOrFilter(subFilter);
      }
    } else {
      this.addOrFilter({ type: 'cmp', colName: colOrCb, op: op!, value });
    }
    return this;
  }

  whereNot(colName: string, op: ComparisonOp, value: any): this;
  whereNot(callback: (qb: QueryBuilder) => void): this;
  whereNot(
    colOrCb: string | ((qb: QueryBuilder) => void),
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCb === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCb(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.filters.push({ type: 'not', child: subFilter });
      }
    } else {
      this.filters.push({
        type: 'not',
        child: { type: 'cmp', colName: colOrCb, op: op!, value },
      });
    }
    return this;
  }

  orWhereNot(colName: string, op: ComparisonOp, value: any): this;
  orWhereNot(callback: (qb: QueryBuilder) => void): this;
  orWhereNot(
    colOrCb: string | ((qb: QueryBuilder) => void),
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCb === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCb(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.addOrFilter({ type: 'not', child: subFilter });
      }
    } else {
      this.addOrFilter({
        type: 'not',
        child: { type: 'cmp', colName: colOrCb, op: op!, value },
      });
    }
    return this;
  }

  whereNull(colName: string): this {
    this.filters.push({ type: 'null', colName, isNull: true });
    return this;
  }

  whereNotNull(colName: string): this {
    this.filters.push({ type: 'null', colName, isNull: false });
    return this;
  }

  orWhereNull(colName: string): this {
    this.addOrFilter({ type: 'null', colName, isNull: true });
    return this;
  }

  orWhereNotNull(colName: string): this {
    this.addOrFilter({ type: 'null', colName, isNull: false });
    return this;
  }

  getFilters(): QueryFilter[] {
    return this.filters;
  }

  getRootFilter(): QueryFilter | null {
    if (this.filters.length === 0) return null;
    if (this.filters.length === 1) return this.filters[0];
    return { type: 'and', children: [...this.filters] };
  }

  private addOrFilter(filter: QueryFilter): void {
    if (this.filters.length === 0) {
      this.filters.push(filter);
      return;
    }
    if (
      this.filters.length === 1 &&
      this.filters[0].type === 'or' &&
      this.filters[0].children
    ) {
      this.filters[0].children.push(filter);
      return;
    }
    let prev: QueryFilter;
    if (this.filters.length === 1) {
      prev = this.filters[0];
    } else {
      prev = { type: 'and', children: [...this.filters] };
    }
    this.filters = [{ type: 'or', children: [prev, filter] }];
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  offset(count: number): this {
    this.offsetCount = count;
    return this;
  }

  orderBy(
    colOrKeys: string | SortKey | SortKey[],
    direction: 'asc' | 'desc' = 'asc',
    nullOrder?: 'nulls_first' | 'nulls_last',
  ): this {
    if (typeof colOrKeys === 'string') {
      this.sortCol = colOrKeys;
      this.sortDir = direction;
      this.orderKeys.push({ colName: colOrKeys, direction, nullOrder });
    } else if (Array.isArray(colOrKeys)) {
      this.orderKeys.push(...colOrKeys);
    } else {
      this.orderKeys.push(colOrKeys);
    }
    return this;
  }

  groupBy(...columns: string[]): this {
    this.groupCols.push(...columns);
    return this;
  }

  aggregate(aggregates: AggExpr[]): this {
    this.aggExprs.push(...aggregates);
    return this;
  }

  count(colName?: string, alias?: string): this {
    this.aggExprs.push({ func: 'count', colName, alias });
    return this;
  }

  sum(colName: string, alias?: string): this {
    this.aggExprs.push({ func: 'sum', colName, alias });
    return this;
  }

  avg(colName: string, alias?: string): this {
    this.aggExprs.push({ func: 'avg', colName, alias });
    return this;
  }

  min(colName: string, alias?: string): this {
    this.aggExprs.push({ func: 'min', colName, alias });
    return this;
  }

  max(colName: string, alias?: string): this {
    this.aggExprs.push({ func: 'max', colName, alias });
    return this;
  }

  select(...columns: (string | SelectColumnSpec | Record<string, any>)[]): this;
  select(columns: (string | SelectColumnSpec | Record<string, any>)[]): this;
  select(columnsMap: Record<string, any>): this;
  select(
    first?:
      | string
      | SelectColumnSpec
      | (string | SelectColumnSpec | Record<string, any>)[]
      | Record<string, any>,
    ...rest: (string | SelectColumnSpec | Record<string, any>)[]
  ): this {
    if (first === undefined) return this;

    const fields: NormalizedSelectField[] = [];
    fields.push(...normalizeSelectItem(first));
    for (const r of rest) {
      fields.push(...normalizeSelectItem(r));
    }
    this.selectFields.push(...fields);

    // Auto-register aggregate functions into aggExprs if present
    for (const f of fields) {
      if (typeof f.fn === 'string') {
        const fn = f.fn.toLowerCase();
        if (['count', 'sum', 'avg', 'min', 'max'].includes(fn)) {
          const already = this.aggExprs.some((a) => a.alias === f.alias);
          if (!already) {
            this.aggExprs.push({
              func: fn as AggFunc,
              colName: f.sourceCol === '*' ? undefined : f.sourceCol,
              alias: f.alias,
            });
          }
        }
      }
    }

    return this;
  }

  getSelectFields(): NormalizedSelectField[] {
    return this.selectFields;
  }

  private projectRow(row: DbRow): DbRow {
    const projected: DbRow = {};
    for (const field of this.selectFields) {
      const sourceCol = field.sourceCol;
      const targetAlias = field.alias;

      let val: any;
      if (sourceCol !== undefined) {
        val = row[sourceCol];
      } else {
        if (row[targetAlias] !== undefined) {
          val = row[targetAlias];
        }
      }

      if (field.fn) {
        if (typeof field.fn === 'function') {
          val = field.fn(val, row);
        } else {
          const fn = field.fn.toLowerCase();
          if (fn === 'upper') {
            val =
              val !== null && val !== undefined
                ? String(val).toUpperCase()
                : null;
          } else if (fn === 'lower') {
            val =
              val !== null && val !== undefined
                ? String(val).toLowerCase()
                : null;
          } else if (fn === 'length') {
            val =
              val !== null && val !== undefined ? String(val).length : null;
          } else if (fn === 'substr') {
            if (val === null || val === undefined) {
              val = null;
            } else {
              const start = (field.args?.[0] ?? 1) - 1;
              const len = field.args?.[1];
              val =
                len !== undefined
                  ? String(val).substring(start, start + len)
                  : String(val).substring(start);
            }
          } else if (fn === 'round') {
            val =
              val !== null && val !== undefined
                ? Math.round(Number(val))
                : null;
          } else if (fn === 'floor') {
            val =
              val !== null && val !== undefined
                ? Math.floor(Number(val))
                : null;
          } else if (fn === 'ceil') {
            val =
              val !== null && val !== undefined ? Math.ceil(Number(val)) : null;
          } else if (fn === 'abs') {
            val =
              val !== null && val !== undefined ? Math.abs(Number(val)) : null;
          } else if (fn === 'trim') {
            val = val !== null && val !== undefined ? String(val).trim() : null;
          } else if (['count', 'sum', 'avg', 'min', 'max'].includes(fn)) {
            if (val === undefined && row[field.alias] !== undefined) {
              val = row[field.alias];
            }
          }
        }
      }

      if (val === undefined && row[targetAlias] !== undefined) {
        val = row[targetAlias];
      }

      projected[targetAlias] = val !== undefined ? val : null;
    }
    return projected;
  }

  async explain(): Promise<ExplainOutput> {
    return this.db.explainQuery(this.tableName, this.filters, {
      orderBy: this.orderKeys.length > 0 ? this.orderKeys : undefined,
      groupBy: this.groupCols.length > 0 ? this.groupCols : undefined,
      aggregates: this.aggExprs.length > 0 ? this.aggExprs : undefined,
      select: this.selectFields.length > 0 ? this.selectFields : undefined,
      limit: this.limitCount !== null ? this.limitCount : undefined,
      offset: this.offsetCount !== null ? this.offsetCount : undefined,
    });
  }

  async toArray(): Promise<DbRow[]> {
    const rawRows = await this.db.executeQuery(this.tableName, this.filters, {
      limit: this.limitCount,
      offset: this.offsetCount,
      sortCol: this.sortCol,
      sortDir: this.sortDir,
      orderBy: this.orderKeys.length > 0 ? this.orderKeys : undefined,
      groupBy: this.groupCols.length > 0 ? this.groupCols : undefined,
      aggregates: this.aggExprs.length > 0 ? this.aggExprs : undefined,
      select: this.selectFields.length > 0 ? this.selectFields : undefined,
    });

    if (this.selectFields.length === 0) {
      return rawRows;
    }

    return rawRows.map((r) => this.projectRow(r));
  }

  async first(): Promise<DbRow | null> {
    const rows = await this.limit(1).toArray();
    return rows.length > 0 ? rows[0] : null;
  }
}
