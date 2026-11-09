/**
 * WebDB Vectorized UDF Benchmark Runner.
 * Compares Scalar execution (row-by-row dispatch) vs Vector execution (128-row batchCall).
 */

import { WebDB, DataType, col, fn, ExpressionBuilder } from '@ahmadmoussawi/webdb';
import { formatDate, formatCurrency, slugify, regexpMatch } from '@ahmadmoussawi/webdb/intl';

const lit = (v: any) => new ExpressionBuilder({ type: 'literal', value: v } as any);

export type UdfWorkloadId =
  | 'math_calc'
  | 'intl_date'
  | 'intl_currency'
  | 'text_slugify'
  | 'regex_match'
  | 'where_filter';

export interface UdfWorkloadInfo {
  id: UdfWorkloadId;
  name: string;
  category: 'numeric' | 'formatting' | 'text' | 'filter';
  description: string;
  queryHint: string;
  scalarSnippet: string;
  vectorSnippet: string;
}

export const UDF_WORKLOADS: UdfWorkloadInfo[] = [
  {
    id: 'math_calc',
    name: '1. Math & Polynomial Formula',
    category: 'numeric',
    description: 'Multi-parameter numerical formula: (amount * 1.0825) - (amount * (discount / 100)) + 4.99.',
    queryHint: "SELECT id, calc_discount(amount, discount) as final_price FROM items",
    scalarSnippet: "call: (amount, discount) => (amount * 1.0825) - (amount * (discount / 100)) + 4.99",
    vectorSnippet: `batchCall: (batch) => {
  const n = batch.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = batch[i];
    out[i] = (row[0] * 1.0825) - (row[0] * (row[1] / 100)) + 4.99;
  }
  return out;
}`,
  },
  {
    id: 'intl_date',
    name: '2. Intl Date Formatting',
    category: 'formatting',
    description: "Converts Unix epoch timestamp to localized date string with Intl.DateTimeFormat ('medium').",
    queryHint: "SELECT id, format_date(created_at, 'medium') as formatted_date FROM items",
    scalarSnippet: "call: (ts) => formatDate(ts, 'medium', 'en-US')",
    vectorSnippet: `batchCall: (batch) => {
  const n = batch.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = formatDate(batch[i][0], 'medium', 'en-US');
  }
  return out;
}`,
  },
  {
    id: 'intl_currency',
    name: '3. Intl Currency Formatting',
    category: 'formatting',
    description: "Formats numeric price into localized currency string ($X,XXX.XX) using Intl.NumberFormat.",
    queryHint: "SELECT id, format_currency(amount, 'USD') as formatted_price FROM items",
    scalarSnippet: "call: (amt) => formatCurrency(amt, 'USD', 'en-US')",
    vectorSnippet: `batchCall: (batch) => {
  const n = batch.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = formatCurrency(batch[i][0], 'USD', 'en-US');
  }
  return out;
}`,
  },
  {
    id: 'text_slugify',
    name: '4. Text Slugify & Normalization',
    category: 'text',
    description: 'Unicode diacritic stripping, lowercasing, and regex hyphens for URL slugs.',
    queryHint: 'SELECT id, slugify(name) as slug FROM items',
    scalarSnippet: 'call: (str) => slugify(str)',
    vectorSnippet: `batchCall: (batch) => {
  const n = batch.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = slugify(batch[i][0]);
  }
  return out;
}`,
  },
  {
    id: 'regex_match',
    name: '5. Regex Pattern Validation',
    category: 'text',
    description: "Validates string SKU pattern using regular expression: /^[A-Z]{3}-\\d{4}$/.",
    queryHint: "SELECT id, regexp_match(sku, '^[A-Z]{3}-\\d{4}$') as is_valid FROM items",
    scalarSnippet: "call: (val, pat) => regexpMatch(val, pat)",
    vectorSnippet: `batchCall: (batch) => {
  const n = batch.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = regexpMatch(batch[i][0], batch[i][1]);
  }
  return out;
}`,
  },
  {
    id: 'where_filter',
    name: '6. WHERE Predicate Filtering',
    category: 'filter',
    description: 'Filters rows during table scan using custom predicate: WHERE is_premium(score, amount) = 1.',
    queryHint: 'SELECT id, name, score FROM items WHERE is_premium(score, amount) = 1',
    scalarSnippet: 'call: (score, amount) => (score > 60 && amount > 150 ? 1 : 0)',
    vectorSnippet: `batchCall: (batch) => {
  const n = batch.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = batch[i][0] > 60 && batch[i][1] > 150 ? 1 : 0;
  }
  return out;
}`,
  },
];

export interface WorkloadMetrics {
  meanMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  opsPerSec: number;
  samples: number[];
}

export interface UdfComparisonResult {
  workloadId: UdfWorkloadId;
  workloadName: string;
  datasetSize: number;
  iterations: number;
  scalar: WorkloadMetrics;
  vector: WorkloadMetrics;
  speedup: number; // scalar.meanMs / vector.meanMs
  timeSavedPercent: number; // ((scalar.meanMs - vector.meanMs) / scalar.meanMs) * 100
  latencyDiffMs: number; // scalar.meanMs - vector.meanMs
}

export interface UdfProgressUpdate {
  workloadId: UdfWorkloadId;
  workloadName: string;
  workloadIndex: number;
  totalWorkloads: number;
  phase: 'seeding' | 'scalar' | 'vector' | 'completed';
  latestResult?: UdfComparisonResult;
}

export interface UdfBenchmarkConfig {
  datasetSize: number;
  iterations: number;
  workloads: UdfWorkloadId[];
}

function computeMetrics(samples: number[], datasetSize: number): WorkloadMetrics {
  if (samples.length === 0) {
    return { meanMs: 0, minMs: 0, maxMs: 0, p95Ms: 0, opsPerSec: 0, samples: [] };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const meanMs = sum / sorted.length;
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95Ms = sorted[p95Idx];
  const opsPerSec = meanMs > 0 ? (datasetSize / (meanMs / 1000)) : 0;

  return {
    meanMs,
    minMs,
    maxMs,
    p95Ms,
    opsPerSec,
    samples: sorted,
  };
}

/**
 * Executes the dedicated WebDB Vectorized UDF benchmark suite.
 */
export async function runUdfBenchmarkSuite(
  config: UdfBenchmarkConfig,
  onProgress?: (update: UdfProgressUpdate) => void,
  shouldAbort?: () => boolean
): Promise<UdfComparisonResult[]> {
  const results: UdfComparisonResult[] = [];
  const dbName = `webdb_bench_udf_${Date.now()}`;
  const db = await WebDB.open({ name: dbName });

  try {
    // 1. Create table
    await db.createTable('items', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'name', type: 'TEXT' },
      { name: 'amount', type: 'FLOAT64' },
      { name: 'discount', type: 'FLOAT64' },
      { name: 'score', type: 'FLOAT64' },
      { name: 'sku', type: 'TEXT' },
      { name: 'created_at', type: 'FLOAT64' },
    ]);

    // 2. Generate deterministic dataset
    const records = new Array(config.datasetSize);
    const baseTs = 1794234600000; // 2026-11-09T14:30:00Z
    const productNames = [
      'Pro Developer Laptop 16GB',
      'Ergonomic Mechanical Keyboard RGB',
      'Ultra Wireless Precision Mouse',
      '4K Ultra HD Curved Monitor 32"',
      'Noise Cancelling Studio Headphones',
      'USB-C Multi-Port Thunderbolt Dock',
      'Standing Desk Dual Motor Frame',
      'High-Speed NVMe Solid State Drive 2TB',
    ];

    for (let i = 0; i < config.datasetSize; i++) {
      const idx = i + 1;
      const nameTemplate = productNames[i % productNames.length];
      records[i] = {
        id: idx,
        name: `${nameTemplate} #${idx} (Café Edition)`,
        amount: Math.round((19.99 + (i % 250) * 3.75) * 100) / 100,
        discount: (i % 20) * 2,
        score: 20 + (i % 80),
        sku: `SKU-${String(i % 1000).padStart(4, '0')}`,
        created_at: baseTs - (i % 365) * 86_400_000,
      };
    }

    if (onProgress) {
      onProgress({
        workloadId: config.workloads[0],
        workloadName: 'Seeding dataset',
        workloadIndex: 0,
        totalWorkloads: config.workloads.length,
        phase: 'seeding',
      });
    }

    await db.insertMany('items', records);

    // 3. Run selected workloads
    for (let wIdx = 0; wIdx < config.workloads.length; wIdx++) {
      if (shouldAbort && shouldAbort()) break;

      const workloadId = config.workloads[wIdx];
      const workloadInfo = UDF_WORKLOADS.find((w) => w.id === workloadId)!;

      // Define runner query builder factory
      let runQuery: () => Promise<any[]>;

      switch (workloadId) {
        case 'math_calc': {
          const scalarMath = (a: any, d: any) =>
            (Number(a) * 1.0825) - (Number(a) * (Number(d) / 100)) + 4.99;
          const vectorMath = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              const row = batch[i];
              out[i] = (Number(row[0]) * 1.0825) - (Number(row[0]) * (Number(row[1]) / 100)) + 4.99;
            }
            return out;
          };

          runQuery = () =>
            db.from('items').select(['id', fn('calc_discount', col('amount'), col('discount')).as('final_price')]).toArray();

          // A. Measure Scalar
          db.registerFunction('calc_discount', {
            returnType: DataType.FLOAT64,
            call: scalarMath,
          });
          break;
        }

        case 'intl_date': {
          const scalarDate = (ts: any) => formatDate(ts, 'medium', 'en-US');
          const vectorDate = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = formatDate(batch[i][0], 'medium', 'en-US');
            }
            return out;
          };

          runQuery = () =>
            db.from('items').select(['id', fn('format_date_bench', col('created_at')).as('formatted_date')]).toArray();

          db.registerFunction('format_date_bench', {
            returnType: DataType.TEXT,
            call: scalarDate,
          });
          break;
        }

        case 'intl_currency': {
          const scalarCurrency = (a: any) => formatCurrency(a, 'USD', 'en-US');
          const vectorCurrency = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = formatCurrency(batch[i][0], 'USD', 'en-US');
            }
            return out;
          };

          runQuery = () =>
            db.from('items').select(['id', fn('format_currency_bench', col('amount')).as('formatted_price')]).toArray();

          db.registerFunction('format_currency_bench', {
            returnType: DataType.TEXT,
            call: scalarCurrency,
          });
          break;
        }

        case 'text_slugify': {
          const scalarSlug = (str: any) => slugify(str);
          const vectorSlug = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = slugify(batch[i][0]);
            }
            return out;
          };

          runQuery = () =>
            db.from('items').select(['id', fn('slugify_bench', col('name')).as('slug')]).toArray();

          db.registerFunction('slugify_bench', {
            returnType: DataType.TEXT,
            call: scalarSlug,
          });
          break;
        }

        case 'regex_match': {
          const scalarRegex = (val: any, pat: any) => regexpMatch(val, pat);
          const vectorRegex = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = regexpMatch(batch[i][0], batch[i][1]);
            }
            return out;
          };

          const pat = '^[A-Z]{3}-\\d{4}$';
          runQuery = () =>
            db.from('items').select(['id', fn('regex_bench', col('sku'), lit(pat)).as('is_valid')]).toArray();

          db.registerFunction('regex_bench', {
            returnType: DataType.INT32,
            call: scalarRegex,
          });
          break;
        }

        case 'where_filter': {
          const scalarFilter = (score: any, amount: any) =>
            Number(score) > 60 && Number(amount) > 150 ? 1 : 0;
          const vectorFilter = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = Number(batch[i][0]) > 60 && Number(batch[i][1]) > 150 ? 1 : 0;
            }
            return out;
          };

          runQuery = () =>
            db.from('items').where(fn('filter_bench', col('score'), col('amount')).eq(1)).toArray();

          db.registerFunction('filter_bench', {
            returnType: DataType.INT32,
            call: scalarFilter,
          });
          break;
        }
      }

      // --- PHASE 1: SCALAR MEASUREMENT ---
      if (onProgress) {
        onProgress({
          workloadId,
          workloadName: workloadInfo.name,
          workloadIndex: wIdx,
          totalWorkloads: config.workloads.length,
          phase: 'scalar',
        });
      }

      // Warmup scalar run
      await runQuery();

      const scalarSamples: number[] = [];
      for (let it = 0; it < config.iterations; it++) {
        if (shouldAbort && shouldAbort()) break;
        const t0 = performance.now();
        await runQuery();
        const duration = performance.now() - t0;
        scalarSamples.push(duration);
      }

      // --- PHASE 2: VECTOR MEASUREMENT ---
      if (onProgress) {
        onProgress({
          workloadId,
          workloadName: workloadInfo.name,
          workloadIndex: wIdx,
          totalWorkloads: config.workloads.length,
          phase: 'vector',
        });
      }

      // Register Vector implementation for the same function name
      switch (workloadId) {
        case 'math_calc': {
          const scalarMath = (a: any, d: any) =>
            (Number(a) * 1.0825) - (Number(a) * (Number(d) / 100)) + 4.99;
          const vectorMath = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              const row = batch[i];
              out[i] = (Number(row[0]) * 1.0825) - (Number(row[0]) * (Number(row[1]) / 100)) + 4.99;
            }
            return out;
          };
          db.registerFunction('calc_discount', {
            returnType: DataType.FLOAT64,
            call: scalarMath,
            batchCall: vectorMath,
          });
          break;
        }

        case 'intl_date': {
          const scalarDate = (ts: any) => formatDate(ts, 'medium', 'en-US');
          const vectorDate = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = formatDate(batch[i][0], 'medium', 'en-US');
            }
            return out;
          };
          db.registerFunction('format_date_bench', {
            returnType: DataType.TEXT,
            call: scalarDate,
            batchCall: vectorDate,
          });
          break;
        }

        case 'intl_currency': {
          const scalarCurrency = (a: any) => formatCurrency(a, 'USD', 'en-US');
          const vectorCurrency = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = formatCurrency(batch[i][0], 'USD', 'en-US');
            }
            return out;
          };
          db.registerFunction('format_currency_bench', {
            returnType: DataType.TEXT,
            call: scalarCurrency,
            batchCall: vectorCurrency,
          });
          break;
        }

        case 'text_slugify': {
          const scalarSlug = (str: any) => slugify(str);
          const vectorSlug = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = slugify(batch[i][0]);
            }
            return out;
          };
          db.registerFunction('slugify_bench', {
            returnType: DataType.TEXT,
            call: scalarSlug,
            batchCall: vectorSlug,
          });
          break;
        }

        case 'regex_match': {
          const scalarRegex = (val: any, pat: any) => regexpMatch(val, pat);
          const vectorRegex = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = regexpMatch(batch[i][0], batch[i][1]);
            }
            return out;
          };
          db.registerFunction('regex_bench', {
            returnType: DataType.INT32,
            call: scalarRegex,
            batchCall: vectorRegex,
          });
          break;
        }

        case 'where_filter': {
          const scalarFilter = (score: any, amount: any) =>
            Number(score) > 60 && Number(amount) > 150 ? 1 : 0;
          const vectorFilter = (batch: any[][]) => {
            const n = batch.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = Number(batch[i][0]) > 60 && Number(batch[i][1]) > 150 ? 1 : 0;
            }
            return out;
          };
          db.registerFunction('filter_bench', {
            returnType: DataType.INT32,
            call: scalarFilter,
            batchCall: vectorFilter,
          });
          break;
        }
      }

      // Warmup vector run
      await runQuery();

      const vectorSamples: number[] = [];
      for (let it = 0; it < config.iterations; it++) {
        if (shouldAbort && shouldAbort()) break;
        const t0 = performance.now();
        await runQuery();
        const duration = performance.now() - t0;
        vectorSamples.push(duration);
      }

      const scalarMetrics = computeMetrics(scalarSamples, config.datasetSize);
      const vectorMetrics = computeMetrics(vectorSamples, config.datasetSize);

      const speedup = vectorMetrics.meanMs > 0
        ? scalarMetrics.meanMs / vectorMetrics.meanMs
        : 1;

      const timeSavedPercent = scalarMetrics.meanMs > 0
        ? Math.max(0, ((scalarMetrics.meanMs - vectorMetrics.meanMs) / scalarMetrics.meanMs) * 100)
        : 0;

      const latencyDiffMs = scalarMetrics.meanMs - vectorMetrics.meanMs;

      const comparison: UdfComparisonResult = {
        workloadId,
        workloadName: workloadInfo.name,
        datasetSize: config.datasetSize,
        iterations: config.iterations,
        scalar: scalarMetrics,
        vector: vectorMetrics,
        speedup,
        timeSavedPercent,
        latencyDiffMs,
      };

      results.push(comparison);

      if (onProgress) {
        onProgress({
          workloadId,
          workloadName: workloadInfo.name,
          workloadIndex: wIdx + 1,
          totalWorkloads: config.workloads.length,
          phase: 'completed',
          latestResult: comparison,
        });
      }
    }
  } finally {
    try {
      await db.close();
    } catch {}
  }

  return results;
}

