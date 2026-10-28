import {
  TableMeta,
  IndexDescriptor,
  IndexFlag,
  JoinType,
} from '../../../types/index.js';
import {
  QueryPlan,
  JoinPlan,
  QueryFilter,
  ComparisonOp,
  SortKey,
  resolveColumnAcrossTables,
  chooseIndexScan,
  isIndexAlignedWithOrderBy,
} from '../compiler.js';
import { ParsedSelectExpr } from '../expr_parser.js';

export interface WhereMetrics {
  originalCount: number;
  optimizedCount: number;
  isAlwaysFalse: boolean;
  isAlwaysTrue: boolean;
  contradictionReason?: string;
  eliminatedFiltersCount: number;
  reordered: boolean;
}

export interface PlanCostMetrics {
  totalCost: number;
  estimatedRows: number;
  joinOrder: string[];
  singleTableFilters: Map<number, QueryFilter[]>;
  crossFilters: QueryFilter[];
  tableScanTypes: ('TableScan' | 'IndexScan')[];
  tableIndexNames: (string | undefined)[];
  isOrderSatisfied?: boolean;
  sortCostAvoided?: number;
}

export interface OptimizedPlanResult {
  plan: QueryPlan;
  orderedTables: TableMeta[];
  metrics: PlanCostMetrics | null;
  isAlwaysFalse?: boolean;
  isAlwaysTrue?: boolean;
  whereMetrics?: WhereMetrics;
  isOrderSatisfied?: boolean;
  sortCostAvoided?: number;
}

export interface QueryPlanner {
  readonly name: string;
  optimize(plan: QueryPlan): OptimizedPlanResult;
}

export interface JoinEdge {
  tableA: number;
  tableB: number;
  colA: string;
  colB: string;
  op: ComparisonOp;
  type: JoinType;
  declaredRightTable: number;
}

export const COST_INDEX_SEEK = 0.5;
export const COST_INDEX_NEXT = 0.05;
export const COST_ROW_EVAL = 0.02;

/**
 * Extracts all column names referenced in a filter (both direct colName and expr).
 */
export function extractFilterColumnNames(filter: QueryFilter): string[] {
  const cols: string[] = [];

  function visitFilter(f: QueryFilter) {
    if (f.colName) {
      cols.push(f.colName);
    }
    if (f.expr) {
      visitExpr(f.expr);
    }
    if (f.children) {
      for (const child of f.children) {
        visitFilter(child);
      }
    }
    if (f.child) {
      visitFilter(f.child);
    }
  }

  function visitExpr(expr: any) {
    if (!expr) return;
    if (expr.type === 'col' && expr.name) {
      cols.push(expr.name);
    }
    if (expr.left) visitExpr(expr.left);
    if (expr.right) visitExpr(expr.right);
    if (expr.args && Array.isArray(expr.args)) {
      for (const arg of expr.args) {
        visitExpr(arg);
      }
    }
  }

  visitFilter(filter);
  return cols;
}

/**
 * Determines which table indices (in `tables`) are referenced by a filter.
 */
export function getFilterReferencedTables(
  filter: QueryFilter,
  tables: TableMeta[],
): Set<number> {
  const colNames = extractFilterColumnNames(filter);
  const referenced = new Set<number>();
  for (const name of colNames) {
    const resolved = resolveColumnAcrossTables(name, tables);
    if (resolved) {
      referenced.add(resolved.tableIdx);
    }
  }
  return referenced;
}

/**
 * Estimates filter selectivity based on operation, column index presence, and table row count.
 */
export function estimateFilterSelectivity(
  filter: QueryFilter,
  table: TableMeta,
): number {
  const rowCount = Math.max(1, table.rowCountEstimate || 10);

  if (filter.type === 'cmp') {
    const op = filter.op ?? '=';
    if (op === '=') {
      const colName = filter.colName?.toLowerCase();
      const colIdx = table.columns.findIndex(
        (c) => c.name.toLowerCase() === colName,
      );
      if (colIdx !== -1 && table.indexes) {
        for (const idx of table.indexes) {
          if (idx.columnCount === 1 && idx.columnIndices[0] === colIdx) {
            const isUnique =
              (idx.flags & (IndexFlag.PRIMARY | IndexFlag.UNIQUE)) !== 0;
            if (isUnique) {
              return 1.0 / rowCount;
            }
            return Math.min(0.2, 5.0 / rowCount);
          }
        }
      }
      return 0.1;
    }
    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      return 0.33;
    }
    if (op === '!=' || (op as string) === '<>') {
      return 0.9;
    }
    if (
      op === 'LIKE' ||
      op === 'CONTAINS' ||
      op === 'STARTS_WITH' ||
      op === 'ENDS_WITH'
    ) {
      return 0.15;
    }
  }

  if (filter.type === 'in') {
    const valuesCount = Math.max(1, filter.values?.length || 1);
    const baseSel = 0.05;
    return Math.min(1.0, valuesCount * baseSel);
  }

  if (filter.type === 'null') {
    return filter.isNull ? 0.05 : 0.95;
  }

  return 0.2;
}

/**
 * Computes single-table base cardinality and scan cost for a table when used as driving table.
 */
export function getSingleTableBaseCost(
  table: TableMeta,
  filters: QueryFilter[],
  orderBy?: SortKey[],
  limit?: number,
): {
  cost: number;
  rows: number;
  scanType: 'TableScan' | 'IndexScan';
  indexName?: string;
  isOrderSatisfied?: boolean;
  sortCostAvoided?: number;
} {
  const rowCount = Math.max(1, table.rowCountEstimate || 10);
  let selectivity = 1.0;

  for (const f of filters) {
    selectivity *= estimateFilterSelectivity(f, table);
  }

  const estimatedRows = Math.max(1, Math.round(rowCount * selectivity));
  const hasOrderBy = orderBy !== undefined && orderBy.length > 0;
  const explicitSortCost =
    hasOrderBy && estimatedRows > 1
      ? estimatedRows * Math.log2(estimatedRows) * COST_ROW_EVAL
      : 0;

  const cand = chooseIndexScan(table, filters, filters, orderBy);

  if (cand) {
    const isPoint = cand.scanType === 'point';
    const isMultiPoint = cand.scanType === 'multi_point';
    const satisfiesOrder = cand.satisfiesOrderBy === true;
    const effectiveRows =
      satisfiesOrder && limit !== undefined && limit > 0
        ? Math.min(limit, estimatedRows)
        : estimatedRows;

    let cost = COST_INDEX_SEEK;
    if (isPoint) {
      cost += 1 * COST_ROW_EVAL;
      return {
        cost,
        rows: 1,
        scanType: 'IndexScan',
        indexName: cand.index.name,
        isOrderSatisfied: true,
        sortCostAvoided: hasOrderBy ? explicitSortCost : undefined,
      };
    }
    if (isMultiPoint) {
      const numVals = cand.inValues?.length || 1;
      cost = numVals * COST_INDEX_SEEK + effectiveRows * COST_ROW_EVAL;
      if (!satisfiesOrder && hasOrderBy) {
        cost += explicitSortCost;
      }
      return {
        cost,
        rows: effectiveRows,
        scanType: 'IndexScan',
        indexName: cand.index.name,
        isOrderSatisfied: satisfiesOrder,
        sortCostAvoided: satisfiesOrder ? explicitSortCost : undefined,
      };
    }
    // Range
    cost += effectiveRows * COST_INDEX_NEXT + effectiveRows * COST_ROW_EVAL;
    if (!satisfiesOrder && hasOrderBy) {
      cost += explicitSortCost;
    }
    return {
      cost,
      rows: effectiveRows,
      scanType: 'IndexScan',
      indexName: cand.index.name,
      isOrderSatisfied: satisfiesOrder,
      sortCostAvoided: satisfiesOrder ? explicitSortCost : undefined,
    };
  }

  // Full table scan
  let cost = rowCount * COST_ROW_EVAL;
  if (hasOrderBy) {
    cost += explicitSortCost;
  }
  return {
    cost,
    rows: estimatedRows,
    scanType: 'TableScan',
    isOrderSatisfied: false,
  };
}

/**
 * Checks if targetTable has an index on the given column.
 */
export function findIndexOnColumn(
  table: TableMeta,
  colName: string,
): { index: IndexDescriptor; isUnique: boolean } | null {
  if (!table.indexes || table.indexes.length === 0) return null;
  const colIdx = table.columns.findIndex(
    (c) => c.name.toLowerCase() === colName.toLowerCase(),
  );
  if (colIdx === -1) return null;

  let best: { index: IndexDescriptor; isUnique: boolean } | null = null;
  let bestRank = 999;

  for (const idx of table.indexes) {
    if (idx.columnCount === 1 && idx.columnIndices[0] === colIdx) {
      const isPk = (idx.flags & IndexFlag.PRIMARY) !== 0;
      const isUnique = (idx.flags & IndexFlag.UNIQUE) !== 0;
      const rank = isPk ? 1 : isUnique ? 2 : 3;
      if (rank < bestRank) {
        bestRank = rank;
        best = { index: idx, isUnique: isPk || isUnique };
      }
    }
  }

  return best;
}

/**
 * Builds join edges and left-join dependency constraints from query join clauses.
 */
export function buildJoinEdges(
  plan: QueryPlan,
  originalTables: TableMeta[],
): { edges: JoinEdge[]; dependencies: Set<number>[] } {
  const N = originalTables.length;
  const edges: JoinEdge[] = [];
  const dependencies: Set<number>[] = Array.from(
    { length: N },
    () => new Set<number>(),
  );

  if (!plan.joinedTables) return { edges, dependencies };

  for (let j = 0; j < plan.joinedTables.length; j++) {
    const jp = plan.joinedTables[j];
    const joinedIdx = j + 1;
    const leftRes = resolveColumnAcrossTables(jp.leftCol, originalTables);
    const rightRes = resolveColumnAcrossTables(jp.rightCol, originalTables);

    if (leftRes && rightRes) {
      edges.push({
        tableA: leftRes.tableIdx,
        tableB: rightRes.tableIdx,
        colA: leftRes.col.name,
        colB: rightRes.col.name,
        op: jp.op,
        type: jp.type,
        declaredRightTable: joinedIdx,
      });

      // Semantic constraint for LEFT JOIN:
      // In `A LEFT JOIN B`, B cannot be evaluated before A (A is the outer preserved table).
      if (jp.type === 'left') {
        const outerTbl =
          leftRes.tableIdx === joinedIdx ? rightRes.tableIdx : leftRes.tableIdx;
        dependencies[joinedIdx].add(outerTbl);
      }
    }
  }

  return { edges, dependencies };
}

/**
 * Preserves output column projection order in case of table reordering.
 */
export function materializeOutputSelectExprs(
  plan: QueryPlan,
  originalTables: TableMeta[],
): ParsedSelectExpr[] | undefined {
  if (plan.selectExprs && plan.selectExprs.length > 0) {
    return plan.selectExprs;
  }

  const seenNames = new Set<string>();
  const dupNames = new Set<string>();
  for (const t of originalTables) {
    for (const c of t.columns) {
      if (seenNames.has(c.name.toLowerCase())) {
        dupNames.add(c.name.toLowerCase());
      }
      seenNames.add(c.name.toLowerCase());
    }
  }

  const effectiveSelectExprs: ParsedSelectExpr[] = [];
  for (const t of originalTables) {
    for (const c of t.columns) {
      const alias = dupNames.has(c.name.toLowerCase())
        ? `${t.name}.${c.name}`
        : c.name;
      effectiveSelectExprs.push({
        expr: { type: 'col', name: `${t.name}.${c.name}` },
        alias,
      });
    }
  }

  return effectiveSelectExprs;
}

/**
 * Reconstructs JoinPlan[] for the ordered tables based on resolved join edges.
 */
export function reconstructJoinPlans(
  winningOrder: number[],
  originalTables: TableMeta[],
  edges: JoinEdge[],
  originalJoinedPlans?: JoinPlan[],
): JoinPlan[] {
  const N = winningOrder.length;
  const newJoinedPlans: JoinPlan[] = [];

  for (let k = 1; k < N; k++) {
    const innerTableIdx = winningOrder[k];
    const innerTable = originalTables[innerTableIdx];
    const priorIndices = winningOrder.slice(0, k);

    const chosenEdge = edges.find(
      (e) =>
        (e.tableA === innerTableIdx && priorIndices.includes(e.tableB)) ||
        (e.tableB === innerTableIdx && priorIndices.includes(e.tableA)),
    );

    let leftColName: string;
    let rightColName: string;
    let op: ComparisonOp = '=';
    let joinType: JoinType = 'inner';

    if (chosenEdge) {
      op = chosenEdge.op;
      joinType = chosenEdge.type;
      if (chosenEdge.tableA === innerTableIdx) {
        rightColName = `${innerTable.name}.${chosenEdge.colA}`;
        const outerTable = originalTables[chosenEdge.tableB];
        leftColName = `${outerTable.name}.${chosenEdge.colB}`;
      } else {
        rightColName = `${innerTable.name}.${chosenEdge.colB}`;
        const outerTable = originalTables[chosenEdge.tableA];
        leftColName = `${outerTable.name}.${chosenEdge.colA}`;
      }
    } else {
      const origJp = originalJoinedPlans?.find(
        (j) => j.table.name === innerTable.name,
      );
      leftColName = origJp ? origJp.leftCol : `${originalTables[winningOrder[0]].name}.id`;
      rightColName = origJp ? origJp.rightCol : `${innerTable.name}.id`;
      op = origJp ? origJp.op : '=';
      joinType = origJp ? origJp.type : 'inner';
    }

    newJoinedPlans.push({
      type: joinType,
      table: innerTable,
      cursor: k,
      leftCol: leftColName,
      op,
      rightCol: rightColName,
    });
  }

  return newJoinedPlans;
}

/**
 * Checks whether all ORDER BY keys belong to candidateTable and are ASC,
 * which enables nested-loop join order preservation if candidateTable is the driving table.
 */
export function doesTableSatisfyJoinOrderKeys(
  candidateTable: TableMeta,
  candidateTableIdx: number,
  allTables: TableMeta[],
  orderBy?: SortKey[],
  selectExprs?: ParsedSelectExpr[],
): boolean {
  if (!orderBy || orderBy.length === 0) return false;
  for (const k of orderBy) {
    if (k.direction === 'desc') return false;
    const colName = k.colName;
    if (!colName) return false;
    let resolved = resolveColumnAcrossTables(colName, allTables);
    if (!resolved && selectExprs) {
      const se = selectExprs.find((s) => s.alias === colName);
      if (se && se.expr.type === 'col') {
        resolved = resolveColumnAcrossTables(se.expr.name, allTables);
      }
    }
    if (!resolved || resolved.tableIdx !== candidateTableIdx) {
      return false;
    }
  }
  return true;
}
