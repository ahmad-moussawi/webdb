import {
  DbRow,
  AggregateNotAllowedInWhereError,
  SubqueryNestingTooDeepError,
  JoinType,
  TransactionOptions,
} from '../../types/index.js';
import { MAX_IN_LIST_SIZE } from '../../constants.js';
import {
  ComparisonOp,
  QueryFilter,
  SortKey,
  GroupKey,
  AggExpr,
  AggFunc,
  DisassembledInstruction,
} from '../compiler/compiler.js';
import {
  QueryPlanner,
} from '../compiler/planner/index.js';
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
import {
  notifyLiveQueryTableRead,
  getActiveLiveQueryTracker,
  trackLiveQueryPromise,
  liveQuery,
  type LiveQueryController,
  type LiveQueryOptions,
  type LiveQueryState,
} from './live_query.js';

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

export interface SubquerySelectSpec {
  subquery: QueryBuilder;
  as: string;
}

export function isQueryBuilder(val: any): val is QueryBuilder {
  return (
    val instanceof QueryBuilder ||
    (typeof val === 'object' &&
      val !== null &&
      typeof val.toArray === 'function' &&
      typeof val.where === 'function' &&
      typeof val.select === 'function' &&
      'filters' in val)
  );
}

export interface NormalizedSelectField {
  sourceCol?: string;
  alias: string;
  fn?: SelectFunction | string;
  args?: any[];
  expr?: ExprNode;
  subquery?: QueryBuilder;
}

export type SelectItem =
  | string
  | SelectColumnSpec
  | SubquerySelectSpec
  | QueryBuilder
  | Record<string, string | QueryBuilder | SubquerySelectSpec | ExpressionBuilder | ExprNode>
  | ExpressionBuilder
  | ParsedSelectExpr;

export function parseFilterTarget(
  target: string | ExprNode | ExpressionBuilder,
): { colName?: string; expr?: ExprNode } {
  if (
    target instanceof ExpressionBuilder ||
    (typeof target === 'object' && target !== null && 'node' in target)
  ) {
    return { expr: (target as any).node };
  }
  if (typeof target === 'object' && target !== null && 'type' in target) {
    return { expr: target as ExprNode };
  }
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (
      trimmed.includes('(') ||
      trimmed.includes('+') ||
      trimmed.includes('-') ||
      trimmed.includes('*') ||
      trimmed.includes('/') ||
      trimmed.includes('%')
    ) {
      return { expr: parseExpression(trimmed), colName: trimmed };
    }
    return { colName: trimmed };
  }
  return {};
}

export type GroupByItem = string | ExprNode | ExpressionBuilder;

export function extractAggregatesFromExpr(expr: ExprNode): AggExpr[] {
  const aggs: AggExpr[] = [];
  function walk(node: ExprNode) {
    if (node.type === 'fn') {
      const fnName = node.name.toLowerCase();
      if (isAggregateFunction(fnName)) {
        const arg0 = node.args[0];
        const colName =
          arg0 && arg0.type === 'col' && arg0.name !== '*'
            ? arg0.name
            : undefined;
        aggs.push({
          func: fnName as AggFunc,
          colName,
        });
      }
      for (const arg of node.args) {
        walk(arg);
      }
    } else if (node.type === 'binary') {
      walk(node.left);
      walk(node.right);
    }
  }
  walk(expr);
  return aggs;
}

export function normalizeSelectItem(item: any): NormalizedSelectField[] {
  if (!item) return [];

  if (Array.isArray(item)) {
    const fields: NormalizedSelectField[] = [];
    for (const sub of item) {
      fields.push(...normalizeSelectItem(sub));
    }
    return fields;
  }

  if (isQueryBuilder(item)) {
    const subFields = item.getSelectFields();
    const subAggs = item.getAggregates();
    const defaultAlias =
      subFields.length > 0
        ? subFields[0].alias
        : subAggs.length > 0
          ? subAggs[0].alias ??
            (subAggs[0].colName
              ? `${subAggs[0].func}_${subAggs[0].colName}`
              : subAggs[0].func)
          : 'subquery';
    return [
      {
        alias: defaultAlias,
        subquery: item,
      },
    ];
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
    if (
      'subquery' in item &&
      'as' in item &&
      isQueryBuilder(item.subquery) &&
      typeof item.as === 'string'
    ) {
      return [
        {
          alias: item.as,
          subquery: item.subquery,
        },
      ];
    }

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

    // Key-value dictionary: {[col]: alias} or {[alias]: subquery | expr}
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
      } else if (isQueryBuilder(val)) {
        fields.push({
          alias: col,
          subquery: val,
        });
      } else if (
        typeof val === 'object' &&
        val !== null &&
        'subquery' in val &&
        isQueryBuilder((val as any).subquery)
      ) {
        fields.push({
          alias: col,
          subquery: (val as any).subquery,
        });
      } else if (
        val instanceof ExpressionBuilder ||
        (typeof val === 'object' && val !== null && 'node' in val)
      ) {
        const expr: ExprNode = (val as any).node;
        fields.push({
          alias: col,
          expr,
          sourceCol:
            expr.type === 'col' && expr.name !== '*' ? expr.name : undefined,
          fn: expr.type === 'fn' ? expr.name : undefined,
        });
      } else if (
        typeof val === 'object' &&
        val !== null &&
        'type' in val
      ) {
        const expr = val as ExprNode;
        fields.push({
          alias: col,
          expr,
          sourceCol:
            expr.type === 'col' && expr.name !== '*' ? expr.name : undefined,
          fn: expr.type === 'fn' ? expr.name : undefined,
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
    scanType: 'TableScan' | 'IndexScan';
    indexName?: string;
    filters: QueryFilter[];
    orderBy?: SortKey[];
    groupBy?: (string | GroupKey)[];
    aggregates?: AggExpr[];
    having?: QueryFilter[];
    select?: NormalizedSelectField[];
    joins?: JoinClause[];
    limit?: number;
    offset?: number;
    estimatedCost?: number;
    estimatedRows?: number;
    joinOrder?: string[];
    isOrderSatisfied?: boolean;
    sortCostAvoided?: number;
  };
  bytecodeSize: number;
  instructions: DisassembledInstruction[];
  assembly: string;
}

export interface JoinClause {
  type: JoinType;
  table: string;
  leftCol: string;
  op: ComparisonOp;
  rightCol: string;
  scanType?: 'TableScan' | 'IndexScan';
  indexName?: string;
}

export interface QueryExecutionOptions {
  limit: number | null;
  offset: number | null;
  sortCol: string | null;
  sortDir: 'asc' | 'desc';
  orderBy?: SortKey[];
  groupBy?: (string | GroupKey)[];
  aggregates?: AggExpr[];
  having?: QueryFilter[];
  select?: NormalizedSelectField[];
  selectExprs?: ParsedSelectExpr[];
  joins?: JoinClause[];
  planner?: QueryPlanner;
}

export interface IDatabaseQueryExecutor {
  explainQuery(
    tableName: string,
    filters: QueryFilter[],
    options?: {
      orderBy?: SortKey[];
      groupBy?: (string | GroupKey)[];
      aggregates?: AggExpr[];
      having?: QueryFilter[];
      select?: NormalizedSelectField[];
      selectExprs?: ParsedSelectExpr[];
      joins?: JoinClause[];
      limit?: number;
      offset?: number;
      planner?: QueryPlanner;
    },
  ): Promise<ExplainOutput>;
  executeQuery(
    tableName: string,
    filters: QueryFilter[],
    options: QueryExecutionOptions,
  ): Promise<DbRow[]>;
  executeUpdate?(
    tableName: string,
    filters: QueryFilter[],
    patch: Partial<DbRow>,
    options?: TransactionOptions,
  ): Promise<number>;
  executeDelete?(
    tableName: string,
    filters: QueryFilter[],
    options?: TransactionOptions,
  ): Promise<number>;
}

function assertNotAggregateInWhere(colOrExpr: any): void {
  if (isQueryBuilder(colOrExpr)) {
    return;
  }
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
  private sourceSubquery?: QueryBuilder;
  private filters: QueryFilter[] = [];
  private selectFields: NormalizedSelectField[] = [];
  private limitCount: number | null = null;
  private offsetCount: number | null = null;
  private sortCol: string | null = null;
  private sortDir: 'asc' | 'desc' = 'asc';
  private orderKeys: SortKey[] = [];
  private groupCols: string[] = [];
  private groupKeys: GroupKey[] = [];
  private aggExprs: AggExpr[] = [];
  private havingFilters: QueryFilter[] = [];
  private joins: JoinClause[] = [];
  private planner?: QueryPlanner;

  withPlanner(planner: QueryPlanner): this {
    this.planner = planner;
    return this;
  }

  constructor(db: IDatabaseQueryExecutor, tableOrSubquery: string | QueryBuilder) {
    this.db = db;
    if (isQueryBuilder(tableOrSubquery)) {
      this.sourceSubquery = tableOrSubquery;
      this.tableName = '__subquery__';
      this.assertSubqueryDepth();
      notifyLiveQueryTableRead(this.db, tableOrSubquery.getReferencedTables());
    } else {
      this.tableName = tableOrSubquery;
      notifyLiveQueryTableRead(this.db, tableOrSubquery);
    }
  }

  as(alias: string): SubquerySelectSpec {
    return { subquery: this, as: alias };
  }

  getDb(): IDatabaseQueryExecutor {
    return this.db;
  }

  getTableName(): string {
    return this.tableName;
  }

  getReferencedTables(): string[] {
    const tables = new Set<string>();
    const collectFromQb = (qb: QueryBuilder | undefined) => {
      if (!qb) return;
      if (qb.tableName && qb.tableName !== '__subquery__') {
        tables.add(qb.tableName);
      }
      if (qb.sourceSubquery) {
        collectFromQb(qb.sourceSubquery);
      }
      for (const j of qb.joins) {
        if (j.table) tables.add(j.table);
      }
      for (const f of qb.selectFields) {
        if (f.subquery && isQueryBuilder(f.subquery)) {
          collectFromQb(f.subquery);
        }
      }
      const collectFromFilter = (filter: QueryFilter | undefined) => {
        if (!filter) return;
        if (filter.subquery && isQueryBuilder(filter.subquery)) {
          collectFromQb(filter.subquery);
        }
        if (filter.value && isQueryBuilder(filter.value)) {
          collectFromQb(filter.value);
        }
        if (filter.child) {
          collectFromFilter(filter.child);
        }
        if (filter.children) {
          for (const c of filter.children) {
            collectFromFilter(c);
          }
        }
      };
      for (const f of qb.filters) collectFromFilter(f);
      for (const f of qb.havingFilters) collectFromFilter(f);
    };
    collectFromQb(this);
    return Array.from(tables);
  }

  getSourceSubquery(): QueryBuilder | undefined {
    return this.sourceSubquery;
  }

  getAggregates(): AggExpr[] {
    return this.aggExprs;
  }

  private getFilterSubqueryDepth(filter: QueryFilter): number {
    let max = 0;
    if (filter.subquery && isQueryBuilder(filter.subquery)) {
      max = Math.max(max, 1 + filter.subquery.getMaxSubqueryDepth());
    }
    if (filter.value && isQueryBuilder(filter.value)) {
      max = Math.max(max, 1 + filter.value.getMaxSubqueryDepth());
    }
    if (filter.child) {
      max = Math.max(max, this.getFilterSubqueryDepth(filter.child));
    }
    if (filter.children) {
      for (const child of filter.children) {
        max = Math.max(max, this.getFilterSubqueryDepth(child));
      }
    }
    return max;
  }

  getMaxSubqueryDepth(): number {
    let max = 0;
    if (this.sourceSubquery) {
      max = Math.max(max, 1 + this.sourceSubquery.getMaxSubqueryDepth());
    }
    for (const f of this.selectFields) {
      if (f.subquery) {
        max = Math.max(max, 1 + f.subquery.getMaxSubqueryDepth());
      }
    }
    for (const f of this.filters) {
      max = Math.max(max, this.getFilterSubqueryDepth(f));
    }
    for (const f of this.havingFilters) {
      max = Math.max(max, this.getFilterSubqueryDepth(f));
    }
    return max;
  }

  private assertSubqueryDepth(): void {
    const depth = this.getMaxSubqueryDepth();
    if (depth > 7) {
      throw new SubqueryNestingTooDeepError(depth, 7);
    }
  }

  join(
    table: string,
    leftCol: string,
    rightCol: string,
  ): this;
  join(
    table: string,
    leftCol: string,
    op: ComparisonOp,
    rightCol: string,
  ): this;
  join(
    table: string,
    leftCol: string,
    opOrRightCol: string,
    rightCol?: string,
  ): this {
    const op = (rightCol !== undefined ? opOrRightCol : '=') as ComparisonOp;
    const rCol = rightCol !== undefined ? rightCol : opOrRightCol;
    this.joins.push({
      type: 'inner',
      table,
      leftCol,
      op,
      rightCol: rCol,
    });
    notifyLiveQueryTableRead(this.db, table);
    return this;
  }

  innerJoin(
    table: string,
    leftCol: string,
    rightCol: string,
  ): this;
  innerJoin(
    table: string,
    leftCol: string,
    op: ComparisonOp,
    rightCol: string,
  ): this;
  innerJoin(
    table: string,
    leftCol: string,
    opOrRightCol: string,
    rightCol?: string,
  ): this {
    return this.join(table, leftCol, opOrRightCol as any, rightCol as any);
  }

  leftJoin(
    table: string,
    leftCol: string,
    rightCol: string,
  ): this;
  leftJoin(
    table: string,
    leftCol: string,
    op: ComparisonOp,
    rightCol: string,
  ): this;
  leftJoin(
    table: string,
    leftCol: string,
    opOrRightCol: string,
    rightCol?: string,
  ): this {
    const op = (rightCol !== undefined ? opOrRightCol : '=') as ComparisonOp;
    const rCol = rightCol !== undefined ? rightCol : opOrRightCol;
    this.joins.push({
      type: 'left',
      table,
      leftCol,
      op,
      rightCol: rCol,
    });
    notifyLiveQueryTableRead(this.db, table);
    return this;
  }

  getJoins(): JoinClause[] {
    return this.joins;
  }

  where(exprSql: string): this;
  where(expr: ExprNode | ExpressionBuilder): this;
  where(record: Record<string, any>): this;
  where(
    colOrExpr: string | ExprNode | ExpressionBuilder,
    op: ComparisonOp,
    value: any,
  ): this;
  where(callback: (qb: QueryBuilder) => void): this;
  where(
    colOrCbOrExpr:
      | string
      | ((qb: QueryBuilder) => void)
      | ExprNode
      | ExpressionBuilder
      | Record<string, any>,
    op?: ComparisonOp,
    value?: any,
  ): this {
    if (typeof colOrCbOrExpr === 'function') {
      const sub = new QueryBuilder(this.db, this.tableName);
      colOrCbOrExpr(sub);
      const subFilter = sub.getRootFilter();
      if (subFilter) {
        this.filters.push(subFilter);
        this.assertSubqueryDepth();
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
      } else if (typeof colOrCbOrExpr === 'object' && colOrCbOrExpr !== null) {
        for (const [k, v] of Object.entries(colOrCbOrExpr)) {
          this.where(k, '=', v);
        }
      }
    } else {
      assertNotAggregateInWhere(colOrCbOrExpr);
      assertNotAggregateInWhere(value);
      if (typeof op === 'string' && op.trim().toLowerCase() === 'in') {
        return this.whereIn(colOrCbOrExpr as string, value);
      }
      if (typeof op === 'string' && op.trim().toLowerCase() === 'not in') {
        return this.whereNotIn(colOrCbOrExpr as string, value);
      }
      const target = parseFilterTarget(colOrCbOrExpr as any);
      if (isQueryBuilder(value)) {
        this.filters.push({
          type: 'cmp',
          colName: target.colName,
          expr: target.expr,
          op: op!,
          value,
          subquery: value,
        });
        this.assertSubqueryDepth();
      } else {
        this.filters.push({
          type: 'cmp',
          colName: target.colName,
          expr: target.expr,
          op: op!,
          value,
        });
      }
    }
    return this;
  }

  orWhere(exprSql: string): this;
  orWhere(expr: ExprNode | ExpressionBuilder): this;
  orWhere(
    colOrExpr: string | ExprNode | ExpressionBuilder,
    op: ComparisonOp,
    value: any,
  ): this;
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
        this.assertSubqueryDepth();
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
      if (typeof op === 'string' && op.trim().toLowerCase() === 'in') {
        return this.orWhereIn(colOrCbOrExpr as string, value);
      }
      if (typeof op === 'string' && op.trim().toLowerCase() === 'not in') {
        return this.orWhereNotIn(colOrCbOrExpr as string, value);
      }
      const target = parseFilterTarget(colOrCbOrExpr);
      if (isQueryBuilder(value)) {
        this.addOrFilter({
          type: 'cmp',
          colName: target.colName,
          expr: target.expr,
          op: op!,
          value,
          subquery: value,
        });
        this.assertSubqueryDepth();
      } else {
        this.addOrFilter({
          type: 'cmp',
          colName: target.colName,
          expr: target.expr,
          op: op!,
          value,
        });
      }
    }
    return this;
  }

  whereNot(exprSql: string): this;
  whereNot(expr: ExprNode | ExpressionBuilder): this;
  whereNot(
    colOrExpr: string | ExprNode | ExpressionBuilder,
    op: ComparisonOp,
    value: any,
  ): this;
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
        this.assertSubqueryDepth();
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
      if (typeof op === 'string' && op.trim().toLowerCase() === 'in') {
        return this.whereNotIn(colOrCbOrExpr as string, value);
      }
      if (typeof op === 'string' && op.trim().toLowerCase() === 'not in') {
        return this.whereIn(colOrCbOrExpr as string, value);
      }
      const target = parseFilterTarget(colOrCbOrExpr);
      this.filters.push({
        type: 'not',
        child: {
          type: 'cmp',
          colName: target.colName,
          expr: target.expr,
          op: op!,
          value,
          subquery: isQueryBuilder(value) ? value : undefined,
        },
      });
      if (isQueryBuilder(value)) {
        this.assertSubqueryDepth();
      }
    }
    return this;
  }

  orWhereNot(exprSql: string): this;
  orWhereNot(expr: ExprNode | ExpressionBuilder): this;
  orWhereNot(
    colOrExpr: string | ExprNode | ExpressionBuilder,
    op: ComparisonOp,
    value: any,
  ): this;
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
        this.assertSubqueryDepth();
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
      if (typeof op === 'string' && op.trim().toLowerCase() === 'in') {
        return this.orWhereNotIn(colOrCbOrExpr as string, value);
      }
      if (typeof op === 'string' && op.trim().toLowerCase() === 'not in') {
        return this.orWhereIn(colOrCbOrExpr as string, value);
      }
      const target = parseFilterTarget(colOrCbOrExpr);
      this.addOrFilter({
        type: 'not',
        child: {
          type: 'cmp',
          colName: target.colName,
          expr: target.expr,
          op: op!,
          value,
          subquery: isQueryBuilder(value) ? value : undefined,
        },
      });
      if (isQueryBuilder(value)) {
        this.assertSubqueryDepth();
      }
    }
    return this;
  }

  whereRaw(sqlStr: string): this {
    return this.where(sqlStr);
  }

  orWhereRaw(sqlStr: string): this {
    return this.orWhere(sqlStr);
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

  whereLike(colName: string, pattern: string): this {
    return this.where(colName, 'like', pattern);
  }

  whereNotLike(colName: string, pattern: string): this {
    return this.where(colName, 'not like', pattern);
  }

  whereStartsWith(colName: string, prefix: string): this {
    return this.where(colName, 'starts_with', prefix);
  }

  whereEndsWith(colName: string, suffix: string): this {
    return this.where(colName, 'ends_with', suffix);
  }

  whereContains(colName: string, substring: string): this {
    return this.where(colName, 'contains', substring);
  }

  orWhereLike(colName: string, pattern: string): this {
    return this.orWhere(colName, 'like', pattern);
  }

  orWhereNotLike(colName: string, pattern: string): this {
    return this.orWhere(colName, 'not like', pattern);
  }

  orWhereStartsWith(colName: string, prefix: string): this {
    return this.orWhere(colName, 'starts_with', prefix);
  }

  orWhereEndsWith(colName: string, suffix: string): this {
    return this.orWhere(colName, 'ends_with', suffix);
  }

  orWhereContains(colName: string, substring: string): this {
    return this.orWhere(colName, 'contains', substring);
  }

  whereIn(colName: string | ExprNode | ExpressionBuilder, values: any[] | QueryBuilder): this {
    assertNotAggregateInWhere(colName);
    const target = parseFilterTarget(colName);
    if (isQueryBuilder(values)) {
      this.filters.push({
        type: 'in',
        colName: target.colName,
        expr: target.expr,
        subquery: values,
        notIn: false,
      });
      this.assertSubqueryDepth();
      return this;
    }
    if (!Array.isArray(values)) {
      throw new TypeError(`WebDB: whereIn requires an array of values`);
    }
    if (values.length > MAX_IN_LIST_SIZE) {
      throw new RangeError(
        `WebDB: whereIn list exceeds maximum limit of ${MAX_IN_LIST_SIZE} elements`,
      );
    }
    this.filters.push({
      type: 'in',
      colName: target.colName,
      expr: target.expr,
      values,
      notIn: false,
    });
    return this;
  }

  whereNotIn(colName: string | ExprNode | ExpressionBuilder, values: any[] | QueryBuilder): this {
    assertNotAggregateInWhere(colName);
    const target = parseFilterTarget(colName);
    if (isQueryBuilder(values)) {
      this.filters.push({
        type: 'in',
        colName: target.colName,
        expr: target.expr,
        subquery: values,
        notIn: true,
      });
      this.assertSubqueryDepth();
      return this;
    }
    if (!Array.isArray(values)) {
      throw new TypeError(`WebDB: whereNotIn requires an array of values`);
    }
    if (values.length > MAX_IN_LIST_SIZE) {
      throw new RangeError(
        `WebDB: whereNotIn list exceeds maximum limit of ${MAX_IN_LIST_SIZE} elements`,
      );
    }
    this.filters.push({
      type: 'in',
      colName: target.colName,
      expr: target.expr,
      values,
      notIn: true,
    });
    return this;
  }

  orWhereIn(colName: string | ExprNode | ExpressionBuilder, values: any[] | QueryBuilder): this {
    assertNotAggregateInWhere(colName);
    const target = parseFilterTarget(colName);
    if (isQueryBuilder(values)) {
      this.addOrFilter({
        type: 'in',
        colName: target.colName,
        expr: target.expr,
        subquery: values,
        notIn: false,
      });
      this.assertSubqueryDepth();
      return this;
    }
    if (!Array.isArray(values)) {
      throw new TypeError(`WebDB: orWhereIn requires an array of values`);
    }
    if (values.length > MAX_IN_LIST_SIZE) {
      throw new RangeError(
        `WebDB: orWhereIn list exceeds maximum limit of ${MAX_IN_LIST_SIZE} elements`,
      );
    }
    this.addOrFilter({
      type: 'in',
      colName: target.colName,
      expr: target.expr,
      values,
      notIn: false,
    });
    return this;
  }

  orWhereNotIn(colName: string | ExprNode | ExpressionBuilder, values: any[] | QueryBuilder): this {
    assertNotAggregateInWhere(colName);
    const target = parseFilterTarget(colName);
    if (isQueryBuilder(values)) {
      this.addOrFilter({
        type: 'in',
        colName: target.colName,
        expr: target.expr,
        subquery: values,
        notIn: true,
      });
      this.assertSubqueryDepth();
      return this;
    }
    if (!Array.isArray(values)) {
      throw new TypeError(`WebDB: orWhereNotIn requires an array of values`);
    }
    if (values.length > MAX_IN_LIST_SIZE) {
      throw new RangeError(
        `WebDB: orWhereNotIn list exceeds maximum limit of ${MAX_IN_LIST_SIZE} elements`,
      );
    }
    this.addOrFilter({
      type: 'in',
      colName: target.colName,
      expr: target.expr,
      values,
      notIn: true,
    });
    return this;
  }

  whereExists(subquery: QueryBuilder): this {
    if (!isQueryBuilder(subquery)) {
      throw new TypeError('WebDB: whereExists requires a QueryBuilder subquery');
    }
    this.filters.push({
      type: 'exists',
      subquery,
      notExists: false,
    });
    this.assertSubqueryDepth();
    return this;
  }

  whereNotExists(subquery: QueryBuilder): this {
    if (!isQueryBuilder(subquery)) {
      throw new TypeError('WebDB: whereNotExists requires a QueryBuilder subquery');
    }
    this.filters.push({
      type: 'exists',
      subquery,
      notExists: true,
    });
    this.assertSubqueryDepth();
    return this;
  }

  orWhereExists(subquery: QueryBuilder): this {
    if (!isQueryBuilder(subquery)) {
      throw new TypeError('WebDB: orWhereExists requires a QueryBuilder subquery');
    }
    this.addOrFilter({
      type: 'exists',
      subquery,
      notExists: false,
    });
    this.assertSubqueryDepth();
    return this;
  }

  orWhereNotExists(subquery: QueryBuilder): this {
    if (!isQueryBuilder(subquery)) {
      throw new TypeError('WebDB: orWhereNotExists requires a QueryBuilder subquery');
    }
    this.addOrFilter({
      type: 'exists',
      subquery,
      notExists: true,
    });
    this.assertSubqueryDepth();
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
    colOrKeys: string | SortKey | SortKey[] | ExpressionBuilder | ExprNode,
    direction: 'asc' | 'desc' = 'asc',
    nullOrder?: 'nulls_first' | 'nulls_last',
  ): this {
    if (typeof colOrKeys === 'string') {
      this.sortCol = colOrKeys;
      this.sortDir = direction;
      const target = parseFilterTarget(colOrKeys);
      this.orderKeys.push({
        colName: target.colName ?? colOrKeys,
        expr: target.expr,
        direction,
        nullOrder,
      });
    } else if (
      colOrKeys instanceof ExpressionBuilder ||
      (typeof colOrKeys === 'object' && colOrKeys !== null && 'node' in colOrKeys)
    ) {
      this.orderKeys.push({
        expr: (colOrKeys as any).node,
        direction,
        nullOrder,
      });
    } else if (
      typeof colOrKeys === 'object' &&
      colOrKeys !== null &&
      'type' in colOrKeys
    ) {
      this.orderKeys.push({
        expr: colOrKeys as ExprNode,
        direction,
        nullOrder,
      });
    } else if (Array.isArray(colOrKeys)) {
      for (const item of colOrKeys) {
        if (typeof item === 'string') {
          const target = parseFilterTarget(item);
          this.orderKeys.push({
            colName: target.colName ?? item,
            expr: target.expr,
            direction: 'asc',
          });
        } else {
          this.orderKeys.push(item);
        }
      }
    } else {
      this.orderKeys.push(colOrKeys);
    }
    return this;
  }

  groupBy(...columns: (GroupByItem | GroupByItem[])[]): this {
    for (const item of columns) {
      if (Array.isArray(item)) {
        for (const sub of item) {
          this.addGroupByItem(sub);
        }
      } else {
        this.addGroupByItem(item);
      }
    }
    return this;
  }

  private addGroupByItem(item: GroupByItem): void {
    if (
      item instanceof ExpressionBuilder ||
      (typeof item === 'object' && item !== null && 'node' in item)
    ) {
      this.groupKeys.push({ expr: (item as any).node });
      this.groupCols.push(deriveDefaultAlias((item as any).node));
    } else if (
      typeof item === 'object' &&
      item !== null &&
      'type' in item
    ) {
      this.groupKeys.push({ expr: item as ExprNode });
      this.groupCols.push(deriveDefaultAlias(item as ExprNode));
    } else if (typeof item === 'string') {
      const target = parseFilterTarget(item);
      this.groupKeys.push({
        colName: target.colName ?? item,
        expr: target.expr,
      });
      this.groupCols.push(item);
    }
  }

  private registerAggregatesFromFilter(filter: QueryFilter): void {
    const checkTarget = (colName?: string, expr?: ExprNode) => {
      if (expr) {
        const aggs = extractAggregatesFromExpr(expr);
        for (const agg of aggs) {
          const already = this.aggExprs.some(
            (a) =>
              a.func === agg.func &&
              (a.colName === agg.colName ||
                (a.colName === undefined && agg.colName === undefined)),
          );
          if (!already) {
            this.aggExprs.push(agg);
          }
        }
      } else if (colName && colName.includes('(')) {
        try {
          const parsed = parseExpression(colName);
          const aggs = extractAggregatesFromExpr(parsed);
          for (const agg of aggs) {
            const already = this.aggExprs.some(
              (a) =>
                a.func === agg.func &&
                (a.colName === agg.colName ||
                  (a.colName === undefined && agg.colName === undefined)),
            );
            if (!already) {
              this.aggExprs.push(agg);
            }
          }
        } catch {
          // ignore unparseable
        }
      }
    };

    if (filter.type === 'cmp') {
      checkTarget(filter.colName, filter.expr);
    } else if (filter.type === 'expr' && filter.expr) {
      checkTarget(undefined, filter.expr);
    } else if (filter.type === 'null') {
      checkTarget(filter.colName, filter.expr);
    } else if (filter.type === 'not' && filter.child) {
      this.registerAggregatesFromFilter(filter.child);
    } else if (
      (filter.type === 'and' || filter.type === 'or') &&
      filter.children
    ) {
      for (const child of filter.children) {
        this.registerAggregatesFromFilter(child);
      }
    }
  }

  having(exprSql: string): this;
  having(expr: ExprNode | ExpressionBuilder): this;
  having(
    colOrExpr: string | ExprNode | ExpressionBuilder,
    op: ComparisonOp,
    value: any,
  ): this;
  having(callback: (qb: QueryBuilder) => void): this;
  having(
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
      const subFilter = sub.getRootHavingFilter();
      if (subFilter) {
        this.havingFilters.push(subFilter);
        this.registerAggregatesFromFilter(subFilter);
        this.assertSubqueryDepth();
      }
    } else if (op === undefined && value === undefined) {
      if (typeof colOrCbOrExpr === 'string') {
        const expr = parseExpression(colOrCbOrExpr);
        const filter: QueryFilter = { type: 'expr', expr };
        this.havingFilters.push(filter);
        this.registerAggregatesFromFilter(filter);
      } else if (
        colOrCbOrExpr instanceof ExpressionBuilder ||
        (typeof colOrCbOrExpr === 'object' &&
          colOrCbOrExpr !== null &&
          'node' in colOrCbOrExpr)
      ) {
        const filter: QueryFilter = {
          type: 'expr',
          expr: (colOrCbOrExpr as any).node,
        };
        this.havingFilters.push(filter);
        this.registerAggregatesFromFilter(filter);
      } else if (
        typeof colOrCbOrExpr === 'object' &&
        colOrCbOrExpr !== null &&
        'type' in colOrCbOrExpr
      ) {
        const filter: QueryFilter = {
          type: 'expr',
          expr: colOrCbOrExpr as ExprNode,
        };
        this.havingFilters.push(filter);
        this.registerAggregatesFromFilter(filter);
      }
    } else {
      const target = parseFilterTarget(colOrCbOrExpr);
      if (typeof op === 'string' && (op.trim().toLowerCase() === 'in' || op.trim().toLowerCase() === 'not in')) {
        const notIn = op.trim().toLowerCase() === 'not in';
        const filter: QueryFilter = isQueryBuilder(value)
          ? {
              type: 'in',
              colName: target.colName,
              expr: target.expr,
              subquery: value,
              notIn,
            }
          : {
              type: 'in',
              colName: target.colName,
              expr: target.expr,
              values: value,
              notIn,
            };
        this.havingFilters.push(filter);
        this.registerAggregatesFromFilter(filter);
        this.assertSubqueryDepth();
        return this;
      }
      const filter: QueryFilter = {
        type: 'cmp',
        colName: target.colName,
        expr: target.expr,
        op: op!,
        value,
        subquery: isQueryBuilder(value) ? value : undefined,
      };
      this.havingFilters.push(filter);
      this.registerAggregatesFromFilter(filter);
      if (isQueryBuilder(value)) {
        this.assertSubqueryDepth();
      }
    }
    return this;
  }

  orHaving(exprSql: string): this;
  orHaving(expr: ExprNode | ExpressionBuilder): this;
  orHaving(
    colOrExpr: string | ExprNode | ExpressionBuilder,
    op: ComparisonOp,
    value: any,
  ): this;
  orHaving(callback: (qb: QueryBuilder) => void): this;
  orHaving(
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
      const subFilter = sub.getRootHavingFilter();
      if (subFilter) {
        this.addHavingOrFilter(subFilter);
        this.registerAggregatesFromFilter(subFilter);
        this.assertSubqueryDepth();
      }
    } else if (op === undefined && value === undefined) {
      if (typeof colOrCbOrExpr === 'string') {
        const expr = parseExpression(colOrCbOrExpr);
        const filter: QueryFilter = { type: 'expr', expr };
        this.addHavingOrFilter(filter);
        this.registerAggregatesFromFilter(filter);
      } else if (
        colOrCbOrExpr instanceof ExpressionBuilder ||
        (typeof colOrCbOrExpr === 'object' &&
          colOrCbOrExpr !== null &&
          'node' in colOrCbOrExpr)
      ) {
        const filter: QueryFilter = {
          type: 'expr',
          expr: (colOrCbOrExpr as any).node,
        };
        this.addHavingOrFilter(filter);
        this.registerAggregatesFromFilter(filter);
      } else if (
        typeof colOrCbOrExpr === 'object' &&
        colOrCbOrExpr !== null &&
        'type' in colOrCbOrExpr
      ) {
        const filter: QueryFilter = {
          type: 'expr',
          expr: colOrCbOrExpr as ExprNode,
        };
        this.addHavingOrFilter(filter);
        this.registerAggregatesFromFilter(filter);
      }
    } else {
      const target = parseFilterTarget(colOrCbOrExpr);
      const filter: QueryFilter = {
        type: 'cmp',
        colName: target.colName,
        expr: target.expr,
        op: op!,
        value,
        subquery: isQueryBuilder(value) ? value : undefined,
      };
      this.addHavingOrFilter(filter);
      this.registerAggregatesFromFilter(filter);
      if (isQueryBuilder(value)) {
        this.assertSubqueryDepth();
      }
    }
    return this;
  }

  havingNot(exprSql: string): this;
  havingNot(expr: ExprNode | ExpressionBuilder): this;
  havingNot(
    colOrExpr: string | ExprNode | ExpressionBuilder,
    op: ComparisonOp,
    value: any,
  ): this;
  havingNot(callback: (qb: QueryBuilder) => void): this;
  havingNot(
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
      const subFilter = sub.getRootHavingFilter();
      if (subFilter) {
        const filter: QueryFilter = { type: 'not', child: subFilter };
        this.havingFilters.push(filter);
        this.registerAggregatesFromFilter(filter);
        this.assertSubqueryDepth();
      }
    } else if (op === undefined && value === undefined) {
      if (typeof colOrCbOrExpr === 'string') {
        const expr = parseExpression(colOrCbOrExpr);
        const filter: QueryFilter = {
          type: 'not',
          child: { type: 'expr', expr },
        };
        this.havingFilters.push(filter);
        this.registerAggregatesFromFilter(filter);
      } else if (
        colOrCbOrExpr instanceof ExpressionBuilder ||
        (typeof colOrCbOrExpr === 'object' &&
          colOrCbOrExpr !== null &&
          'node' in colOrCbOrExpr)
      ) {
        const filter: QueryFilter = {
          type: 'not',
          child: { type: 'expr', expr: (colOrCbOrExpr as any).node },
        };
        this.havingFilters.push(filter);
        this.registerAggregatesFromFilter(filter);
      } else if (
        typeof colOrCbOrExpr === 'object' &&
        colOrCbOrExpr !== null &&
        'type' in colOrCbOrExpr
      ) {
        const filter: QueryFilter = {
          type: 'not',
          child: { type: 'expr', expr: colOrCbOrExpr as ExprNode },
        };
        this.havingFilters.push(filter);
        this.registerAggregatesFromFilter(filter);
      }
    } else {
      const target = parseFilterTarget(colOrCbOrExpr);
      const filter: QueryFilter = {
        type: 'not',
        child: {
          type: 'cmp',
          colName: target.colName,
          expr: target.expr,
          op: op!,
          value,
          subquery: isQueryBuilder(value) ? value : undefined,
        },
      };
      this.havingFilters.push(filter);
      this.registerAggregatesFromFilter(filter);
      if (isQueryBuilder(value)) {
        this.assertSubqueryDepth();
      }
    }
    return this;
  }

  orHavingNot(exprSql: string): this;
  orHavingNot(expr: ExprNode | ExpressionBuilder): this;
  orHavingNot(
    colOrExpr: string | ExprNode | ExpressionBuilder,
    op: ComparisonOp,
    value: any,
  ): this;
  orHavingNot(callback: (qb: QueryBuilder) => void): this;
  orHavingNot(
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
      const subFilter = sub.getRootHavingFilter();
      if (subFilter) {
        const filter: QueryFilter = { type: 'not', child: subFilter };
        this.addHavingOrFilter(filter);
        this.registerAggregatesFromFilter(filter);
        this.assertSubqueryDepth();
      }
    } else if (op === undefined && value === undefined) {
      if (typeof colOrCbOrExpr === 'string') {
        const expr = parseExpression(colOrCbOrExpr);
        const filter: QueryFilter = {
          type: 'not',
          child: { type: 'expr', expr },
        };
        this.addHavingOrFilter(filter);
        this.registerAggregatesFromFilter(filter);
      } else if (
        colOrCbOrExpr instanceof ExpressionBuilder ||
        (typeof colOrCbOrExpr === 'object' &&
          colOrCbOrExpr !== null &&
          'node' in colOrCbOrExpr)
      ) {
        const filter: QueryFilter = {
          type: 'not',
          child: { type: 'expr', expr: (colOrCbOrExpr as any).node },
        };
        this.addHavingOrFilter(filter);
        this.registerAggregatesFromFilter(filter);
      } else if (
        typeof colOrCbOrExpr === 'object' &&
        colOrCbOrExpr !== null &&
        'type' in colOrCbOrExpr
      ) {
        const filter: QueryFilter = {
          type: 'not',
          child: { type: 'expr', expr: colOrCbOrExpr as ExprNode },
        };
        this.addHavingOrFilter(filter);
        this.registerAggregatesFromFilter(filter);
      }
    } else {
      const target = parseFilterTarget(colOrCbOrExpr);
      const filter: QueryFilter = {
        type: 'not',
        child: {
          type: 'cmp',
          colName: target.colName,
          expr: target.expr,
          op: op!,
          value,
          subquery: isQueryBuilder(value) ? value : undefined,
        },
      };
      this.addHavingOrFilter(filter);
      this.registerAggregatesFromFilter(filter);
      if (isQueryBuilder(value)) {
        this.assertSubqueryDepth();
      }
    }
    return this;
  }

  havingRaw(sqlStr: string): this {
    return this.having(sqlStr);
  }

  orHavingRaw(sqlStr: string): this {
    return this.orHaving(sqlStr);
  }

  havingNull(colOrExpr: string | ExprNode | ExpressionBuilder): this {
    const target = parseFilterTarget(colOrExpr);
    const filter: QueryFilter = {
      type: 'null',
      colName: target.colName,
      expr: target.expr,
      isNull: true,
    };
    this.havingFilters.push(filter);
    this.registerAggregatesFromFilter(filter);
    return this;
  }

  havingNotNull(colOrExpr: string | ExprNode | ExpressionBuilder): this {
    const target = parseFilterTarget(colOrExpr);
    const filter: QueryFilter = {
      type: 'null',
      colName: target.colName,
      expr: target.expr,
      isNull: false,
    };
    this.havingFilters.push(filter);
    this.registerAggregatesFromFilter(filter);
    return this;
  }

  orHavingNull(colOrExpr: string | ExprNode | ExpressionBuilder): this {
    const target = parseFilterTarget(colOrExpr);
    const filter: QueryFilter = {
      type: 'null',
      colName: target.colName,
      expr: target.expr,
      isNull: true,
    };
    this.addHavingOrFilter(filter);
    this.registerAggregatesFromFilter(filter);
    return this;
  }

  orHavingNotNull(colOrExpr: string | ExprNode | ExpressionBuilder): this {
    const target = parseFilterTarget(colOrExpr);
    const filter: QueryFilter = {
      type: 'null',
      colName: target.colName,
      expr: target.expr,
      isNull: false,
    };
    this.addHavingOrFilter(filter);
    this.registerAggregatesFromFilter(filter);
    return this;
  }

  getHavingFilters(): QueryFilter[] {
    return this.havingFilters;
  }

  getRootHavingFilter(): QueryFilter | null {
    if (this.havingFilters.length === 0) return null;
    if (this.havingFilters.length === 1) return this.havingFilters[0];
    return { type: 'and', children: [...this.havingFilters] };
  }

  private addHavingOrFilter(filter: QueryFilter): void {
    if (this.havingFilters.length === 0) {
      this.havingFilters.push(filter);
      return;
    }
    if (
      this.havingFilters.length === 1 &&
      this.havingFilters[0].type === 'or' &&
      this.havingFilters[0].children
    ) {
      this.havingFilters[0].children.push(filter);
      return;
    }
    let prev: QueryFilter;
    if (this.havingFilters.length === 1) {
      prev = this.havingFilters[0];
    } else {
      prev = { type: 'and', children: [...this.havingFilters] };
    }
    this.havingFilters = [{ type: 'or', children: [prev, filter] }];
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
  select(
    columnsMap: Record<
      string,
      string | QueryBuilder | SubquerySelectSpec | ExpressionBuilder | ExprNode
    >,
  ): this;
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
    this.assertSubqueryDepth();

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

  clone(overrideDb?: IDatabaseQueryExecutor): QueryBuilder {
    const targetDb = overrideDb ?? this.db;
    const cloned = new QueryBuilder(
      targetDb,
      this.sourceSubquery ? this.sourceSubquery.clone(targetDb) : this.tableName,
    );
    const cloneFilter = (f: QueryFilter): QueryFilter => ({
      ...f,
      values: f.values ? [...f.values] : undefined,
      subquery: f.subquery && isQueryBuilder(f.subquery) ? f.subquery.clone(targetDb) : f.subquery,
      value: isQueryBuilder(f.value) ? f.value.clone(targetDb) : f.value,
      child: f.child ? cloneFilter(f.child) : undefined,
      children: f.children ? f.children.map(cloneFilter) : undefined,
    });
    cloned.filters = this.filters.map(cloneFilter);
    cloned.selectFields = this.selectFields.map((f) => ({
      ...f,
      args: f.args ? [...f.args] : undefined,
      subquery: f.subquery ? f.subquery.clone(targetDb) : undefined,
    }));
    cloned.limitCount = this.limitCount;
    cloned.offsetCount = this.offsetCount;
    cloned.sortCol = this.sortCol;
    cloned.sortDir = this.sortDir;
    cloned.orderKeys = this.orderKeys.map((k) => ({ ...k }));
    cloned.groupCols = [...this.groupCols];
    cloned.groupKeys = this.groupKeys.map((k) => ({ ...k }));
    cloned.aggExprs = this.aggExprs.map((a) => ({ ...a }));
    cloned.havingFilters = this.havingFilters.map(cloneFilter);
    cloned.joins = this.joins.map((j) => ({ ...j }));
    cloned.planner = this.planner;
    return cloned;
  }

  private cloneExprNode(expr: ExprNode): ExprNode {
    if (expr.type === 'binary') {
      return {
        ...expr,
        left: this.cloneExprNode(expr.left),
        right: this.cloneExprNode(expr.right),
      };
    }
    if (expr.type === 'fn') {
      return {
        ...expr,
        args: expr.args.map((a) => this.cloneExprNode(a)),
      };
    }
    return { ...expr };
  }

  private substituteExpr(
    expr: ExprNode,
    aliasMap: Map<string, ExprNode>,
  ): ExprNode {
    if (expr.type === 'col') {
      if (expr.name === '*') return expr;
      const shortName = expr.name.includes('.')
        ? expr.name.slice(expr.name.lastIndexOf('.') + 1)
        : expr.name;
      const mapped = aliasMap.get(expr.name) ?? aliasMap.get(shortName);
      if (mapped) {
        return this.cloneExprNode(mapped);
      }
      return { ...expr };
    }
    if (expr.type === 'binary') {
      return {
        ...expr,
        left: this.substituteExpr(expr.left, aliasMap),
        right: this.substituteExpr(expr.right, aliasMap),
      };
    }
    if (expr.type === 'fn') {
      return {
        ...expr,
        args: expr.args.map((a) => this.substituteExpr(a, aliasMap)),
      };
    }
    return { ...expr };
  }

  private substituteColOrExpr(
    colName: string | undefined,
    expr: ExprNode | undefined,
    aliasMap: Map<string, ExprNode>,
  ): { colName?: string; expr?: ExprNode } {
    if (expr) {
      const sub = this.substituteExpr(expr, aliasMap);
      if (sub.type === 'col') {
        return { colName: sub.name, expr: sub };
      }
      return { expr: sub };
    }
    if (colName) {
      const shortName = colName.includes('.')
        ? colName.slice(colName.lastIndexOf('.') + 1)
        : colName;
      const mapped = aliasMap.get(colName) ?? aliasMap.get(shortName);
      if (mapped) {
        const cloned = this.cloneExprNode(mapped);
        if (cloned.type === 'col') {
          return { colName: cloned.name };
        }
        return { expr: cloned };
      }
      return { colName };
    }
    return { colName, expr };
  }

  private substituteFilter(
    filter: QueryFilter,
    aliasMap: Map<string, ExprNode>,
  ): QueryFilter {
    if (filter.type === 'and' || filter.type === 'or') {
      return {
        ...filter,
        children: filter.children?.map((c) => this.substituteFilter(c, aliasMap)),
      };
    }
    if (filter.type === 'not' && filter.child) {
      return {
        ...filter,
        child: this.substituteFilter(filter.child, aliasMap),
      };
    }
    if (filter.type === 'exists') {
      return { ...filter };
    }
    const subTarget = this.substituteColOrExpr(
      filter.colName,
      filter.expr,
      aliasMap,
    );
    return {
      ...filter,
      colName: subTarget.colName,
      expr: subTarget.expr,
    };
  }

  /**
   * Attempts to flatten a derived table subquery (`db.from(subquery)`) into a
   * single-table QueryBuilder by substituting outer column references with inner
   * expressions and merging WHERE predicates.
   */
  tryFlatten(): QueryBuilder | null {
    if (!this.sourceSubquery) {
      return null;
    }

    const inner =
      this.sourceSubquery.tryFlatten() ?? this.sourceSubquery.clone(this.db);

    if (
      inner.sourceSubquery ||
      inner.groupKeys.length > 0 ||
      inner.groupCols.length > 0 ||
      inner.aggExprs.length > 0 ||
      inner.havingFilters.length > 0 ||
      inner.limitCount !== null ||
      inner.offsetCount !== null ||
      inner.joins.length > 0 ||
      inner.selectFields.some((f) => f.subquery) ||
      this.joins.length > 0
    ) {
      return null;
    }

    const aliasMap = new Map<string, ExprNode>();
    for (const f of inner.selectFields) {
      const expr: ExprNode =
        f.expr ?? { type: 'col', name: f.sourceCol ?? f.alias };
      aliasMap.set(f.alias, expr);
    }

    // Verify that any outer aggregate or groupBy references a simple column
    for (const agg of this.aggExprs) {
      if (agg.colName) {
        const shortName = agg.colName.includes('.')
          ? agg.colName.slice(agg.colName.lastIndexOf('.') + 1)
          : agg.colName;
        const mapped = aliasMap.get(agg.colName) ?? aliasMap.get(shortName);
        if (mapped && mapped.type !== 'col') {
          return null;
        }
      }
    }
    for (const gk of this.groupKeys) {
      const subTarget = this.substituteColOrExpr(gk.colName, gk.expr, aliasMap);
      if (!subTarget.colName && subTarget.expr && subTarget.expr.type !== 'col') {
        return null;
      }
    }

    const flattened = new QueryBuilder(this.db, inner.tableName);
    flattened.planner = this.planner ?? inner.planner;
    flattened.filters = [
      ...inner.filters.map((f) => ({ ...f })),
      ...this.filters.map((f) => this.substituteFilter(f, aliasMap)),
    ];

    if (this.selectFields.length > 0) {
      flattened.selectFields = this.selectFields.map((f) => {
        if (f.subquery) {
          return { ...f, subquery: f.subquery.clone(this.db) };
        }
        const rawExpr: ExprNode =
          f.expr ?? { type: 'col', name: f.sourceCol ?? f.alias };
        const subExpr = this.substituteExpr(rawExpr, aliasMap);
        return {
          alias: f.alias,
          expr: subExpr,
          sourceCol:
            subExpr.type === 'col' && subExpr.name !== '*'
              ? subExpr.name
              : undefined,
          fn: subExpr.type === 'fn' ? subExpr.name : undefined,
        };
      });
    } else if (inner.selectFields.length > 0) {
      flattened.selectFields = inner.selectFields.map((f) => ({ ...f }));
    }

    const hasOuterAggsOrGrouping =
      this.aggExprs.length > 0 ||
      this.groupKeys.length > 0 ||
      this.groupCols.length > 0;

    if (this.orderKeys.length > 0) {
      flattened.orderKeys = this.orderKeys.map((k) => {
        const subTarget = this.substituteColOrExpr(k.colName, k.expr, aliasMap);
        return {
          ...k,
          colName: subTarget.colName,
          expr: subTarget.expr,
        };
      });
      if (flattened.orderKeys[0]?.colName) {
        flattened.sortCol = flattened.orderKeys[0].colName!;
        flattened.sortDir = flattened.orderKeys[0].direction ?? 'asc';
      }
    } else if (!hasOuterAggsOrGrouping && inner.orderKeys.length > 0) {
      flattened.orderKeys = inner.orderKeys.map((k) => ({ ...k }));
      flattened.sortCol = inner.sortCol;
      flattened.sortDir = inner.sortDir;
    }

    flattened.groupKeys = this.groupKeys.map((gk) => {
      const subTarget = this.substituteColOrExpr(gk.colName, gk.expr, aliasMap);
      return {
        colName: subTarget.colName,
        expr: subTarget.expr,
      };
    });
    flattened.groupCols = this.groupCols.map((gc) => {
      const mapped = aliasMap.get(gc);
      return mapped && mapped.type === 'col' ? mapped.name : gc;
    });
    flattened.aggExprs = this.aggExprs.map((agg) => {
      if (agg.colName) {
        const mapped = aliasMap.get(agg.colName);
        if (mapped && mapped.type === 'col') {
          return { ...agg, colName: mapped.name };
        }
      }
      return { ...agg };
    });
    flattened.havingFilters = this.havingFilters.map((f) =>
      this.substituteFilter(f, aliasMap),
    );
    flattened.limitCount = this.limitCount;
    flattened.offsetCount = this.offsetCount;

    return flattened;
  }

  private exprReferencesOuter(
    expr: ExprNode | undefined,
    innerTables: Set<string>,
  ): boolean {
    if (!expr) return false;
    if (expr.type === 'col') {
      if (expr.name.includes('.')) {
        const prefix = expr.name.slice(0, expr.name.indexOf('.'));
        if (prefix === 'outer' || !innerTables.has(prefix)) {
          return true;
        }
      }
      return false;
    }
    if (expr.type === 'binary') {
      return (
        this.exprReferencesOuter(expr.left, innerTables) ||
        this.exprReferencesOuter(expr.right, innerTables)
      );
    }
    if (expr.type === 'fn') {
      return expr.args.some((a) => this.exprReferencesOuter(a, innerTables));
    }
    return false;
  }

  private filterIsCorrelatedWithOuter(
    filter: QueryFilter,
    innerTables: Set<string>,
  ): boolean {
    if (filter.type === 'and' || filter.type === 'or') {
      return (
        filter.children?.some((c) =>
          this.filterIsCorrelatedWithOuter(c, innerTables),
        ) ?? false
      );
    }
    if (filter.type === 'not' && filter.child) {
      return this.filterIsCorrelatedWithOuter(filter.child, innerTables);
    }
    if (filter.type === 'cmp') {
      if (
        filter.value instanceof ExpressionBuilder ||
        (typeof filter.value === 'object' &&
          filter.value !== null &&
          !isQueryBuilder(filter.value) &&
          ('node' in filter.value || 'type' in filter.value))
      ) {
        return true;
      }
      if (filter.subquery && isQueryBuilder(filter.subquery)) {
        if (this.isSubqueryCorrelated(filter.subquery)) return true;
      }
    }
    if (filter.type === 'in' || filter.type === 'exists') {
      if (filter.subquery && isQueryBuilder(filter.subquery)) {
        if (this.isSubqueryCorrelated(filter.subquery)) return true;
      }
    }
    if (filter.colName && filter.colName.includes('.')) {
      const prefix = filter.colName.slice(0, filter.colName.indexOf('.'));
      if (prefix === 'outer' || !innerTables.has(prefix)) {
        return true;
      }
    }
    if (this.exprReferencesOuter(filter.expr, innerTables)) {
      return true;
    }
    return false;
  }

  private isSubqueryCorrelated(sub: QueryBuilder): boolean {
    const innerTables = new Set<string>([sub.tableName]);
    for (const j of sub.joins) {
      innerTables.add(j.table);
    }
    if (
      sub.filters.some((f) => this.filterIsCorrelatedWithOuter(f, innerTables))
    ) {
      return true;
    }
    if (
      sub.havingFilters.some((f) =>
        this.filterIsCorrelatedWithOuter(f, innerTables),
      )
    ) {
      return true;
    }
    if (sub.sourceSubquery && this.isSubqueryCorrelated(sub.sourceSubquery)) {
      return true;
    }
    if (
      sub.selectFields.some(
        (f) => f.subquery && this.isSubqueryCorrelated(f.subquery),
      )
    ) {
      return true;
    }
    return false;
  }

  private filterContainsCorrelatedSubquery(filter: QueryFilter): boolean {
    if (filter.type === 'and' || filter.type === 'or') {
      return (
        filter.children?.some((c) =>
          this.filterContainsCorrelatedSubquery(c),
        ) ?? false
      );
    }
    if (filter.type === 'not' && filter.child) {
      return this.filterContainsCorrelatedSubquery(filter.child);
    }
    const sub =
      filter.subquery && isQueryBuilder(filter.subquery)
        ? filter.subquery
        : isQueryBuilder(filter.value)
          ? filter.value
          : undefined;
    if (sub && this.isSubqueryCorrelated(sub)) {
      return true;
    }
    return false;
  }

  private getRowValue(row: DbRow, colRef: string): any {
    if (colRef in row) return row[colRef];
    if (colRef.startsWith('outer.')) {
      const stripped = colRef.slice('outer.'.length);
      if (stripped in row) return row[stripped];
    }
    if (colRef.includes('.')) {
      const short = colRef.slice(colRef.lastIndexOf('.') + 1);
      if (short in row) return row[short];
    }
    return undefined;
  }

  private bindOuterRowToExpr(
    expr: ExprNode,
    outerRow: DbRow,
    innerTables: Set<string>,
    forceOuterResolution: boolean = false,
  ): ExprNode {
    if (expr.type === 'col') {
      if (forceOuterResolution) {
        return {
          type: 'literal',
          value: this.getRowValue(outerRow, expr.name) ?? null,
        };
      }
      if (expr.name.includes('.')) {
        const prefix = expr.name.slice(0, expr.name.indexOf('.'));
        if (prefix === 'outer' || !innerTables.has(prefix)) {
          return {
            type: 'literal',
            value: this.getRowValue(outerRow, expr.name) ?? null,
          };
        }
      }
      return { ...expr };
    }
    if (expr.type === 'binary') {
      return {
        ...expr,
        left: this.bindOuterRowToExpr(
          expr.left,
          outerRow,
          innerTables,
          forceOuterResolution,
        ),
        right: this.bindOuterRowToExpr(
          expr.right,
          outerRow,
          innerTables,
          forceOuterResolution,
        ),
      };
    }
    if (expr.type === 'fn') {
      return {
        ...expr,
        args: expr.args.map((a) =>
          this.bindOuterRowToExpr(
            a,
            outerRow,
            innerTables,
            forceOuterResolution,
          ),
        ),
      };
    }
    return { ...expr };
  }

  private bindOuterRowToFilter(
    filter: QueryFilter,
    outerRow: DbRow,
    innerTables: Set<string>,
  ): QueryFilter {
    if (filter.type === 'and' || filter.type === 'or') {
      return {
        ...filter,
        children: filter.children?.map((c) =>
          this.bindOuterRowToFilter(c, outerRow, innerTables),
        ),
      };
    }
    if (filter.type === 'not' && filter.child) {
      return {
        ...filter,
        child: this.bindOuterRowToFilter(filter.child, outerRow, innerTables),
      };
    }

    let boundExpr = filter.expr
      ? this.bindOuterRowToExpr(filter.expr, outerRow, innerTables, false)
      : undefined;

    if (filter.type === 'cmp') {
      if (
        filter.value instanceof ExpressionBuilder ||
        (typeof filter.value === 'object' &&
          filter.value !== null &&
          !isQueryBuilder(filter.value) &&
          ('node' in filter.value || 'type' in filter.value))
      ) {
        const valNode: ExprNode =
          'node' in filter.value ? filter.value.node : filter.value;
        const resolvedExpr = this.bindOuterRowToExpr(
          valNode,
          outerRow,
          innerTables,
          true,
        );
        let udfs: any;
        if (typeof (this.db as any).getUdf === 'function') {
          udfs = (name: string) => (this.db as any).getUdf(name)?.def?.call;
        }
        const outerVal = evalExprNode(resolvedExpr, outerRow, udfs);
        if (outerVal === null || outerVal === undefined) {
          return { type: 'in', values: [], notIn: false };
        }
        return {
          ...filter,
          expr: boundExpr,
          value: outerVal,
        };
      }
    }

    return {
      ...filter,
      expr: boundExpr,
      subquery:
        filter.subquery && isQueryBuilder(filter.subquery)
          ? this.bindOuterRowToSubquery(filter.subquery, outerRow)
          : filter.subquery,
    };
  }

  private bindOuterRowToSubquery(
    sub: QueryBuilder,
    outerRow: DbRow,
  ): QueryBuilder {
    const cloned = sub.clone(this.db);
    const innerTables = new Set<string>([cloned.tableName]);
    for (const j of cloned.joins) {
      innerTables.add(j.table);
    }
    cloned.filters = cloned.filters.map((f) =>
      this.bindOuterRowToFilter(f, outerRow, innerTables),
    );
    cloned.havingFilters = cloned.havingFilters.map((f) =>
      this.bindOuterRowToFilter(f, outerRow, innerTables),
    );
    if (cloned.sourceSubquery) {
      cloned.sourceSubquery = this.bindOuterRowToSubquery(
        cloned.sourceSubquery,
        outerRow,
      );
    }
    return cloned;
  }

  private async evalScalarSubquery(
    sub: QueryBuilder,
    outerRow?: DbRow,
  ): Promise<any> {
    const targetSub =
      outerRow && this.isSubqueryCorrelated(sub)
        ? this.bindOuterRowToSubquery(sub, outerRow)
        : sub.clone(this.db);
    const firstRow = await targetSub.first();
    if (!firstRow) return null;
    const keys = Object.keys(firstRow);
    return keys.length > 0 ? firstRow[keys[0]] : null;
  }

  private async resolveUncorrelatedFilter(
    filter: QueryFilter,
  ): Promise<QueryFilter> {
    if (filter.type === 'and' || filter.type === 'or') {
      const children: QueryFilter[] = [];
      for (const c of filter.children ?? []) {
        children.push(await this.resolveUncorrelatedFilter(c));
      }
      return { ...filter, children };
    }
    if (filter.type === 'not' && filter.child) {
      return {
        ...filter,
        child: await this.resolveUncorrelatedFilter(filter.child),
      };
    }

    if (
      filter.type === 'in' &&
      filter.subquery &&
      isQueryBuilder(filter.subquery)
    ) {
      if (!this.isSubqueryCorrelated(filter.subquery)) {
        const subRows = await filter.subquery.clone(this.db).toArray();
        const rawVals = subRows.map((r) => {
          const keys = Object.keys(r);
          return keys.length > 0 ? r[keys[0]] : null;
        });
        if (
          filter.notIn &&
          rawVals.some((v) => v === null || v === undefined)
        ) {
          // SQL 3VL: x NOT IN (..., NULL) is always UNKNOWN (FALSE in WHERE)
          return {
            type: 'in',
            colName: filter.colName,
            expr: filter.expr,
            values: [],
            notIn: false,
          };
        }
        const values = rawVals.filter((v) => v !== null && v !== undefined);
        if (values.length > MAX_IN_LIST_SIZE) {
          throw new RangeError(
            `WebDB: whereIn subquery result exceeds maximum limit of ${MAX_IN_LIST_SIZE} elements`,
          );
        }
        return {
          type: 'in',
          colName: filter.colName,
          expr: filter.expr,
          values,
          notIn: filter.notIn,
        };
      }
    }

    if (filter.type === 'exists' && filter.subquery && isQueryBuilder(filter.subquery)) {
      if (!this.isSubqueryCorrelated(filter.subquery)) {
        const firstRow = await filter.subquery.clone(this.db).first();
        const exists = firstRow !== null;
        const isTrue = filter.notExists ? !exists : exists;
        return {
          type: 'in',
          values: [],
          notIn: isTrue,
        };
      }
    }

    if (filter.type === 'cmp') {
      const sub =
        filter.subquery && isQueryBuilder(filter.subquery)
          ? filter.subquery
          : isQueryBuilder(filter.value)
            ? filter.value
            : undefined;
      if (sub && !this.isSubqueryCorrelated(sub)) {
        const scalarVal = await this.evalScalarSubquery(sub);
        if (scalarVal === null || scalarVal === undefined) {
          return {
            type: 'in',
            colName: filter.colName,
            expr: filter.expr,
            values: [],
            notIn: false,
          };
        }
        return {
          ...filter,
          value: scalarVal,
          subquery: undefined,
        };
      }
    }

    return filter;
  }

  private async resolveUncorrelatedFilters(
    filters: QueryFilter[],
  ): Promise<QueryFilter[]> {
    const out: QueryFilter[] = [];
    for (const f of filters) {
      out.push(await this.resolveUncorrelatedFilter(f));
    }
    return out;
  }

  private evalFilterTargetValue(
    row: DbRow,
    colName?: string,
    expr?: ExprNode,
  ): any {
    let udfs: any;
    if (typeof (this.db as any).getUdf === 'function') {
      udfs = (name: string) => (this.db as any).getUdf(name)?.def?.call;
    }
    if (colName && row[colName] !== undefined) {
      return row[colName];
    }
    if (expr) {
      const defaultAlias = deriveDefaultAlias(expr);
      if (row[defaultAlias] !== undefined) {
        return row[defaultAlias];
      }
      return evalExprNode(expr, row, udfs);
    }
    if (colName) {
      return this.getRowValue(row, colName);
    }
    return undefined;
  }

  private evalComparisonValues(
    leftVal: any,
    op: ComparisonOp | undefined,
    rightVal: any,
  ): boolean {
    if (
      leftVal === null ||
      leftVal === undefined ||
      rightVal === null ||
      rightVal === undefined
    ) {
      return false;
    }
    const normOp = (op ?? '=').trim().toLowerCase();
    switch (normOp) {
      case '=':
        return leftVal === rightVal;
      case '!=':
      case '<>':
        return leftVal !== rightVal;
      case '<':
        return leftVal < rightVal;
      case '<=':
        return leftVal <= rightVal;
      case '>':
        return leftVal > rightVal;
      case '>=':
        return leftVal >= rightVal;
      case 'starts_with':
        return String(leftVal).startsWith(String(rightVal));
      case 'ends_with':
        return String(leftVal).endsWith(String(rightVal));
      case 'contains':
        return String(leftVal).includes(String(rightVal));
      case 'like':
      case 'not like': {
        const pattern = String(rightVal)
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/%/g, '.*')
          .replace(/_/g, '.');
        const regex = new RegExp(`^${pattern}$`, 's');
        const matched = regex.test(String(leftVal));
        return normOp === 'not like' ? !matched : matched;
      }
      default:
        return leftVal === rightVal;
    }
  }

  private async evalFilterOnRow(
    row: DbRow,
    filter: QueryFilter,
  ): Promise<boolean> {
    if (filter.type === 'and') {
      for (const c of filter.children ?? []) {
        if (!(await this.evalFilterOnRow(row, c))) return false;
      }
      return true;
    }
    if (filter.type === 'or') {
      for (const c of filter.children ?? []) {
        if (await this.evalFilterOnRow(row, c)) return true;
      }
      return false;
    }
    if (filter.type === 'not' && filter.child) {
      // Handle SQL 3VL for null values inside NOT
      if (filter.child.type === 'cmp' || filter.child.type === 'in') {
        const leftVal = this.evalFilterTargetValue(
          row,
          filter.child.colName,
          filter.child.expr,
        );
        if (leftVal === null || leftVal === undefined) {
          return false;
        }
      }
      return !(await this.evalFilterOnRow(row, filter.child));
    }
    if (filter.type === 'null') {
      const val = this.evalFilterTargetValue(row, filter.colName, filter.expr);
      const isNull = val === null || val === undefined;
      return filter.isNull ? isNull : !isNull;
    }
    if (filter.type === 'expr' && filter.expr) {
      let udfs: any;
      if (typeof (this.db as any).getUdf === 'function') {
        udfs = (name: string) => (this.db as any).getUdf(name)?.def?.call;
      }
      const res = evalExprNode(filter.expr, row, udfs);
      return Boolean(res && res !== 0);
    }
    if (filter.type === 'exists') {
      if (filter.subquery && isQueryBuilder(filter.subquery)) {
        const bound = this.isSubqueryCorrelated(filter.subquery)
          ? this.bindOuterRowToSubquery(filter.subquery, row)
          : filter.subquery.clone(this.db);
        const firstRow = await bound.first();
        const exists = firstRow !== null;
        return filter.notExists ? !exists : exists;
      }
      return Boolean(filter.notExists);
    }
    if (filter.type === 'in') {
      let values = filter.values ?? [];
      if (filter.subquery && isQueryBuilder(filter.subquery)) {
        const bound = this.isSubqueryCorrelated(filter.subquery)
          ? this.bindOuterRowToSubquery(filter.subquery, row)
          : filter.subquery.clone(this.db);
        const subRows = await bound.toArray();
        const rawVals = subRows.map((r) => {
          const keys = Object.keys(r);
          return keys.length > 0 ? r[keys[0]] : null;
        });
        if (
          filter.notIn &&
          rawVals.some((v) => v === null || v === undefined)
        ) {
          return false;
        }
        values = rawVals.filter((v) => v !== null && v !== undefined);
      }
      if (!filter.colName && !filter.expr) {
        return filter.notIn ? values.length === 0 : values.length > 0;
      }
      if (values.length === 0) {
        return Boolean(filter.notIn);
      }
      const leftVal = this.evalFilterTargetValue(
        row,
        filter.colName,
        filter.expr,
      );
      if (leftVal === null || leftVal === undefined) {
        return false;
      }
      if (filter.notIn && values.some((v) => v === null || v === undefined)) {
        return false;
      }
      const matched = values.includes(leftVal);
      return filter.notIn ? !matched : matched;
    }
    if (filter.type === 'cmp') {
      const leftVal = this.evalFilterTargetValue(
        row,
        filter.colName,
        filter.expr,
      );
      const sub =
        filter.subquery && isQueryBuilder(filter.subquery)
          ? filter.subquery
          : isQueryBuilder(filter.value)
            ? filter.value
            : undefined;
      const rightVal = sub
        ? await this.evalScalarSubquery(sub, row)
        : filter.value;
      return this.evalComparisonValues(leftVal, filter.op, rightVal);
    }
    return true;
  }

  private async evalFiltersOnRows(
    rows: DbRow[],
    filters: QueryFilter[],
  ): Promise<DbRow[]> {
    if (filters.length === 0) return rows;
    const resolved = await this.resolveUncorrelatedFilters(filters);
    const out: DbRow[] = [];
    for (const row of rows) {
      let pass = true;
      for (const f of resolved) {
        if (!(await this.evalFilterOnRow(row, f))) {
          pass = false;
          break;
        }
      }
      if (pass) {
        out.push(row);
      }
    }
    return out;
  }

  private performInMemoryAggregation(rows: DbRow[]): DbRow[] {
    const G = Math.max(this.groupKeys.length, this.groupCols.length);
    const buckets = new Map<string, { keyRow: DbRow; rows: DbRow[] }>();

    if (G === 0) {
      buckets.set('__global__', { keyRow: {}, rows });
    } else {
      for (const row of rows) {
        const keyParts: any[] = [];
        const keyRow: DbRow = {};
        for (let i = 0; i < G; i++) {
          const gk = this.groupKeys[i];
          const gc = this.groupCols[i];
          const val = this.evalFilterTargetValue(
            row,
            gk?.colName ?? gc,
            gk?.expr,
          );
          keyParts.push(val);
          const colKey =
            gk?.colName ?? (gk?.expr ? deriveDefaultAlias(gk.expr) : gc);
          if (colKey) {
            keyRow[colKey] = val;
            if (colKey.includes('.')) {
              keyRow[colKey.slice(colKey.lastIndexOf('.') + 1)] = val;
            }
          }
          if (gc) {
            keyRow[gc] = val;
          }
        }
        const mapKey = JSON.stringify(keyParts);
        let b = buckets.get(mapKey);
        if (!b) {
          b = { keyRow, rows: [] };
          buckets.set(mapKey, b);
        }
        b.rows.push(row);
      }
    }

    let udfs: any;
    if (typeof (this.db as any).getUdf === 'function') {
      udfs = (name: string) => (this.db as any).getUdf(name)?.def?.call;
    }

    const computeAggOnRows = (
      groupRows: DbRow[],
      func: string,
      colName?: string,
      argExpr?: ExprNode,
    ): any => {
      const fn = func.toLowerCase();
      if (fn === 'count') {
        if (!colName && (!argExpr || (argExpr.type === 'col' && argExpr.name === '*'))) {
          return groupRows.length;
        }
        let cnt = 0;
        for (const r of groupRows) {
          const v = argExpr
            ? evalExprNode(argExpr, r, udfs)
            : this.getRowValue(r, colName!);
          if (v !== null && v !== undefined) cnt++;
        }
        return cnt;
      }
      const vals: any[] = [];
      for (const r of groupRows) {
        const v = argExpr
          ? evalExprNode(argExpr, r, udfs)
          : colName
            ? this.getRowValue(r, colName)
            : null;
        if (v !== null && v !== undefined) {
          vals.push(v);
        }
      }
      if (vals.length === 0) return null;
      if (fn === 'sum') {
        return vals.reduce((acc, v) => acc + Number(v), 0);
      }
      if (fn === 'avg') {
        return vals.reduce((acc, v) => acc + Number(v), 0) / vals.length;
      }
      if (fn === 'min') {
        return vals.reduce((m, v) => (v < m ? v : m), vals[0]);
      }
      if (fn === 'max') {
        return vals.reduce((m, v) => (v > m ? v : m), vals[0]);
      }
      return null;
    };

    const resultRows: DbRow[] = [];
    for (const { keyRow, rows: groupRows } of buckets.values()) {
      const outRow: DbRow = { ...keyRow };
      for (const agg of this.aggExprs) {
        const val = computeAggOnRows(groupRows, agg.func, agg.colName);
        const aggName =
          agg.alias ?? (agg.colName ? `${agg.func}_${agg.colName}` : agg.func);
        outRow[aggName] = val;
        outRow[`${agg.func}(${agg.colName ?? '*'})`] = val;
        if (!agg.colName) {
          outRow[agg.func] = val;
        }
      }
      for (const f of this.selectFields) {
        if (f.expr && f.expr.type === 'fn' && isAggregateFunction(f.expr.name)) {
          const arg0 = f.expr.args[0];
          const val = computeAggOnRows(
            groupRows,
            f.expr.name,
            arg0 && arg0.type === 'col' && arg0.name !== '*' ? arg0.name : undefined,
            arg0,
          );
          outRow[f.alias] = val;
          outRow[deriveDefaultAlias(f.expr)] = val;
        }
      }
      resultRows.push(outRow);
    }

    return resultRows;
  }

  private async attachSelectSubqueries(rows: DbRow[]): Promise<void> {
    const subFields = this.selectFields.filter((f) => f.subquery);
    if (subFields.length === 0 || rows.length === 0) return;

    const uncorrelatedCache = new Map< NormalizedSelectField, any>();
    for (const f of subFields) {
      if (f.subquery && !this.isSubqueryCorrelated(f.subquery)) {
        const val = await this.evalScalarSubquery(f.subquery);
        uncorrelatedCache.set(f, val);
      }
    }

    for (const row of rows) {
      for (const f of subFields) {
        if (uncorrelatedCache.has(f)) {
          row[f.alias] = uncorrelatedCache.get(f);
        } else if (f.subquery) {
          row[f.alias] = await this.evalScalarSubquery(f.subquery, row);
        }
      }
    }
  }

  private async executeMaterializedDerivedTable(): Promise<DbRow[]> {
    let rows = await this.sourceSubquery!.clone(this.db).toArray();

    // Handle outer joins if any
    for (const join of this.joins) {
      const rightRows = await new QueryBuilder(this.db, join.table).toArray();
      const joined: DbRow[] = [];
      for (const lRow of rows) {
        let matchedAny = false;
        const lVal = this.getRowValue(lRow, join.leftCol);
        for (const rRow of rightRows) {
          const rVal = this.getRowValue(rRow, join.rightCol);
          if (this.evalComparisonValues(lVal, join.op, rVal)) {
            matchedAny = true;
            const merged: DbRow = { ...lRow };
            for (const [k, v] of Object.entries(rRow)) {
              merged[`${join.table}.${k}`] = v;
              if (!(k in merged)) {
                merged[k] = v;
              }
            }
            joined.push(merged);
          }
        }
        if (!matchedAny && join.type === 'left') {
          joined.push({ ...lRow });
        }
      }
      rows = joined;
    }

    // Apply WHERE filters
    rows = await this.evalFiltersOnRows(rows, this.filters);

    // Apply GROUP BY / Aggregates / HAVING
    const hasAggsOrGrouping =
      this.aggExprs.length > 0 ||
      this.groupKeys.length > 0 ||
      this.groupCols.length > 0;
    if (hasAggsOrGrouping) {
      rows = this.performInMemoryAggregation(rows);
      if (this.havingFilters.length > 0) {
        rows = await this.evalFiltersOnRows(rows, this.havingFilters);
      }
    }

    // Evaluate SELECT scalar subqueries before sorting if ORDER BY references them
    const hasSelectSubqueries = this.selectFields.some((f) => f.subquery);
    const orderByReferencesSelectSubquery =
      hasSelectSubqueries &&
      this.orderKeys.some((k) =>
        this.selectFields.some(
          (f) => f.subquery && (f.alias === k.colName || f.alias === (k.expr ? deriveDefaultAlias(k.expr) : undefined)),
        ),
      );

    if (orderByReferencesSelectSubquery) {
      await this.attachSelectSubqueries(rows);
    }

    // Apply ORDER BY
    if (this.orderKeys.length > 0) {
      rows = this.sortAggregatedRows(rows);
    }

    // Apply OFFSET and LIMIT
    if (this.offsetCount !== null && this.offsetCount > 0) {
      rows = rows.slice(this.offsetCount);
    }
    if (this.limitCount !== null && this.limitCount >= 0) {
      rows = rows.slice(0, this.limitCount);
    }

    if (hasSelectSubqueries && !orderByReferencesSelectSubquery) {
      await this.attachSelectSubqueries(rows);
    }

    if (this.selectFields.length > 0) {
      rows = rows.map((r) => this.projectRow(r));
    }

    return rows;
  }

  /**
   * Post-processes raw VDBE result rows into projected output records according
   * to select fields, expressions, aliases, and registered UDFs.
   */
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
      if (row[targetAlias] !== undefined) {
        projected[targetAlias] = row[targetAlias];
      } else if (
        field.expr &&
        row[deriveDefaultAlias(field.expr)] !== undefined
      ) {
        projected[targetAlias] = row[deriveDefaultAlias(field.expr)];
      } else if (
        field.sourceCol !== undefined &&
        row[field.sourceCol] !== undefined
      ) {
        projected[targetAlias] = row[field.sourceCol];
      } else if (field.expr) {
        let udfs: any;
        if (typeof (this.db as any).getUdf === 'function') {
          udfs = (name: string) => (this.db as any).getUdf(name)?.def?.call;
        }
        projected[targetAlias] = evalExprNode(field.expr, row, udfs);
      } else {
        projected[targetAlias] = null;
      }
    }
    return projected;
  }

  async explain(): Promise<ExplainOutput> {
    this.assertSubqueryDepth();

    if (this.sourceSubquery) {
      const flattened = this.tryFlatten();
      if (flattened) {
        return flattened.explain();
      }
      const innerExplain = await this.sourceSubquery.clone(this.db).explain();
      const resolvedFilters = await this.resolveUncorrelatedFilters(this.filters);
      return {
        plan: {
          ...innerExplain.plan,
          filters: [...innerExplain.plan.filters, ...resolvedFilters],
          orderBy:
            this.orderKeys.length > 0
              ? this.orderKeys
              : innerExplain.plan.orderBy,
          groupBy:
            this.groupKeys.length > 0
              ? this.groupKeys
              : this.groupCols.length > 0
                ? this.groupCols
                : innerExplain.plan.groupBy,
          aggregates:
            this.aggExprs.length > 0
              ? this.aggExprs
              : innerExplain.plan.aggregates,
          having:
            this.havingFilters.length > 0
              ? this.havingFilters
              : innerExplain.plan.having,
          select:
            this.selectFields.length > 0
              ? this.selectFields
              : innerExplain.plan.select,
          limit:
            this.limitCount !== null ? this.limitCount : innerExplain.plan.limit,
          offset:
            this.offsetCount !== null
              ? this.offsetCount
              : innerExplain.plan.offset,
        },
        bytecodeSize: innerExplain.bytecodeSize,
        instructions: innerExplain.instructions,
        assembly: innerExplain.assembly,
      };
    }

    const resolvedFilters = await this.resolveUncorrelatedFilters(
      this.filters.filter((f) => !this.filterContainsCorrelatedSubquery(f)),
    );
    const resolvedHaving = await this.resolveUncorrelatedFilters(
      this.havingFilters.filter((f) => !this.filterContainsCorrelatedSubquery(f)),
    );

    const nonSubSelectFields = this.selectFields.filter((f) => !f.subquery);
    const selectExprs: ParsedSelectExpr[] = nonSubSelectFields.map((f) => ({
      expr: f.expr ?? { type: 'col', name: f.sourceCol ?? f.alias },
      alias: f.alias,
    }));

    return this.db.explainQuery(this.tableName, resolvedFilters, {
      joins: this.joins.length > 0 ? this.joins : undefined,
      orderBy: this.orderKeys.length > 0 ? this.orderKeys : undefined,
      groupBy:
        this.groupKeys.length > 0
          ? this.groupKeys
          : this.groupCols.length > 0
            ? this.groupCols
            : undefined,
      aggregates: this.aggExprs.length > 0 ? this.aggExprs : undefined,
      having: resolvedHaving.length > 0 ? resolvedHaving : undefined,
      select: nonSubSelectFields.length > 0 ? nonSubSelectFields : undefined,
      selectExprs: selectExprs.length > 0 ? selectExprs : undefined,
      limit: this.limitCount !== null ? this.limitCount : undefined,
      offset: this.offsetCount !== null ? this.offsetCount : undefined,
      planner: this.planner,
    });
  }

  private getOrderKeyValue(row: DbRow, k: SortKey): any {
    const rawKey =
      k.colName ?? (k.expr ? deriveDefaultAlias(k.expr) : undefined);
    if (!rawKey) return undefined;

    if (row[rawKey] !== undefined) return row[rawKey];

    const shortCol = rawKey.includes('.')
      ? rawKey.slice(rawKey.lastIndexOf('.') + 1)
      : rawKey;
    if (row[shortCol] !== undefined) return row[shortCol];

    if (this.selectFields.length > 0) {
      for (const f of this.selectFields) {
        if (
          f.sourceCol === rawKey ||
          f.sourceCol === shortCol ||
          f.alias === rawKey ||
          f.alias === shortCol
        ) {
          if (row[f.alias] !== undefined) return row[f.alias];
        }
      }
    }

    if (row[`__sort_${rawKey}`] !== undefined) return row[`__sort_${rawKey}`];
    if (row[`__sort_${shortCol}`] !== undefined) return row[`__sort_${shortCol}`];

    if (k.expr) {
      let udfs: any;
      if (typeof (this.db as any).getUdf === 'function') {
        udfs = (name: string) => (this.db as any).getUdf(name)?.def?.call;
      }
      return evalExprNode(k.expr, row, udfs);
    }

    return undefined;
  }

  private sortAggregatedRows(rows: DbRow[]): DbRow[] {
    return [...rows].sort((a, b) => {
      for (const k of this.orderKeys) {
        const valA = this.getOrderKeyValue(a, k);
        const valB = this.getOrderKeyValue(b, k);
        if (valA === valB) continue;
        if (valA === null || valA === undefined) {
          return k.nullOrder === 'nulls_first' ? -1 : 1;
        }
        if (valB === null || valB === undefined) {
          return k.nullOrder === 'nulls_first' ? 1 : -1;
        }
        const dir = k.direction === 'desc' ? -1 : 1;
        if (typeof valA === 'number' && typeof valB === 'number') {
          return (valA - valB) * dir;
        }
        return String(valA).localeCompare(String(valB)) * dir;
      }
      return 0;
    });
  }

  toArray(): Promise<DbRow[]> {
    this.assertSubqueryDepth();
    const callerTracker = getActiveLiveQueryTracker();
    notifyLiveQueryTableRead(this.db, this.getReferencedTables());
    const promise = this._toArrayInternal();
    return trackLiveQueryPromise(promise, callerTracker);
  }

  private async _toArrayInternal(): Promise<DbRow[]> {
    // 1. Derived table (`db.from(subquery)`)
    if (this.sourceSubquery) {
      const flattened = this.tryFlatten();
      if (flattened) {
        return flattened._toArrayInternal();
      }
      return this.executeMaterializedDerivedTable();
    }

    const hasCorrelatedWhere = this.filters.some((f) =>
      this.filterContainsCorrelatedSubquery(f),
    );
    const hasCorrelatedHaving = this.havingFilters.some((f) =>
      this.filterContainsCorrelatedSubquery(f),
    );
    const hasSelectSubqueries = this.selectFields.some((f) => f.subquery);
    const hasCorrelatedSelectSubqueries = this.selectFields.some(
      (f) => f.subquery && this.isSubqueryCorrelated(f.subquery),
    );

    const uncorrelatedWhereFilters = await this.resolveUncorrelatedFilters(
      this.filters.filter((f) => !this.filterContainsCorrelatedSubquery(f)),
    );
    const correlatedWhereFilters = this.filters.filter((f) =>
      this.filterContainsCorrelatedSubquery(f),
    );

    const hasJoins = this.joins.length > 0;
    const hasOrderBy = this.orderKeys.length > 0;
    const hasAggsOrGrouping =
      this.aggExprs.length > 0 ||
      this.groupKeys.length > 0 ||
      this.groupCols.length > 0;

    // 2. If there are correlated WHERE predicates, execute base scan with uncorrelated
    // predicates first, evaluate correlated predicates per row, then aggregate/sort/limit.
    if (hasCorrelatedWhere) {
      let rows = await this.db.executeQuery(
        this.tableName,
        uncorrelatedWhereFilters,
        {
          limit: null,
          offset: null,
          sortCol: null,
          sortDir: this.sortDir,
          joins: hasJoins ? this.joins : undefined,
          planner: this.planner,
        },
      );

      rows = await this.evalFiltersOnRows(rows, correlatedWhereFilters);

      if (hasAggsOrGrouping) {
        rows = this.performInMemoryAggregation(rows);
        if (this.havingFilters.length > 0) {
          rows = await this.evalFiltersOnRows(rows, this.havingFilters);
        }
      }

      if (hasSelectSubqueries) {
        await this.attachSelectSubqueries(rows);
      }

      if (hasOrderBy) {
        rows = this.sortAggregatedRows(rows);
      }

      if (this.offsetCount !== null && this.offsetCount > 0) {
        rows = rows.slice(this.offsetCount);
      }
      if (this.limitCount !== null && this.limitCount >= 0) {
        rows = rows.slice(0, this.limitCount);
      }

      if (this.selectFields.length > 0) {
        rows = rows.map((r) => this.projectRow(r));
      }
      return rows;
    }

    const resolvedHavingFilters = await this.resolveUncorrelatedFilters(
      this.havingFilters.filter((f) => !this.filterContainsCorrelatedSubquery(f)),
    );

    const nonSubSelectFields = this.selectFields.filter((f) => !f.subquery);
    const selectExprs: ParsedSelectExpr[] = nonSubSelectFields.map((f) => ({
      expr: f.expr ?? { type: 'col', name: f.sourceCol ?? f.alias },
      alias: f.alias,
    }));

    if (hasJoins && hasOrderBy && selectExprs.length > 0) {
      for (const k of this.orderKeys) {
        const col = k.colName;
        if (col) {
          const short = col.includes('.')
            ? col.slice(col.lastIndexOf('.') + 1)
            : col;
          const found = nonSubSelectFields.some(
            (f) =>
              f.alias === col ||
              f.alias === short ||
              f.sourceCol === col ||
              f.sourceCol === short,
          );
          if (!found) {
            selectExprs.push({
              expr: { type: 'col', name: col },
              alias: `__sort_${col}`,
            });
          }
        }
      }
    }

    // If correlated SELECT subqueries need outer row columns that weren't explicitly
    // selected, fetch full rows from VDBE when not aggregating, then project in projectRow.
    const passSelectToVdbe =
      !hasCorrelatedSelectSubqueries || hasAggsOrGrouping;

    const rawRows = await this.db.executeQuery(
      this.tableName,
      uncorrelatedWhereFilters,
      {
        limit:
          (hasJoins && hasOrderBy && hasAggsOrGrouping) || hasCorrelatedHaving
            ? null
            : this.limitCount,
        offset:
          (hasJoins && hasOrderBy && hasAggsOrGrouping) || hasCorrelatedHaving
            ? null
            : this.offsetCount,
        sortCol: hasJoins ? null : this.sortCol,
        sortDir: this.sortDir,
        orderBy:
          hasJoins && hasAggsOrGrouping
            ? undefined
            : hasOrderBy
              ? this.orderKeys
              : undefined,
        joins: hasJoins ? this.joins : undefined,
        groupBy:
          this.groupKeys.length > 0
            ? this.groupKeys
            : this.groupCols.length > 0
              ? this.groupCols
              : undefined,
        aggregates: this.aggExprs.length > 0 ? this.aggExprs : undefined,
        having:
          resolvedHavingFilters.length > 0 ? resolvedHavingFilters : undefined,
        select:
          passSelectToVdbe && nonSubSelectFields.length > 0
            ? nonSubSelectFields
            : undefined,
        selectExprs:
          passSelectToVdbe && selectExprs.length > 0 ? selectExprs : undefined,
        planner: this.planner,
      },
    );

    let rows = rawRows;
    if (hasCorrelatedHaving) {
      const corrHaving = this.havingFilters.filter((f) =>
        this.filterContainsCorrelatedSubquery(f),
      );
      rows = await this.evalFiltersOnRows(rows, corrHaving);
    }

    const isOrderSatisfied = (rawRows as any).isOrderSatisfied === true;
    if ((hasAggsOrGrouping || hasJoins) && hasOrderBy && !isOrderSatisfied) {
      rows = this.sortAggregatedRows(rows);
      if (hasJoins || hasCorrelatedHaving) {
        if (this.offsetCount !== null && this.offsetCount > 0) {
          rows = rows.slice(this.offsetCount);
        }
        if (this.limitCount !== null && this.limitCount >= 0) {
          rows = rows.slice(0, this.limitCount);
        }
      }
    } else if (hasCorrelatedHaving) {
      if (this.offsetCount !== null && this.offsetCount > 0) {
        rows = rows.slice(this.offsetCount);
      }
      if (this.limitCount !== null && this.limitCount >= 0) {
        rows = rows.slice(0, this.limitCount);
      }
    }

    if (hasSelectSubqueries) {
      await this.attachSelectSubqueries(rows);
    }

    if (this.selectFields.length > 0) {
      rows = rows.map((r) => this.projectRow(r));
    }

    return rows;
  }

  first(): Promise<DbRow | null> {
    const callerTracker = getActiveLiveQueryTracker();
    this.limit(1);
    this.assertSubqueryDepth();
    notifyLiveQueryTableRead(this.db, this.getReferencedTables());
    const promise = this._toArrayInternal().then((rows) =>
      rows.length > 0 ? rows[0] : null,
    );
    return trackLiveQueryPromise(promise, callerTracker);
  }

  /**
   * Turns this query into a reactive LiveQueryController that automatically
   * re-executes whenever any table referenced by the query (including JOINs
   * and subqueries) is modified locally or from another tab/worker.
   *
   * @example
   * ```ts
   * const live = db
   *   .from('todos')
   *   .where('completed', '=', false)
   *   .live((rows) => render(rows));
   *
   * // Later:
   * live.destroy();
   * ```
   */
  live<T = DbRow[]>(
    callbackOrOptions?: ((rows: T, state: LiveQueryState<T>) => void) | LiveQueryOptions<T>,
    options?: LiveQueryOptions<T>,
  ): LiveQueryController<T> {
    return liveQuery<T>(
      () => this.clone(this.db).toArray() as unknown as Promise<T>,
      callbackOrOptions,
      options,
    );
  }

  async update(
    patch: Partial<DbRow>,
    options?: TransactionOptions,
  ): Promise<number> {
    if (!this.db.executeUpdate) {
      throw new Error('Database executor does not support executeUpdate');
    }
    this.assertSubqueryDepth();
    const resolvedFilters = await this.resolveUncorrelatedFilters(this.filters);
    return this.db.executeUpdate(
      this.tableName,
      resolvedFilters,
      patch,
      options,
    );
  }

  async delete(options?: TransactionOptions): Promise<number> {
    if (!this.db.executeDelete) {
      throw new Error('Database executor does not support executeDelete');
    }
    this.assertSubqueryDepth();
    const resolvedFilters = await this.resolveUncorrelatedFilters(this.filters);
    return this.db.executeDelete(this.tableName, resolvedFilters, options);
  }
}
