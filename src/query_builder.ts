import { DbRow } from './types.js';
import {
  ComparisonOp,
  QueryFilter,
  DisassembledInstruction,
} from './engine/compiler.js';

export interface ExplainOutput {
  plan: {
    table: string;
    rootPageId: number;
    scanType: 'TableScan';
    filters: QueryFilter[];
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
}

export interface IDatabaseQueryExecutor {
  explainQuery(tableName: string, filters: QueryFilter[]): Promise<ExplainOutput>;
  executeQuery(
    tableName: string,
    filters: QueryFilter[],
    options: QueryExecutionOptions
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

  orderBy(colName: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.sortCol = colName;
    this.sortDir = direction;
    return this;
  }

  async explain(): Promise<ExplainOutput> {
    return this.db.explainQuery(this.tableName, this.filters);
  }

  async toArray(): Promise<DbRow[]> {
    return this.db.executeQuery(this.tableName, this.filters, {
      limit: this.limitCount,
      offset: this.offsetCount,
      sortCol: this.sortCol,
      sortDir: this.sortDir,
    });
  }

  async first(): Promise<DbRow | null> {
    const rows = await this.limit(1).toArray();
    return rows.length > 0 ? rows[0] : null;
  }
}
