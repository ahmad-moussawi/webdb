import { QueryPlan } from '../compiler.js';
import {
  QueryPlanner,
  QueryPlannerClass,
  OptimizedJoinPlanResult,
} from './types.js';
import { CostBasedPlanner } from './cost.js';

export * from './types.js';
export * from './cost.js';
export * from './heuristic.js';
export * from './noop.js';
export * from './custom_order.js';

const defaultPlanner = new CostBasedPlanner();

/**
 * Resolves a planner instance from a QueryPlanner instance, class constructor, or defaults to CostBasedPlanner.
 */
export function resolvePlanner(
  planner?: QueryPlanner | QueryPlannerClass | null,
): QueryPlanner {
  if (!planner) {
    return defaultPlanner;
  }
  if (typeof planner === 'function') {
    return new (planner as QueryPlannerClass)();
  }
  return planner;
}

/**
 * Optimizes a QueryPlan using the given planner (or the default CostBasedPlanner).
 */
export function optimizeJoinPlan(
  plan: QueryPlan,
  planner?: QueryPlanner | QueryPlannerClass | null,
): OptimizedJoinPlanResult {
  const activePlanner = resolvePlanner(planner);
  return activePlanner.optimize(plan);
}
