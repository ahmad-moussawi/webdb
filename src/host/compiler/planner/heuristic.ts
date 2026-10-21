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
  getFilterReferencedTables,
  getSingleTableBaseCost,
  findIndexOnColumn,
  buildJoinEdges,
  materializeOutputSelectExprs,
  reconstructJoinPlans,
  COST_INDEX_SEEK,
  COST_INDEX_NEXT,
  COST_ROW_EVAL,
} from './types.js';

/**
 * HeuristicPlanner performs greedy nearest-neighbor join ordering.
 * It is fast (O(N^2)), lightweight, and handles common join patterns without full DP enumeration.
 */
export class HeuristicPlanner implements QueryPlanner {
  readonly name = 'heuristic';

  optimize(plan: QueryPlan): OptimizedJoinPlanResult {
    const originalTables: TableMeta[] = [
      plan.table,
      ...(plan.joinedTables?.map((j) => j.table) ?? []),
    ];
    const N = originalTables.length;

    const rootFilter = buildRootFilter(plan.filters);
    const topConjunctions = getTopLevelConjunctionFilters(rootFilter);

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

    // Compute base costs for each table as a candidate driving table
    const baseStats = originalTables.map((t, idx) =>
      getSingleTableBaseCost(t, singleTableFilters.get(idx) ?? []),
    );

    // Step 1: Pick best driving table
    // Candidates are tables with 0 unmet dependencies
    const validDrivingCandidates: number[] = [];
    for (let i = 0; i < N; i++) {
      if (dependencies[i].size === 0) {
        validDrivingCandidates.push(i);
      }
    }

    // Sort driving candidates: lowest rows first, tie-break by index scan, then table 0
    validDrivingCandidates.sort((a, b) => {
      if (baseStats[a].rows !== baseStats[b].rows) {
        return baseStats[a].rows - baseStats[b].rows;
      }
      const aIsIndex = baseStats[a].scanType === 'IndexScan' ? 1 : 0;
      const bIsIndex = baseStats[b].scanType === 'IndexScan' ? 1 : 0;
      if (aIsIndex !== bIsIndex) return bIsIndex - aIsIndex;
      // Prefer table 0
      if (a === 0) return -1;
      if (b === 0) return 1;
      return a - b;
    });

    const drivingIdx = validDrivingCandidates[0] ?? 0;
    const winningOrder: number[] = [drivingIdx];
    const chosenScanTypes: ('TableScan' | 'IndexScan')[] = [baseStats[drivingIdx].scanType];
    const chosenIndexNames: (string | undefined)[] = [baseStats[drivingIdx].indexName];
    let totalCost = baseStats[drivingIdx].cost;
    let currentRows = baseStats[drivingIdx].rows;

    const remaining = new Set<number>();
    for (let i = 0; i < N; i++) {
      if (i !== drivingIdx) remaining.add(i);
    }

    // Step 2: Greedily pick next table
    while (remaining.size > 0) {
      const candidates: {
        tableIdx: number;
        rank: number;
        stepCost: number;
        newRows: number;
        scanType: 'TableScan' | 'IndexScan';
        indexName?: string;
      }[] = [];

      for (const nextIdx of remaining) {
        // Check dependencies
        let depsSatisfied = true;
        for (const dep of dependencies[nextIdx]) {
          if (!winningOrder.includes(dep)) {
            depsSatisfied = false;
            break;
          }
        }
        if (!depsSatisfied) continue;

        // Check join edges connecting winningOrder to nextIdx
        const nextTable = originalTables[nextIdx];
        const rowCount = Math.max(1, nextTable.rowCountEstimate || 10);
        let bestEdgeMatch: { isUnique: boolean; indexName: string } | null = null;

        for (const edge of edges) {
          if (edge.tableA === nextIdx && winningOrder.includes(edge.tableB)) {
            const idx = findIndexOnColumn(nextTable, edge.colA);
            if (idx && (!bestEdgeMatch || idx.isUnique)) {
              bestEdgeMatch = { isUnique: idx.isUnique, indexName: idx.index.name };
            }
          } else if (edge.tableB === nextIdx && winningOrder.includes(edge.tableA)) {
            const idx = findIndexOnColumn(nextTable, edge.colB);
            if (idx && (!bestEdgeMatch || idx.isUnique)) {
              bestEdgeMatch = { isUnique: idx.isUnique, indexName: idx.index.name };
            }
          }
        }

        if (bestEdgeMatch) {
          if (bestEdgeMatch.isUnique) {
            // Rank 1: Unique index join
            const seekCost = COST_INDEX_SEEK + 1 * COST_ROW_EVAL;
            candidates.push({
              tableIdx: nextIdx,
              rank: 1,
              stepCost: currentRows * seekCost,
              newRows: Math.max(1, currentRows),
              scanType: 'IndexScan',
              indexName: bestEdgeMatch.indexName,
            });
          } else {
            // Rank 2: Non-unique index join
            const avgDupes = Math.max(1, Math.min(10, Math.round(rowCount / 20)));
            const seekCost = COST_INDEX_SEEK + avgDupes * COST_INDEX_NEXT;
            candidates.push({
              tableIdx: nextIdx,
              rank: 2,
              stepCost: currentRows * seekCost,
              newRows: Math.max(1, currentRows * avgDupes),
              scanType: 'IndexScan',
              indexName: bestEdgeMatch.indexName,
            });
          }
        } else {
          // Rank 3: Cartesian / unindexed scan
          candidates.push({
            tableIdx: nextIdx,
            rank: 3,
            stepCost: currentRows * (2.0 + rowCount * 0.1),
            newRows: Math.max(1, currentRows * Math.max(1, Math.round(rowCount * 0.1))),
            scanType: 'TableScan',
          });
        }
      }

      if (candidates.length === 0) {
        // Fallback: pick any remaining table satisfying dependencies
        const fallbackIdx = remaining.values().next().value;
        if (fallbackIdx === undefined) break;
        winningOrder.push(fallbackIdx);
        chosenScanTypes.push('TableScan');
        chosenIndexNames.push(undefined);
        remaining.delete(fallbackIdx);
        continue;
      }

      // Sort candidates by rank, then stepCost, then table index
      candidates.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (Math.abs(a.stepCost - b.stepCost) > 0.05) return a.stepCost - b.stepCost;
        return a.tableIdx - b.tableIdx;
      });

      const chosen = candidates[0];
      winningOrder.push(chosen.tableIdx);
      chosenScanTypes.push(chosen.scanType);
      chosenIndexNames.push(chosen.indexName);
      totalCost += chosen.stepCost;
      currentRows = chosen.newRows;
      remaining.delete(chosen.tableIdx);
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
        totalCost,
        estimatedRows: currentRows,
        joinOrder: orderedTables.map((t) => t.name),
        singleTableFilters,
        crossFilters,
        tableScanTypes: chosenScanTypes,
        tableIndexNames: chosenIndexNames,
      },
    };
  }
}
