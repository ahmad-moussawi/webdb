import { QueryPlan } from '../compiler.js';
import {
  QueryPlanner,
  OptimizedPlanResult,
} from './types.js';
import { CostBasedPlanner } from './cost.js';
import { HeuristicPlanner } from './heuristic.js';
import { NoOpPlanner } from './noop.js';

export * from './types.js';
export * from './cost.js';
export * from './heuristic.js';
export * from './noop.js';
export * from './custom_order.js';
export * from './where_optimizer.js';

/**
 * CustomPlanner allows supplying a custom optimization function.
 */
export class CustomPlanner implements QueryPlanner {
  readonly name = 'custom';
  constructor(private fn: (plan: QueryPlan) => OptimizedPlanResult) {}
  optimize(plan: QueryPlan): OptimizedPlanResult {
    return this.fn(plan);
  }
}

export const CustomQueryPlanner = CustomPlanner;
export const DefaultQueryPlanner = CostBasedPlanner;
export const CostBasedQueryPlanner = CostBasedPlanner;
export const HeuristicQueryPlanner = HeuristicPlanner;
export const NoOpQueryPlanner = NoOpPlanner;

const defaultPlanner = new CostBasedPlanner();

/**
 * Resolves a QueryPlanner instance, defaulting to CostBasedPlanner.
 */
export function resolveQueryPlanner(
  planner?: QueryPlanner | null,
): QueryPlanner {
  return planner ?? defaultPlanner;
}

/**
 * Optimizes a complete QueryPlan using the resolved QueryPlanner.
 */
export function optimizeQueryPlan(
  plan: QueryPlan,
  planner?: QueryPlanner | null,
): OptimizedPlanResult {
  const activePlanner = resolveQueryPlanner(planner);
  return activePlanner.optimize(plan);
}
