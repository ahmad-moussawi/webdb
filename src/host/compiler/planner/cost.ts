import { TableMeta } from '../../../types/index.js';
import {
  QueryPlan,
  QueryFilter,
  buildRootFilter,
  getTopLevelConjunctionFilters,
} from '../compiler.js';
import {
  QueryPlanner,
  OptimizedJoinPlanResult,
  JoinEdge,
  getFilterReferencedTables,
  getSingleTableBaseCost,
  findIndexOnColumn,
  buildJoinEdges,
  materializeOutputSelectExprs,
  reconstructJoinPlans,
  estimateFilterSelectivity,
  COST_INDEX_SEEK,
  COST_INDEX_NEXT,
  COST_ROW_EVAL,
} from './types.js';

export interface CostBasedPlannerOptions {
  indexSeekCost?: number;
  indexNextCost?: number;
  rowEvalCost?: number;
}

/**
 * CostBasedPlanner uses Dynamic Programming (Selinger/System-R style) to evaluate
 * join permutations and select the optimal plan based on cardinality and cost estimates.
 */
export class CostBasedPlanner implements QueryPlanner {
  readonly name = 'cost';
  private indexSeekCost: number;
  private indexNextCost: number;
  private rowEvalCost: number;

  constructor(options?: CostBasedPlannerOptions) {
    this.indexSeekCost = options?.indexSeekCost ?? COST_INDEX_SEEK;
    this.indexNextCost = options?.indexNextCost ?? COST_INDEX_NEXT;
    this.rowEvalCost = options?.rowEvalCost ?? COST_ROW_EVAL;
  }

  optimize(plan: QueryPlan): OptimizedJoinPlanResult {
    const originalTables: TableMeta[] = [
      plan.table,
      ...(plan.joinedTables?.map((j) => j.table) ?? []),
    ];
    const N = originalTables.length;

    const rootFilter = buildRootFilter(plan.filters);
    const topConjunctions = getTopLevelConjunctionFilters(rootFilter);

    // Partition filters: single-table filters per table, and cross-table filters
    const singleTableFilters = new Map<number, QueryFilter[]>();
    const crossFilters: QueryFilter[] = [];

    for (let i = 0; i < N; i++) {
      singleTableFilters.set(i, []);
    }

    for (const filter of topConjunctions) {
      const refs = getFilterReferencedTables(filter, originalTables);
      if (refs.size === 1) {
        const tblIdx = refs.values().next().value;
        if (tblIdx !== undefined) {
          singleTableFilters.get(tblIdx)?.push(filter);
        }
      } else {
        crossFilters.push(filter);
      }
    }

    // Single-table query: trivial case
    if (N <= 1 || !plan.joinedTables || plan.joinedTables.length === 0) {
      const base = getSingleTableBaseCost(
        originalTables[0],
        singleTableFilters.get(0) ?? [],
      );
      return {
        plan,
        orderedTables: originalTables,
        metrics: {
          totalCost: base.cost,
          estimatedRows: base.rows,
          joinOrder: [originalTables[0].name],
          singleTableFilters,
          crossFilters,
          tableScanTypes: [base.scanType],
          tableIndexNames: [base.indexName],
        },
      };
    }

    const { edges, dependencies } = buildJoinEdges(plan, originalTables);

    interface DPState {
      order: number[];
      cost: number;
      rows: number;
      scanTypes: ('TableScan' | 'IndexScan')[];
      indexNames: (string | undefined)[];
      edgesUsed: JoinEdge[];
    }

    const dp = new Map<number, DPState>();

    // 1. Base states (subsets of size 1)
    for (let i = 0; i < N; i++) {
      if (dependencies[i].size === 0) {
        const base = getSingleTableBaseCost(
          originalTables[i],
          singleTableFilters.get(i) ?? [],
        );
        const mask = 1 << i;
        dp.set(mask, {
          order: [i],
          cost: base.cost,
          rows: base.rows,
          scanTypes: [base.scanType],
          indexNames: [base.indexName],
          edgesUsed: [],
        });
      }
    }

    // 2. Iterate subsets of size 2 .. N
    const totalSubsets = 1 << N;
    for (let size = 2; size <= N; size++) {
      for (let mask = 1; mask < totalSubsets; mask++) {
        if (countBits(mask) !== size) continue;

        for (let nextIdx = 0; nextIdx < N; nextIdx++) {
          if ((mask & (1 << nextIdx)) === 0) continue;

          const prevMask = mask ^ (1 << nextIdx);
          const prevState = dp.get(prevMask);
          if (!prevState) continue;

          let depsSatisfied = true;
          for (const dep of dependencies[nextIdx]) {
            if ((prevMask & (1 << dep)) === 0) {
              depsSatisfied = false;
              break;
            }
          }
          if (!depsSatisfied) continue;

          const evalRes = this.evaluateJoinStep(
            prevState.rows,
            originalTables[nextIdx],
            nextIdx,
            edges,
            prevState.order,
            singleTableFilters.get(nextIdx) ?? [],
          );

          const totalCost = prevState.cost + evalRes.stepCost;
          const existing = dp.get(mask);
          let isBetter = false;

          if (!existing) {
            isBetter = true;
          } else {
            const candidateIndexScans =
              prevState.scanTypes.filter((t) => t === 'IndexScan').length +
              (evalRes.scanType === 'IndexScan' ? 1 : 0);
            const existingIndexScans = existing.scanTypes.filter(
              (t) => t === 'IndexScan',
            ).length;

            if (
              candidateIndexScans > existingIndexScans &&
              totalCost <= existing.cost * 1.2
            ) {
              isBetter = true;
            } else if (candidateIndexScans < existingIndexScans) {
              isBetter = false;
            } else if (totalCost < existing.cost * 0.75) {
              isBetter = true;
            } else if (existing.cost < totalCost * 0.75) {
              isBetter = false;
            } else {
              // Costs are comparable: prefer preserving user's declared driving table (table 0)
              const candidateStartsWithZero = prevState.order[0] === 0;
              const existingStartsWithZero = existing.order[0] === 0;
              if (candidateStartsWithZero && !existingStartsWithZero) {
                isBetter = true;
              } else if (!candidateStartsWithZero && existingStartsWithZero) {
                isBetter = false;
              } else {
                const candidateInversions = prevState.order.filter(
                  (idx) => idx > nextIdx,
                ).length;
                const existingInversions = existing.order.filter(
                  (idx, i) => idx > i,
                ).length;
                if (candidateInversions < existingInversions) {
                  isBetter = true;
                }
              }
            }
          }

          if (isBetter) {
            dp.set(mask, {
              order: [...prevState.order, nextIdx],
              cost: totalCost,
              rows: evalRes.newRows,
              scanTypes: [...prevState.scanTypes, evalRes.scanType],
              indexNames: [...prevState.indexNames, evalRes.indexName],
              edgesUsed: [...prevState.edgesUsed, evalRes.matchedEdge],
            });
          }
        }
      }
    }

    // 3. Retrieve best plan
    const fullMask = (1 << N) - 1;
    const bestState = dp.get(fullMask);

    let winningOrder: number[];
    let winningCost: number;
    let winningRows: number;
    let winningScanTypes: ('TableScan' | 'IndexScan')[];
    let winningIndexNames: (string | undefined)[];

    if (bestState) {
      winningOrder = bestState.order;
      winningCost = bestState.cost;
      winningRows = bestState.rows;
      winningScanTypes = bestState.scanTypes;
      winningIndexNames = bestState.indexNames;
    } else {
      winningOrder = Array.from({ length: N }, (_, i) => i);
      winningCost = 999999;
      winningRows = 100;
      winningScanTypes = Array.from({ length: N }, () => 'TableScan');
      winningIndexNames = Array.from({ length: N }, () => undefined);
    }

    const orderedTables = winningOrder.map((idx) => originalTables[idx]);
    const newJoinedPlans = reconstructJoinPlans(
      winningOrder,
      originalTables,
      edges,
      plan.joinedTables,
    );
    const effectiveSelectExprs = materializeOutputSelectExprs(plan, originalTables);

    return {
      plan: {
        ...plan,
        table: orderedTables[0],
        joinedTables: newJoinedPlans,
        selectExprs: effectiveSelectExprs,
      },
      orderedTables,
      metrics: {
        totalCost: winningCost,
        estimatedRows: winningRows,
        joinOrder: orderedTables.map((t) => t.name),
        singleTableFilters,
        crossFilters,
        tableScanTypes: winningScanTypes,
        tableIndexNames: winningIndexNames,
      },
    };
  }

  private evaluateJoinStep(
    outerRows: number,
    nextTable: TableMeta,
    nextTableIdx: number,
    edges: JoinEdge[],
    plannedTableIndices: number[],
    nextTableFilters: QueryFilter[],
  ): {
    stepCost: number;
    newRows: number;
    scanType: 'TableScan' | 'IndexScan';
    indexName?: string;
    matchedEdge: JoinEdge;
  } {
    const rowCount = Math.max(1, nextTable.rowCountEstimate || 10);
    let filterSel = 1.0;
    for (const f of nextTableFilters) {
      filterSel *= estimateFilterSelectivity(f, nextTable);
    }

    const candidates: {
      edge: JoinEdge;
      nextCol: string;
      outerCol: string;
      idxMatch: { index: any; isUnique: boolean } | null;
    }[] = [];

    for (const edge of edges) {
      if (
        edge.tableA === nextTableIdx &&
        plannedTableIndices.includes(edge.tableB)
      ) {
        const idxMatch = findIndexOnColumn(nextTable, edge.colA);
        candidates.push({
          edge,
          nextCol: edge.colA,
          outerCol: edge.colB,
          idxMatch,
        });
      } else if (
        edge.tableB === nextTableIdx &&
        plannedTableIndices.includes(edge.tableA)
      ) {
        const idxMatch = findIndexOnColumn(nextTable, edge.colB);
        candidates.push({
          edge,
          nextCol: edge.colB,
          outerCol: edge.colA,
          idxMatch,
        });
      }
    }

    if (candidates.length === 0) {
      const stepCost = outerRows * (2.0 + rowCount * 0.1);
      const newRows = Math.max(1, Math.round(outerRows * rowCount * filterSel));
      const fallbackEdge: JoinEdge = {
        tableA: plannedTableIndices[0],
        tableB: nextTableIdx,
        colA: '',
        colB: '',
        op: '=',
        type: 'inner',
        declaredRightTable: nextTableIdx,
      };
      return {
        stepCost,
        newRows,
        scanType: 'TableScan',
        matchedEdge: fallbackEdge,
      };
    }

    candidates.sort((a, b) => {
      const rankA = a.idxMatch ? (a.idxMatch.isUnique ? 1 : 2) : 3;
      const rankB = b.idxMatch ? (b.idxMatch.isUnique ? 1 : 2) : 3;
      return rankA - rankB;
    });

    const bestCand = candidates[0];
    if (bestCand.idxMatch && bestCand.idxMatch.isUnique) {
      const seekCost = this.indexSeekCost + 1 * this.rowEvalCost;
      const stepCost = outerRows * seekCost;
      const newRows = Math.max(1, Math.round(outerRows * filterSel));
      return {
        stepCost,
        newRows,
        scanType: 'IndexScan',
        indexName: bestCand.idxMatch.index.name,
        matchedEdge: bestCand.edge,
      };
    }

    if (bestCand.idxMatch && !bestCand.idxMatch.isUnique) {
      const avgDupes = Math.max(1, Math.min(10, Math.round(rowCount / 20)));
      const seekCost = this.indexSeekCost + avgDupes * this.indexNextCost;
      const stepCost = outerRows * seekCost;
      const newRows = Math.max(1, Math.round(outerRows * avgDupes * filterSel));
      return {
        stepCost,
        newRows,
        scanType: 'IndexScan',
        indexName: bestCand.idxMatch.index.name,
        matchedEdge: bestCand.edge,
      };
    }

    const stepCost = outerRows * (2.0 + rowCount * 0.1);
    const newRows = Math.max(
      1,
      Math.round(outerRows * Math.max(1, Math.round(rowCount * 0.1)) * filterSel),
    );
    return {
      stepCost,
      newRows,
      scanType: 'TableScan',
      matchedEdge: bestCand.edge,
    };
  }
}

function countBits(n: number): number {
  let count = 0;
  let val = n;
  while (val > 0) {
    count += val & 1;
    val >>= 1;
  }
  return count;
}
