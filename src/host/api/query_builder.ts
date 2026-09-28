import {
  DbRow,
  AggregateNotAllowedInWhereError,
} from '../../types/index.js';
import {
  ComparisonOp,
  QueryFilter,
  SortKey,
  AggExpr,
  AggFunc,
  DisassembledInstruction,
} from '../compiler/compiler.js';
import {
  ExprNode,
  ParsedSelectExpr,
  parseSelectExpr,
  parseExpression,
  evalExprNode,
  validateClause,
  isAggregateFunction,
  ExpressionBuilder,
  deriveDefaultAlias,
} from '../compiler/expr_parser.js';

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
  | 'abs';

export interface SelectColumnSpec {
  col: string;
  as: string;
}

export interface NormalizedSelectField {
  sourceCol?: string;
  alias: string;
  fn?: SelectFunction | string;
  args?: any[];
  expr?: ExprNode;
}

export type SelectItem =
  | string
  | SelectColumnSpec
  | Record<string, string>
  | ExpressionBuilder
  | ParsedSelectExpr;

export function normalizeSelectItem(item: any): NormalizedSelectField[] {
  if (!item) return [];

  if (Array.isArray(item)) {
    const fields: NormalizedSelectField[] = [];
    for (const sub of item) {
      fields.push(...normalizeSelectItem(sub));
    }
    return fields;
  }

  if (
    item instanceof ExpressionBuilder ||
    (typeof item === 'object' && item !== null && 'node' in item)
  ) {
    const expr: ExprNode = item.node;
    const alias = deriveDefaultAlias(expr);
    return [
      {
        alias,
        expr,
        sourceCol:
          expr.type === 'col' && expr.name !== '*' ? expr.name : undefined,
        fn: expr.type === 'fn' ? expr.name : undefined,
      },
    ];
  }

  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (!trimmed) return [];

    const parsed = parseSelectExpr(trimmed);
    return [
      {
        alias: parsed.alias,
        expr: parsed.expr,
        sourceCol:
          parsed.expr.type === 'col' && parsed.expr.name !== '*'
            ? parsed.expr.name
            : undefined,
        fn: parsed.expr.type === 'fn' ? parsed.expr.name : undefined,
      },
    ];
  }

  if (typeof item === 'object' && item !== null) {
    if ('expr' in item && 'alias' in item) {
      const expr: ExprNode = item.expr;
      return [
        {
          alias: item.alias,
          expr,
          sourceCol:
            expr.type === 'col' && expr.name !== '*' ? expr.name : undefined,
          fn: expr.type === 'fn' ? expr.name : undefined,
        },
      ];
    }

    // SelectColumnSpec: { col: string; as: string }
    if (
      'col' in item &&
      'as' in item &&
      typeof item.col === 'string' &&
      typeof item.as === 'string'
    ) {
      const parsed = parseSelectExpr(`${item.col} as ${item.as}`);
      return [
        {
          sourceCol: item.col === '*' ? undefined : item.col,
          alias: item.as,
          expr: parsed.expr,
          fn: parsed.expr.type === 'fn' ? parsed.expr.name : undefined,
        },
      ];
    }

    // Key-value dictionary: strictly {[col]: alias}
    const fields: NormalizedSelectField[] = [];
    for (const [col, val] of Object.entries(item)) {
      if (typeof val === 'string') {
        const parsed = parseSelectExpr(`${col} as ${val}`);
        fields.push({
          sourceCol: col === '*' ? undefined : col,
          alias: val,
          expr: parsed.expr,
          fn: parsed.expr.type === 'fn' ? parsed.expr.name : undefined,
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
  selectExprs?: ParsedSelectExpr[];
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
      selectExprs?: ParsedSelectExpr[];
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

function assertNotAggregateInWhere(colOrExpr: any): void {
  if (typeof colOrExpr === 'string') {
    const trimmed = colOrExpr.trim();
    if (isAggregateFunction(trimmed)) {
      throw new AggregateNotAllowedInWhereError(trimmed);
    }
    if (trimmed.includes('(')) {
      try {
        const expr = parseExpression(trimmed);
        validateClause(expr, 'where');
      } catch (e) {
        if (e instanceof AggregateNotAllowedInWhereError) {
          throw e;
        }
      }
    }
  } else if (
    colOrExpr instanceof ExpressionBuilder ||
    (typeof colOrExpr === 'object' && colOrExpr !== null && 'node' in colOrExpr)
  ) {
    validateClause(colOrExpr.node, 'where');
  } else if (
    typeof colOrExpr === 'object' &&
    colOrExpr !== null &&
    'type' in colOrExpr
  ) {
    validateClause(colOrExpr as ExprNode, 'where');
  }
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

  where(exprSql: string): this;
  where(expr: ExprNode | ExpressionBuilder): this;
  where(colName: string, op: ComparisonOp, value: any): this;
  where(callback: (qb: QueryBuilder) => void): this;
  where(
    colOrCbOrExpr:
      | string
      | ((qb: QueryBuilder) => void)
      | ExprNode
      | ExpressionBuilder,
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCbOrExpr === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCbOrExpr(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.filters.push(subFilter);
      }
    } else if (op === undefined && value === undefined) {
      if (typeof colOrCbOrExpr === 'string') {
        assertNotAggregateInWhere(colOrCbOrExpr);
        const expr = parseExpression(colOrCbOrExpr);
        this.filters.push({ type: 'expr', expr });
      } else if (
        colOrCbOrExpr instanceof ExpressionBuilder ||
        (typeof colOrCbOrExpr === 'object' &&
          colOrCbOrExpr !== null &&
          'node' in colOrCbOrExpr)
      ) {
        assertNotAggregateInWhere(colOrCbOrExpr);
        this.filters.push({
          type: 'expr',
          expr: (colOrCbOrExpr as any).node,
        });
      } else if (
        typeof colOrCbOrExpr === 'object' &&
        colOrCbOrExpr !== null &&
        'type' in colOrCbOrExpr
      ) {
        assertNotAggregateInWhere(colOrCbOrExpr);
        this.filters.push({ type: 'expr', expr: colOrCbOrExpr as ExprNode });
      }
    } else {
      assertNotAggregateInWhere(colOrCbOrExpr);
      assertNotAggregateInWhere(value);
      this.filters.push({
        type: 'cmp',
        colName: colOrCbOrExpr as string,
        op: op!,
        value,
      });
    }
    return this;
  }

  orWhere(exprSql: string): this;
  orWhere(expr: ExprNode | ExpressionBuilder): this;
  orWhere(colName: string, op: ComparisonOp, value: any): this;
  orWhere(callback: (qb: QueryBuilder) => void): this;
  orWhere(
    colOrCbOrExpr:
      | string
      | ((qb: QueryBuilder) => void)
      | ExprNode
      | ExpressionBuilder,
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCbOrExpr === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCbOrExpr(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.addOrFilter(subFilter);
      }
    } else if (op === undefined && value === undefined) {
      if (typeof colOrCbOrExpr === 'string') {
        assertNotAggregateInWhere(colOrCbOrExpr);
        const expr = parseExpression(colOrCbOrExpr);
        this.addOrFilter({ type: 'expr', expr });
      } else if (
        colOrCbOrExpr instanceof ExpressionBuilder ||
        (typeof colOrCbOrExpr === 'object' &&
          colOrCbOrExpr !== null &&
          'node' in colOrCbOrExpr)
      ) {
        assertNotAggregateInWhere(colOrCbOrExpr);
        this.addOrFilter({
          type: 'expr',
          expr: (colOrCbOrExpr as any).node,
        });
      } else if (
        typeof colOrCbOrExpr === 'object' &&
        colOrCbOrExpr !== null &&
        'type' in colOrCbOrExpr
      ) {
        assertNotAggregateInWhere(colOrCbOrExpr);
        this.addOrFilter({ type: 'expr', expr: colOrCbOrExpr as ExprNode });
      }
    } else {
      assertNotAggregateInWhere(colOrCbOrExpr);
      assertNotAggregateInWhere(value);
      this.addOrFilter({
        type: 'cmp',
        colName: colOrCbOrExpr as string,
        op: op!,
        value,
      });
    }
    return this;
  }

  whereNot(exprSql: string): this;
  whereNot(expr: ExprNode | ExpressionBuilder): this;
  whereNot(colName: string, op: ComparisonOp, value: any): this;
  whereNot(callback: (qb: QueryBuilder) => void): this;
  whereNot(
    colOrCbOrExpr:
      | string
      | ((qb: QueryBuilder) => void)
      | ExprNode
      | ExpressionBuilder,
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCbOrExpr === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCbOrExpr(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.filters.push({ type: 'not', child: subFilter });
      }
    } else if (op === undefined && value === undefined) {
      if (typeof colOrCbOrExpr === 'string') {
        assertNotAggregateInWhere(colOrCbOrExpr);
        const expr = parseExpression(colOrCbOrExpr);
        this.filters.push({ type: 'not', child: { type: 'expr', expr } });
      } else if (
        colOrCbOrExpr instanceof ExpressionBuilder ||
        (typeof colOrCbOrExpr === 'object' &&
          colOrCbOrExpr !== null &&
          'node' in colOrCbOrExpr)
      ) {
        assertNotAggregateInWhere(colOrCbOrExpr);
        this.filters.push({
          type: 'not',
          child: { type: 'expr', expr: (colOrCbOrExpr as any).node },
        });
      } else if (
        typeof colOrCbOrExpr === 'object' &&
        colOrCbOrExpr !== null &&
        'type' in colOrCbOrExpr
      ) {
        assertNotAggregateInWhere(colOrCbOrExpr);
        this.filters.push({
          type: 'not',
          child: { type: 'expr', expr: colOrCbOrExpr as ExprNode },
        });
      }
    } else {
      assertNotAggregateInWhere(colOrCbOrExpr);
      assertNotAggregateInWhere(value);
      this.filters.push({
        type: 'not',
        child: {
          type: 'cmp',
          colName: colOrCbOrExpr as string,
          op: op!,
          value,
        },
      });
    }
    return this;
  }

  orWhereNot(exprSql: string): this;
  orWhereNot(expr: ExprNode | ExpressionBuilder): this;
  orWhereNot(colName: string, op: ComparisonOp, value: any): this;
  orWhereNot(callback: (qb: QueryBuilder) => void): this;
  orWhereNot(
    colOrCbOrExpr:
      | string
      | ((qb: QueryBuilder) => void)
      | ExprNode
      | ExpressionBuilder,
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCbOrExpr === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCbOrExpr(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.addOrFilter({ type: 'not', child: subFilter });
      }
    } else if (op === undefined && value === undefined) {
      if (typeof colOrCbOrExpr === 'string') {
        assertNotAggregateInWhere(colOrCbOrExpr);
        const expr = parseExpression(colOrCbOrExpr);
        this.addOrFilter({ type: 'not', child: { type: 'expr', expr } });
      } else if (
        colOrCbOrExpr instanceof ExpressionBuilder ||
        (typeof colOrCbOrExpr === 'object' &&
          colOrCbOrExpr !== null &&
          'node' in colOrCbOrExpr)
      ) {
        assertNotAggregateInWhere(colOrCbOrExpr);
        this.addOrFilter({
          type: 'not',
          child: { type: 'expr', expr: (colOrCbOrExpr as any).node },
        });
      } else if (
        typeof colOrCbOrExpr === 'object' &&
        colOrCbOrExpr !== null &&
        'type' in colOrCbOrExpr
      ) {
        assertNotAggregateInWhere(colOrCbOrExpr);
        this.addOrFilter({
          type: 'not',
          child: { type: 'expr', expr: colOrCbOrExpr as ExprNode },
        });
      }
    } else {
      assertNotAggregateInWhere(colOrCbOrExpr);
      assertNotAggregateInWhere(value);
      this.addOrFilter({
        type: 'not',
        child: {
          type: 'cmp',
          colName: colOrCbOrExpr as string,
          op: op!,
          value,
        },
      });
    }
    return this;
  }

  whereNull(colName: string): this {
    assertNotAggregateInWhere(colName);
    this.filters.push({ type: 'null', colName, isNull: true });
    return this;
  }

  whereNotNull(colName: string): this {
    assertNotAggregateInWhere(colName);
    this.filters.push({ type: 'null', colName, isNull: false });
    return this;
  }

  orWhereNull(colName: string): this {
    assertNotAggregateInWhere(colName);
    this.addOrFilter({ type: 'null', colName, isNull: true });
    return this;
  }

  orWhereNotNull(colName: string): this {
    assertNotAggregateInWhere(colName);
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

  select(...columns: SelectItem[]): this;
  select(columns: SelectItem[]): this;
  select(columnsMap: Record<string, string>): this;
  select(
    first?: SelectItem | SelectItem[],
    ...rest: SelectItem[]
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
      if (f.expr && f.expr.type === 'fn') {
        const fnName = f.expr.name.toLowerCase();
        if (isAggregateFunction(fnName)) {
          const already = this.aggExprs.some((a) => a.alias === f.alias);
          if (!already) {
            const arg0 = f.expr.args[0];
            const colName =
              arg0 && arg0.type === 'col' && arg0.name !== '*'
                ? arg0.name
                : undefined;
            this.aggExprs.push({
              func: fnName as AggFunc,
              colName,
              alias: f.alias,
            });
          }
        }
      } else if (typeof f.fn === 'string') {
        const fnName = f.fn.toLowerCase();
        if (isAggregateFunction(fnName)) {
          const already = this.aggExprs.some((a) => a.alias === f.alias);
          if (!already) {
            this.aggExprs.push({
              func: fnName as AggFunc,
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
    // Fast-path: If rawRows was already projected by VDBE OP_RESULT_ROW,
    // the row contains exactly the target aliases.
    const keys = Object.keys(row);
    if (
      this.selectFields.length > 0 &&
      keys.length === this.selectFields.length &&
      this.selectFields.every((f) => f.alias in row)
    ) {
      return row;
    }

    const projected: DbRow = {};
    for (const field of this.selectFields) {
      const targetAlias = field.alias;
      if (
        field.expr &&
        field.expr.type === 'fn' &&
        isAggregateFunction(field.expr.name) &&
        row[targetAlias] !== undefined
      ) {
        projected[targetAlias] = row[targetAlias];
      } else if (field.expr) {
        let udfs: any;
        if (typeof (this.db as any).getUdf === 'function') {
          udfs = (name: string) => (this.db as any).getUdf(name)?.def?.call;
        }
        projected[targetAlias] = evalExprNode(field.expr, row, udfs);
      } else if (
        field.sourceCol !== undefined &&
        row[field.sourceCol] !== undefined
      ) {
        projected[targetAlias] = row[field.sourceCol];
      } else if (row[targetAlias] !== undefined) {
        projected[targetAlias] = row[targetAlias];
      } else {
        projected[targetAlias] = null;
      }
    }
    return projected;
  }

  async explain(): Promise<ExplainOutput> {
    const selectExprs: ParsedSelectExpr[] = this.selectFields.map((f) => ({
      expr: f.expr ?? { type: 'col', name: f.sourceCol ?? f.alias },
      alias: f.alias,
    }));

    return this.db.explainQuery(this.tableName, this.filters, {
      orderBy: this.orderKeys.length > 0 ? this.orderKeys : undefined,
      groupBy: this.groupCols.length > 0 ? this.groupCols : undefined,
      aggregates: this.aggExprs.length > 0 ? this.aggExprs : undefined,
      select: this.selectFields.length > 0 ? this.selectFields : undefined,
      selectExprs: selectExprs.length > 0 ? selectExprs : undefined,
      limit: this.limitCount !== null ? this.limitCount : undefined,
      offset: this.offsetCount !== null ? this.offsetCount : undefined,
    });
  }

  async toArray(): Promise<DbRow[]> {
    const selectExprs: ParsedSelectExpr[] = this.selectFields.map((f) => ({
      expr: f.expr ?? { type: 'col', name: f.sourceCol ?? f.alias },
      alias: f.alias,
    }));

    const rawRows = await this.db.executeQuery(this.tableName, this.filters, {
      limit: this.limitCount,
      offset: this.offsetCount,
      sortCol: this.sortCol,
      sortDir: this.sortDir,
      orderBy: this.orderKeys.length > 0 ? this.orderKeys : undefined,
      groupBy: this.groupCols.length > 0 ? this.groupCols : undefined,
      aggregates: this.aggExprs.length > 0 ? this.aggExprs : undefined,
      select: this.selectFields.length > 0 ? this.selectFields : undefined,
      selectExprs: selectExprs.length > 0 ? selectExprs : undefined,
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
