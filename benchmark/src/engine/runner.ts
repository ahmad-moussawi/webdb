import {
  BenchmarkAdapter,
  BenchmarkRecord,
  OrderRecord,
  BenchmarkRunConfig,
  EngineId,
  ScenarioId,
  ScenarioResult,
} from '../adapters/types.js';
import { createAdapter } from '../adapters/index.js';
import { generateBenchmarkDataset, generateLookupIds, generateOrdersDataset } from './dataset.js';

export interface ProgressUpdate {
  engineId: EngineId;
  engineName: string;
  scenarioId: ScenarioId;
  scenarioIndex: number;
  totalSteps: number;
  currentStep: number;
  status: 'running' | 'completed' | 'error';
  latestResult?: ScenarioResult;
}

function getMemoryUsage(): number | undefined {
  if (typeof performance !== 'undefined' && (performance as any).memory) {
    return (performance as any).memory.usedJSHeapSize;
  }
  return undefined;
}

export async function runBenchmarkSuite(
  config: BenchmarkRunConfig,
  onProgress?: (update: ProgressUpdate) => void,
  shouldAbort?: () => boolean
): Promise<ScenarioResult[]> {
  const allResults: ScenarioResult[] = [];

  // Generate deterministic dataset and lookup IDs once
  const dataset: BenchmarkRecord[] = generateBenchmarkDataset(config.datasetSize);
  const orders: OrderRecord[] = generateOrdersDataset(config.datasetSize);
  const lookupIds: number[] = generateLookupIds(config.datasetSize, 100);

  const totalSteps = config.engines.length * config.scenarios.length;
  let currentStep = 0;

  for (const engineId of config.engines) {
    if (shouldAbort && shouldAbort()) break;

    let adapter: BenchmarkAdapter;
    try {
      adapter = createAdapter(engineId);
    } catch (e: any) {
      console.warn(`Failed to create adapter for ${engineId}:`, e);
      continue;
    }

    try {
      await adapter.init();
    } catch (err: any) {
      console.error(`Init failed for ${adapter.name}:`, err);
      // Mark all scenarios for this engine as failed
      for (const scenarioId of config.scenarios) {
        currentStep++;
        const res: ScenarioResult = {
          engineId,
          scenarioId,
          opsPerSec: 0,
          meanMs: 0,
          minMs: 0,
          maxMs: 0,
          p95Ms: 0,
          samples: 0,
          error: err.message || 'Initialization failed',
        };
        allResults.push(res);
        onProgress?.({
          engineId,
          engineName: adapter.name,
          scenarioId,
          scenarioIndex: config.scenarios.indexOf(scenarioId),
          totalSteps,
          currentStep,
          status: 'error',
          latestResult: res,
        });
      }
      continue;
    }

    let isDataLoaded = false;

    // Execute scenarios
    for (const scenarioId of config.scenarios) {
      if (shouldAbort && shouldAbort()) break;

      currentStep++;
      onProgress?.({
        engineId,
        engineName: adapter.name,
        scenarioId,
        scenarioIndex: config.scenarios.indexOf(scenarioId),
        totalSteps,
        currentStep,
        status: 'running',
      });

      // Brief delay to let UI render and event loop breathe
      await new Promise((r) => setTimeout(r, 40));

      const initialMem = getMemoryUsage();
      const samples: number[] = [];
      let iterations = config.iterations;

      // Adjust iterations for bulk_insert to avoid lengthy runs on large sizes
      if (scenarioId === 'bulk_insert') {
        iterations = Math.min(iterations, 3);
      }

      let errorMsg: string | undefined = undefined;

      try {
        // Pre-run setup: ensure dataset is loaded if bulk_insert hasn't already loaded it
        if (scenarioId !== 'bulk_insert' && !isDataLoaded) {
          await adapter.bulkInsert(dataset, orders);
          isDataLoaded = true;
        }

        // Warmup (1 iteration)
        if (scenarioId !== 'bulk_insert') {
          await executeScenario(adapter, scenarioId, dataset, lookupIds, orders);
        }

        // Iteration runs
        for (let iter = 0; iter < iterations; iter++) {
          if (shouldAbort && shouldAbort()) break;

          // For bulk_insert, ensure each iteration starts with a clean, empty database
          if (scenarioId === 'bulk_insert') {
            await adapter.teardown();
            await adapter.init();
          }

          const start = performance.now();
          await executeScenario(adapter, scenarioId, dataset, lookupIds, orders);
          const end = performance.now();
          samples.push(end - start);
        }

        if (scenarioId === 'bulk_insert') {
          isDataLoaded = true;
        }
      } catch (err: any) {
        console.error(`Error during ${scenarioId} on ${adapter.name}:`, err);
        errorMsg = err.message || String(err);
      }

      const finalMem = getMemoryUsage();
      const memDelta = initialMem && finalMem ? Math.max(0, finalMem - initialMem) : undefined;

      let result: ScenarioResult;

      if (errorMsg || samples.length === 0) {
        result = {
          engineId,
          scenarioId,
          opsPerSec: 0,
          meanMs: 0,
          minMs: 0,
          maxMs: 0,
          p95Ms: 0,
          samples: 0,
          memoryDeltaBytes: memDelta,
          error: errorMsg || 'Unknown error occurred',
        };
      } else {
        samples.sort((a, b) => a - b);
        const sum = samples.reduce((acc, v) => acc + v, 0);
        const mean = sum / samples.length;
        const min = samples[0];
        const max = samples[samples.length - 1];
        const p95Idx = Math.floor(samples.length * 0.95);
        const p95 = samples[Math.min(p95Idx, samples.length - 1)];

        // Compute operations per second:
        // For point_lookup: 100 lookups per call
        // For bulk_insert: datasetSize inserts per call
        // For queries: 1 query execution per call
        let opsMultiplier = 1;
        if (scenarioId === 'point_lookup') opsMultiplier = 100;
        else if (scenarioId === 'bulk_insert') opsMultiplier = config.datasetSize;

        const opsPerSec = mean > 0 ? (1000 / mean) * opsMultiplier : 0;

        result = {
          engineId,
          scenarioId,
          opsPerSec: Math.round(opsPerSec * 10) / 10,
          meanMs: Math.round(mean * 100) / 100,
          minMs: Math.round(min * 100) / 100,
          maxMs: Math.round(max * 100) / 100,
          p95Ms: Math.round(p95 * 100) / 100,
          samples: samples.length,
          memoryDeltaBytes: memDelta,
        };
      }

      allResults.push(result);
      onProgress?.({
        engineId,
        engineName: adapter.name,
        scenarioId,
        scenarioIndex: config.scenarios.indexOf(scenarioId),
        totalSteps,
        currentStep,
        status: errorMsg ? 'error' : 'completed',
        latestResult: result,
      });
    }

    try {
      await adapter.teardown();
    } catch (e) {
      console.warn(`Teardown error for ${adapter.name}:`, e);
    }

    // Cooling pause between engines
    await new Promise((r) => setTimeout(r, 60));
  }

  return allResults;
}

async function executeScenario(
  adapter: BenchmarkAdapter,
  scenarioId: ScenarioId,
  dataset: BenchmarkRecord[],
  lookupIds: number[],
  orders: OrderRecord[]
): Promise<any> {
  switch (scenarioId) {
    case 'bulk_insert':
      return await adapter.bulkInsert(dataset, orders);
    case 'point_lookup':
      return await adapter.pointLookup(lookupIds);
    case 'range_scan':
      return await adapter.rangeScan(25, 40);
    case 'sort_limit':
      return await adapter.sortLimit(10);
    case 'aggregation':
      return await adapter.aggregation();
    case 'join_query':
      return await adapter.joinQuery();
    default:
      throw new Error(`Unsupported scenario: ${scenarioId}`);
  }
}
