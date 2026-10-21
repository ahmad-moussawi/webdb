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
  buildJoinEdges,
  materializeOutputSelectExprs,
  reconstructJoinPlans,
} from './types.js';

export type TableOrderComparator = (a: TableMeta, b: TableMeta) => number;
export type CustomOrderSpec = string[] | TableOrderComparator;

/**
 * CustomOrderPlanner executes joins according to an explicit table order or custom comparator.
 * Join conditions and projections are automatically reconstructed to match the custom table order.
 */
export class CustomOrderPlanner implements QueryPlanner {
  readonly name = 'custom-order';
  private orderSpec?: CustomOrderSpec;

  constructor(orderSpec?: CustomOrderSpec) {
    this.orderSpec = orderSpec;
  }

  optimize(plan: QueryPlan): OptimizedJoinPlanResult {
    const originalTables: TableMeta[] = [
      plan.table,
      ...(plan.joinedTables?.map((j) => j.table) ?? []),
    ];
    const N = originalTables.length;
    const isJoin = plan.joinedTables !== undefined && plan.joinedTables.length > 0;

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

    if (!isJoin || N <= 1) {
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

    // Determine custom order indices
    const customIndices: number[] = Array.from({ length: N }, (_, i) => i);

    if (this.orderSpec) {
      if (typeof this.orderSpec === 'function') {
        const comparator = this.orderSpec;
        customIndices.sort((a, b) => comparator(originalTables[a], originalTables[b]));
      } else if (Array.isArray(this.orderSpec)) {
        const list = this.orderSpec;
        customIndices.sort((a, b) => {
          const nameA = originalTables[a].name;
          const nameB = originalTables[b].name;
          const posA = list.indexOf(nameA);
          const posB = list.indexOf(nameB);
          const priorityA = posA === -1 ? 9999 : posA;
          const priorityB = posB === -1 ? 9999 : posB;
          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }
          return a - b; // preserve original relative order if not in list
        });
      }
    }

    const { edges } = buildJoinEdges(plan, originalTables);
    const orderedTables = customIndices.map((i) => originalTables[i]);
    const newJoinedPlans = reconstructJoinPlans(
      customIndices,
      originalTables,
      edges,
      plan.joinedTables,
    );
    const effectiveSelectExprs = materializeOutputSelectExprs(plan, originalTables);

    const orderedPlan: QueryPlan = {
      ...plan,
      table: orderedTables[0],
      joinedTables: newJoinedPlans,
      selectExprs: effectiveSelectExprs,
    };

    // Rebuild filter pushdowns for the reordered tables
    const reorderedSingleTableFilters = new Map<number, QueryFilter[]>();
    for (let i = 0; i < N; i++) {
      reorderedSingleTableFilters.set(i, []);
    }
    for (const filter of topConjunctions) {
      const refs = getFilterReferencedTables(filter, orderedTables);
      if (refs.size === 1) {
        const tblIdx = refs.values().next().value;
        if (tblIdx !== undefined) {
          reorderedSingleTableFilters.get(tblIdx)?.push(filter);
        }
      }
    }

    const baseTableCost = getSingleTableBaseCost(
      orderedTables[0],
      reorderedSingleTableFilters.get(0) ?? [],
    );

    const tableScanTypes: ('TableScan' | 'IndexScan')[] = [baseTableCost.scanType];
    const tableIndexNames: (string | undefined)[] = [baseTableCost.indexName];
    let totalCost = baseTableCost.cost;
    const estimatedRows = baseTableCost.rows;

    if (orderedPlan.joinedTables) {
      for (let i = 1; i < N; i++) {
        const jPlan = orderedPlan.joinedTables[i - 1];
        const cand = chooseJoinIndex(jPlan, orderedTables[i], i, orderedTables, i);
        if (cand) {
          tableScanTypes.push('IndexScan');
          tableIndexNames.push(cand.index.name);
          totalCost += estimatedRows * 0.55;
        } else {
          tableScanTypes.push('TableScan');
          tableIndexNames.push(undefined);
          totalCost += estimatedRows * (2.0 + (orderedTables[i].rowCountEstimate || 10) * 0.1);
        }
      }
    }

    return {
      plan: orderedPlan,
      orderedTables,
      metrics: {
        totalCost,
        estimatedRows,
        joinOrder: orderedTables.map((t) => t.name),
        singleTableFilters: reorderedSingleTableFilters,
        crossFilters,
        tableScanTypes,
        tableIndexNames,
      },
    };
  }
}
