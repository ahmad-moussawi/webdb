import { TableMeta } from '../../../types/index.js';
import {
  QueryPlan,
  QueryFilter,
  buildRootFilter,
  getTopLevelConjunctionFilters,
  chooseJoinIndex,
} from '../compiler.js';
import {
  QueryPlanner,
  OptimizedJoinPlanResult,
  getFilterReferencedTables,
  getSingleTableBaseCost,
  materializeOutputSelectExprs,
} from './types.js';

/**
 * NoOpPlanner preserves the exact declared query join order (straight join).
 * It still partitions single-table filters for early pushdown without reordering tables.
 */
export class NoOpPlanner implements QueryPlanner {
  readonly name = 'noop';

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

    const baseTableCost = getSingleTableBaseCost(
      originalTables[0],
      singleTableFilters.get(0) ?? [],
    );

    const tableScanTypes: ('TableScan' | 'IndexScan')[] = [baseTableCost.scanType];
    const tableIndexNames: (string | undefined)[] = [baseTableCost.indexName];
    let totalCost = baseTableCost.cost;
    const estimatedRows = baseTableCost.rows;

    if (plan.joinedTables) {
      for (let i = 1; i < N; i++) {
        const jPlan = plan.joinedTables[i - 1];
        const cand = chooseJoinIndex(jPlan, originalTables[i], i, originalTables, i);
        if (cand) {
          tableScanTypes.push('IndexScan');
          tableIndexNames.push(cand.index.name);
          totalCost += estimatedRows * 0.55;
        } else {
          tableScanTypes.push('TableScan');
          tableIndexNames.push(undefined);
          totalCost += estimatedRows * (2.0 + (originalTables[i].rowCountEstimate || 10) * 0.1);
        }
      }
    }

    const effectiveSelectExprs = materializeOutputSelectExprs(plan, originalTables);

    return {
      plan: {
        ...plan,
        selectExprs: effectiveSelectExprs,
      },
      orderedTables: originalTables,
      metrics: {
        totalCost,
        estimatedRows,
        joinOrder: originalTables.map((t) => t.name),
        singleTableFilters,
        crossFilters,
        tableScanTypes,
        tableIndexNames,
      },
    };
  }
}
