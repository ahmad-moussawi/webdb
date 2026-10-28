import { TableMeta } from '../../../types/index.js';
import { QueryFilter } from '../compiler.js';
import { WhereMetrics } from './types.js';

/**
 * Assigns an estimated relative CPU/evaluation cost to a filter for optimal short-circuit reordering.
 * Lower numbers = cheaper to evaluate -> placed first in execution.
 */
export function estimateWhereCost(filter: QueryFilter, tables?: TableMeta[]): number {
  if (filter.type === 'null') {
    return 1;
  }

  if (filter.type === 'cmp') {
    const op = filter.op ?? '=';
    if (op === 'like' || op === 'not like') {
      const val = typeof filter.value === 'string' ? filter.value : '';
      return val.startsWith('%') ? 25 : 15;
    }

    let isNumeric = false;
    if (tables && filter.colName) {
      const colNameLower = filter.colName.toLowerCase();
      const colBase = colNameLower.includes('.')
        ? colNameLower.slice(colNameLower.lastIndexOf('.') + 1)
        : colNameLower;

      for (const t of tables) {
        const c = t.columns.find((col) => col.name.toLowerCase() === colBase);
        if (c) {
          isNumeric = c.type === 1 || c.type === 2 || c.type === 3;
          break;
        }
      }
    } else if (typeof filter.value === 'number') {
      isNumeric = true;
    }

    if (op === '=' || (op as string) === '==') {
      return isNumeric ? 2 : 4;
    }
    return isNumeric ? 3 : 6;
  }

  if (filter.type === 'in') {
    const count = filter.values?.length ?? 0;
    return count <= 3 ? 5 : 10;
  }

  if (filter.type === 'expr') {
    return 40;
  }

  if (filter.type === 'and' || filter.type === 'or') {
    return 15;
  }

  if (filter.type === 'not') {
    return 8;
  }

  return 10;
}

/**
 * Optimizes an array of query filters by:
 * 1. Detecting contradictions (short-circuiting).
 * 2. Pruning redundant duplicates and subsumed range bounds.
 * 3. Reordering filters by evaluation cost.
 */
export function optimizeWherePredicates(
  filters: QueryFilter[],
  tables?: TableMeta[],
): {
  filters: QueryFilter[];
  isAlwaysFalse: boolean;
  isAlwaysTrue: boolean;
  metrics: WhereMetrics;
} {
  if (!filters || filters.length === 0) {
    return {
      filters: [],
      isAlwaysFalse: false,
      isAlwaysTrue: true,
      metrics: {
        originalCount: 0,
        optimizedCount: 0,
        isAlwaysFalse: false,
        isAlwaysTrue: true,
        eliminatedFiltersCount: 0,
        reordered: false,
      },
    };
  }

  const originalCount = filters.length;

  // 1. Flatten top-level AND conjunctions
  const flattened: QueryFilter[] = [];
  for (const f of filters) {
    if (f.type === 'and' && Array.isArray(f.children)) {
      flattened.push(...f.children);
    } else {
      flattened.push(f);
    }
  }

  // 2. Group top-level filters by column
  const byColumn = new Map<string, QueryFilter[]>();
  const nonColumnFilters: QueryFilter[] = [];

  for (const f of flattened) {
    if (f.colName) {
      const colKey = f.colName.toLowerCase();
      if (!byColumn.has(colKey)) {
        byColumn.set(colKey, []);
      }
      byColumn.get(colKey)!.push(f);
    } else {
      nonColumnFilters.push(f);
    }
  }

  // Check for contradiction across all filters
  for (const [colKey, colFilters] of byColumn.entries()) {
    const contradiction = checkColumnContradiction(colFilters);
    if (contradiction) {
      return {
        filters: [],
        isAlwaysFalse: true,
        isAlwaysTrue: false,
        metrics: {
          originalCount,
          optimizedCount: 0,
          isAlwaysFalse: true,
          isAlwaysTrue: false,
          contradictionReason: `Contradiction on column "${colKey}": ${contradiction}`,
          eliminatedFiltersCount: originalCount,
          reordered: false,
        },
      };
    }
  }

  // 3. Optimize and prune redundant filters per column
  const optimizedFilters: QueryFilter[] = [];
  let eliminatedCount = 0;

  for (const [, colFilters] of byColumn.entries()) {
    const pruned = pruneColumnFilters(colFilters);
    eliminatedCount += colFilters.length - pruned.length;
    optimizedFilters.push(...pruned);
  }

  optimizedFilters.push(...nonColumnFilters);

  // 4. Cost-based predicate reordering
  const originalOrderKey = optimizedFilters.map((f) => filterSignature(f)).join('|');
  optimizedFilters.sort((a, b) => {
    const costA = estimateWhereCost(a, tables);
    const costB = estimateWhereCost(b, tables);
    return costA - costB;
  });
  const newOrderKey = optimizedFilters.map((f) => filterSignature(f)).join('|');
  const reordered = originalOrderKey !== newOrderKey;

  return {
    filters: optimizedFilters,
    isAlwaysFalse: false,
    isAlwaysTrue: optimizedFilters.length === 0,
    metrics: {
      originalCount,
      optimizedCount: optimizedFilters.length,
      isAlwaysFalse: false,
      isAlwaysTrue: optimizedFilters.length === 0,
      eliminatedFiltersCount: eliminatedCount,
      reordered,
    },
  };
}

function checkColumnContradiction(filters: QueryFilter[]): string | null {
  let hasIsNull = false;
  let hasIsNotNull = false;
  const equalityValues: any[] = [];
  let lowerBound: { val: number; strict: boolean } | null = null;
  let upperBound: { val: number; strict: boolean } | null = null;
  let inSet: Set<any> | null = null;

  for (const f of filters) {
    if (f.type === 'null') {
      if (f.isNull === true) hasIsNull = true;
      if (f.isNull === false) hasIsNotNull = true;
    }

    if (f.type === 'cmp') {
      const op = f.op ?? '=';
      const val = f.value;

      if (op === '=' && val !== null && val !== undefined) {
        equalityValues.push(val);
      }

      if (typeof val === 'number') {
        if (op === '>') {
          if (!lowerBound || val > lowerBound.val || (val === lowerBound.val && !lowerBound.strict)) {
            lowerBound = { val, strict: true };
          }
        } else if (op === '>=') {
          if (!lowerBound || val > lowerBound.val) {
            lowerBound = { val, strict: false };
          }
        } else if (op === '<') {
          if (!upperBound || val < upperBound.val || (val === upperBound.val && !upperBound.strict)) {
            upperBound = { val, strict: true };
          }
        } else if (op === '<=') {
          if (!upperBound || val < upperBound.val) {
            upperBound = { val, strict: false };
          }
        }
      }
    }

    if (f.type === 'in' && !f.notIn) {
      if (!f.values || f.values.length === 0) {
        return 'Empty IN () list';
      }
      const currentSet = new Set(f.values);
      if (!inSet) {
        inSet = currentSet;
      } else {
        const intersected: Set<any> = new Set([...inSet].filter((x) => currentSet.has(x)));
        if (intersected.size === 0) {
          return 'Mutually exclusive IN lists with no common values';
        }
        inSet = intersected;
      }
    }
  }

  if (hasIsNull && hasIsNotNull) {
    return 'Conflicting IS NULL and IS NOT NULL';
  }

  if (hasIsNull && (equalityValues.length > 0 || lowerBound || upperBound)) {
    return 'Conflicting IS NULL and literal comparison';
  }

  if (equalityValues.length > 1) {
    const first = equalityValues[0];
    for (let i = 1; i < equalityValues.length; i++) {
      if (equalityValues[i] !== first) {
        return `Conflicting equality values (${first} !== ${equalityValues[i]})`;
      }
    }
  }

  if (equalityValues.length > 0 && (lowerBound || upperBound)) {
    const eqVal = equalityValues[0];
    if (typeof eqVal === 'number') {
      if (lowerBound) {
        if (lowerBound.strict ? eqVal <= lowerBound.val : eqVal < lowerBound.val) {
          return `Equality value ${eqVal} violates lower bound ${lowerBound.strict ? '>' : '>='} ${lowerBound.val}`;
        }
      }
      if (upperBound) {
        if (upperBound.strict ? eqVal >= upperBound.val : eqVal > upperBound.val) {
          return `Equality value ${eqVal} violates upper bound ${upperBound.strict ? '<' : '<='} ${upperBound.val}`;
        }
      }
    }
  }

  if (equalityValues.length > 0 && inSet) {
    const eqVal = equalityValues[0];
    if (!inSet.has(eqVal)) {
      return `Equality value ${eqVal} not present in IN list`;
    }
  }

  if (lowerBound && upperBound) {
    if (lowerBound.val > upperBound.val) {
      return `Lower bound ${lowerBound.val} is greater than upper bound ${upperBound.val}`;
    }
    if (lowerBound.val === upperBound.val && (lowerBound.strict || upperBound.strict)) {
      return `Strict range bounds empty at ${lowerBound.val}`;
    }
  }

  return null;
}

function pruneColumnFilters(filters: QueryFilter[]): QueryFilter[] {
  const result: QueryFilter[] = [];
  const seenSignatures = new Set<string>();

  let hasEqualityOnNonNull = false;
  let singleEqualityValue: any = undefined;

  for (const f of filters) {
    if (f.type === 'cmp' && (f.op === '=' || f.op === undefined) && f.value !== null && f.value !== undefined) {
      hasEqualityOnNonNull = true;
      singleEqualityValue = f.value;
      break;
    }
  }

  let bestLower: { val: number; strict: boolean; filter: QueryFilter } | null = null;
  let bestUpper: { val: number; strict: boolean; filter: QueryFilter } | null = null;

  for (const f of filters) {
    if (f.type === 'cmp' && typeof f.value === 'number') {
      const op = f.op ?? '=';
      const val = f.value;
      if (op === '>') {
        if (!bestLower || val > bestLower.val || (val === bestLower.val && !bestLower.strict)) {
          bestLower = { val, strict: true, filter: f };
        }
      } else if (op === '>=') {
        if (!bestLower || val > bestLower.val) {
          bestLower = { val, strict: false, filter: f };
        }
      } else if (op === '<') {
        if (!bestUpper || val < bestUpper.val || (val === bestUpper.val && !bestUpper.strict)) {
          bestUpper = { val, strict: true, filter: f };
        }
      } else if (op === '<=') {
        if (!bestUpper || val < bestUpper.val) {
          bestUpper = { val, strict: false, filter: f };
        }
      }
    }
  }

  for (const f of filters) {
    const sig = filterSignature(f);
    if (seenSignatures.has(sig)) {
      continue;
    }

    if (f.type === 'null' && f.isNull === false && hasEqualityOnNonNull) {
      continue;
    }

    if (f.type === 'in' && !f.notIn && hasEqualityOnNonNull && Array.isArray(f.values) && f.values.includes(singleEqualityValue)) {
      continue;
    }

    if (f.type === 'cmp' && typeof f.value === 'number') {
      const op = f.op ?? '=';
      if (op === '>' || op === '>=') {
        if (bestLower && f !== bestLower.filter) {
          continue;
        }
      } else if (op === '<' || op === '<=') {
        if (bestUpper && f !== bestUpper.filter) {
          continue;
        }
      }
    }

    seenSignatures.add(sig);
    result.push(f);
  }

  return result;
}

function filterSignature(f: QueryFilter): string {
  return `${f.type}:${f.colName ?? ''}:${f.isNull ?? ''}:${f.op ?? ''}:${String(f.value ?? '')}:${f.notIn ?? ''}:${JSON.stringify(f.values ?? '')}`;
}

/**
 * Infers transitive equality predicates across inner/left joins.
 */
export function inferTransitivePredicates(
  filters: QueryFilter[],
  joinedPlans: { leftCol: string; op: string; rightCol: string; type: string }[],
): QueryFilter[] {
  const result = [...filters];
  const normalize = (c: string) => c.toLowerCase();
  const getBaseName = (c: string) => {
    const idx = c.lastIndexOf('.');
    return idx >= 0 ? c.slice(idx + 1).toLowerCase() : c.toLowerCase();
  };

  const findEqualityValue = (col: string): any => {
    const colNorm = normalize(col);
    const colBase = getBaseName(col);
    for (const f of filters) {
      if (
        f.type === 'cmp' &&
        (f.op === '=' || (f.op as string) === '==' || f.op === undefined) &&
        f.colName &&
        f.value !== null &&
        f.value !== undefined
      ) {
        const fNorm = normalize(f.colName);
        const fBase = getBaseName(f.colName);
        if (fNorm === colNorm || fBase === colNorm || fNorm === colBase) {
          return f.value;
        }
      }
    }
    return undefined;
  };

  for (const j of joinedPlans) {
    if (j.type !== 'inner' && j.type !== 'left') {
      continue;
    }
    if (j.op !== '=' && (j.op as string) !== '==') {
      continue;
    }

    const leftVal = findEqualityValue(j.leftCol);
    if (leftVal !== undefined) {
      result.push({
        type: 'cmp',
        colName: j.rightCol,
        op: '=',
        value: leftVal,
      });
    }

    if (j.type === 'inner') {
      const rightVal = findEqualityValue(j.rightCol);
      if (rightVal !== undefined) {
        result.push({
          type: 'cmp',
          colName: j.leftCol,
          op: '=',
          value: rightVal,
        });
      }
    }
  }

  return result;
}
