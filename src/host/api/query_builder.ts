import { DbRow } from '../../types/index.js';
import {
  ComparisonOp,
  QueryFilter,
  SortKey,
  AggExpr,
  DisassembledInstruction,
} from '../compiler/compiler.js';

export interface ExplainOutput {
  plan: {
    table: string;
    rootPageId: number;
    scanType: 'TableScan';
    filters: QueryFilter[];
    orderBy?: SortKey[];
    groupBy?: string[];
    aggregates?: AggExpr[];
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
}

export interface IDatabaseQueryExecutor {
  explainQuery(
    tableName: string,
    filters: QueryFilter[],
    options?: {
      orderBy?: SortKey[];
      groupBy?: string[];
      aggregates?: AggExpr[];
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

  where(colName: string, op: ComparisonOp, value: any): this {
    this.filters.push({ type: 'cmp', colName, op, value });
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

  async explain(): Promise<ExplainOutput> {
    return this.db.explainQuery(this.tableName, this.filters, {
      orderBy: this.orderKeys.length > 0 ? this.orderKeys : undefined,
      groupBy: this.groupCols.length > 0 ? this.groupCols : undefined,
      aggregates: this.aggExprs.length > 0 ? this.aggExprs : undefined,
    });
  }

  async toArray(): Promise<DbRow[]> {
    return this.db.executeQuery(this.tableName, this.filters, {
      limit: this.limitCount,
      offset: this.offsetCount,
      sortCol: this.sortCol,
      sortDir: this.sortDir,
      orderBy: this.orderKeys.length > 0 ? this.orderKeys : undefined,
      groupBy: this.groupCols.length > 0 ? this.groupCols : undefined,
      aggregates: this.aggExprs.length > 0 ? this.aggExprs : undefined,
    });
  }

  async first(): Promise<DbRow | null> {
    const rows = await this.limit(1).toArray();
    return rows.length > 0 ? rows[0] : null;
  }
}
