import React, { useState, useRef } from 'react';
import {
  UdfWorkloadId,
  UdfWorkloadInfo,
  UdfComparisonResult,
  UdfProgressUpdate,
  UDF_WORKLOADS,
  runUdfBenchmarkSuite,
} from '../engine/udf_runner.js';
import {
  Zap,
  Clock,
  Play,
  Square,
  Sparkles,
  TrendingUp,
  Cpu,
  Layers,
  Info,
  X,
  Code2,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Flame,
  Gauge,
} from 'lucide-react';

const DATASET_SIZES = [1000, 5000, 10000, 25000, 50000];
const ITERATIONS_OPTIONS = [3, 5, 10];

export const WebdbUdfBenchmark: React.FC = () => {
  const [datasetSize, setDatasetSize] = useState<number>(10000);
  const [iterations, setIterations] = useState<number>(5);
  const [selectedWorkloads, setSelectedWorkloads] = useState<UdfWorkloadId[]>([
    'math_calc',
    'intl_date',
    'intl_currency',
    'text_slugify',
    'regex_match',
    'where_filter',
  ]);

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<UdfProgressUpdate | null>(null);
  const [results, setResults] = useState<UdfComparisonResult[]>([]);
  const [activeModal, setActiveModal] = useState<UdfWorkloadInfo | null>(null);
  const [copiedScalar, setCopiedScalar] = useState<boolean>(false);
  const [copiedVector, setCopiedVector] = useState<boolean>(false);

  const abortRequestedRef = useRef<boolean>(false);

  const toggleWorkload = (id: UdfWorkloadId) => {
    if (isRunning) return;
    setSelectedWorkloads((prev) =>
      prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]
    );
  };

  const selectAllWorkloads = () => {
    if (isRunning) return;
    setSelectedWorkloads(UDF_WORKLOADS.map((w) => w.id));
  };

  const deselectAllWorkloads = () => {
    if (isRunning) return;
    setSelectedWorkloads([]);
  };

  const handleRun = async () => {
    if (isRunning || selectedWorkloads.length === 0) return;
    setIsRunning(true);
    abortRequestedRef.current = false;
    setResults([]);
    setProgress(null);

    try {
      const res = await runUdfBenchmarkSuite(
        {
          datasetSize,
          iterations,
          workloads: selectedWorkloads,
        },
        (update) => {
          setProgress(update);
          if (update.latestResult) {
            setResults((prev) => {
              const filtered = prev.filter(
                (r) => r.workloadId !== update.latestResult!.workloadId
              );
              return [...filtered, update.latestResult!];
            });
          }
        },
        () => abortRequestedRef.current
      );
      setResults(res);
    } catch (err) {
      console.error('UDF Benchmark failed:', err);
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  };

  const handleStop = () => {
    abortRequestedRef.current = true;
  };

  // Aggregated metrics
  const avgSpeedup =
    results.length > 0
      ? results.reduce((acc, r) => acc + r.speedup, 0) / results.length
      : 0;

  const avgTimeSaved =
    results.length > 0
      ? results.reduce((acc, r) => acc + r.timeSavedPercent, 0) / results.length
      : 0;

  const totalScalarOps =
    results.length > 0
      ? Math.round(results.reduce((acc, r) => acc + r.scalar.opsPerSec, 0) / results.length)
      : 0;

  const totalVectorOps =
    results.length > 0
      ? Math.round(results.reduce((acc, r) => acc + r.vector.opsPerSec, 0) / results.length)
      : 0;

  const copyToClipboard = (text: string, isVector: boolean) => {
    navigator.clipboard.writeText(text);
    if (isVector) {
      setCopiedVector(true);
      setTimeout(() => setCopiedVector(false), 1800);
    } else {
      setCopiedScalar(true);
      setTimeout(() => setCopiedScalar(false), 1800);
    }
  };

  return (
    <div className="udf-benchmark-page">
      {/* 1. Header Banner */}
      <section className="udf-hero">
        <div className="udf-hero-content">
          <div className="udf-hero-tag">
            <Zap size={14} className="text-amber" />
            <span>WebDB Vector Execution Engine</span>
          </div>
          <h1 className="udf-hero-title">
            UDF Batching & Vectorized Execution Benchmark
          </h1>
          <p className="udf-hero-subtitle">
            Measure the exact throughput, latency, and CPU efficiency gains when switching from row-by-row scalar UDF calls to 128-row vectorized batch execution.
          </p>

          <div className="udf-hero-pills">
            <div className="hero-pill">
              <Cpu size={14} />
              <span>128-Row Vector Chunks</span>
            </div>
            <div className="hero-pill">
              <Layers size={14} />
              <span>Amortized JS Dispatch</span>
            </div>
            <div className="hero-pill">
              <TrendingUp size={14} />
              <span>V8 Turbofan JIT Loops</span>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Controls & Configuration */}
      <section className="udf-controls-card">
        <div className="udf-controls-row">
          {/* Dataset Size */}
          <div className="udf-control-group">
            <label className="udf-control-label">Dataset Size (Rows):</label>
            <div className="btn-toggle-group">
              {DATASET_SIZES.map((size) => (
                <button
                  key={size}
                  disabled={isRunning}
                  className={`btn-toggle-item ${datasetSize === size ? 'active' : ''}`}
                  onClick={() => setDatasetSize(size)}
                >
                  {size.toLocaleString()}
                </button>
              ))}
            </div>
          </div>

          {/* Iterations */}
          <div className="udf-control-group">
            <label className="udf-control-label">Iterations (Warmup + Median):</label>
            <div className="btn-toggle-group">
              {ITERATIONS_OPTIONS.map((it) => (
                <button
                  key={it}
                  disabled={isRunning}
                  className={`btn-toggle-item ${iterations === it ? 'active' : ''}`}
                  onClick={() => setIterations(it)}
                >
                  {it} runs
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="udf-control-actions">
            {!isRunning ? (
              <button
                className="btn-primary-run"
                disabled={selectedWorkloads.length === 0}
                onClick={handleRun}
              >
                <Play size={15} />
                <span>Run Vector Benchmark</span>
              </button>
            ) : (
              <button className="btn-danger-stop" onClick={handleStop}>
                <Square size={15} />
                <span>Stop Benchmark</span>
              </button>
            )}
          </div>
        </div>

        {/* Workloads Selection Bar */}
        <div className="udf-workloads-bar">
          <div className="workloads-bar-header">
            <span className="workloads-bar-title">Select Workloads to Test:</span>
            <div className="workloads-bar-actions">
              <button
                disabled={isRunning}
                className="btn-text-link"
                onClick={selectAllWorkloads}
              >
                Select All
              </button>
              <span className="dot-divider">•</span>
              <button
                disabled={isRunning}
                className="btn-text-link"
                onClick={deselectAllWorkloads}
              >
                Deselect All
              </button>
            </div>
          </div>

          <div className="workloads-chips-grid">
            {UDF_WORKLOADS.map((w) => {
              const isSelected = selectedWorkloads.includes(w.id);
              return (
                <button
                  key={w.id}
                  disabled={isRunning}
                  className={`workload-chip ${isSelected ? 'active' : ''}`}
                  onClick={() => toggleWorkload(w.id)}
                >
                  <span className={`chip-check ${isSelected ? 'checked' : ''}`}>
                    {isSelected ? '✓' : ''}
                  </span>
                  <span className="chip-name">{w.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Live Running Progress */}
        {isRunning && progress && (
          <div className="udf-progress-box">
            <div className="progress-info-row">
              <div className="progress-status">
                <span className="spinner-dot" />
                <span>
                  Testing {progress.workloadName} (
                  {progress.phase === 'seeding'
                    ? 'Populating dataset'
                    : progress.phase === 'scalar'
                      ? 'Running Scalar row-by-row dispatch'
                      : progress.phase === 'vector'
                        ? 'Running Vectorized 128-row batch execution'
                        : 'Done'}
                  )...
                </span>
              </div>
              <span className="progress-count">
                {progress.workloadIndex} / {progress.totalWorkloads} workloads
              </span>
            </div>
            <div className="progress-bar-track">
              <div
                className="progress-bar-fill"
                style={{
                  width: `${(progress.workloadIndex / progress.totalWorkloads) * 100}%`,
                }}
              />
            </div>
          </div>
        )}
      </section>

      {/* 3. Hero Metric Cards (When results exist) */}
      {results.length > 0 && (
        <section className="udf-metrics-summary">
          <div className="metric-card metric-card-speedup">
            <div className="metric-card-icon">
              <Flame size={24} className="text-amber" />
            </div>
            <div className="metric-card-data">
              <div className="metric-card-label">Average Speedup Factor</div>
              <div className="metric-card-value">{avgSpeedup.toFixed(2)}x</div>
              <div className="metric-card-hint">
                Vector execution vs Scalar row-by-row
              </div>
            </div>
          </div>

          <div className="metric-card metric-card-saved">
            <div className="metric-card-icon">
              <Clock size={24} className="text-emerald" />
            </div>
            <div className="metric-card-data">
              <div className="metric-card-label">Latency Reduction</div>
              <div className="metric-card-value">
                -{avgTimeSaved.toFixed(1)}%
              </div>
              <div className="metric-card-hint">
                Average execution time reduction
              </div>
            </div>
          </div>

          <div className="metric-card metric-card-vector-ops">
            <div className="metric-card-icon">
              <Gauge size={24} className="text-indigo" />
            </div>
            <div className="metric-card-data">
              <div className="metric-card-label">Vector Throughput</div>
              <div className="metric-card-value">
                {totalVectorOps.toLocaleString()}
                <span className="metric-unit"> rows/s</span>
              </div>
              <div className="metric-card-hint">
                With 128-row chunk dispatch
              </div>
            </div>
          </div>

          <div className="metric-card metric-card-scalar-ops">
            <div className="metric-card-icon">
              <Gauge size={24} className="text-muted" />
            </div>
            <div className="metric-card-data">
              <div className="metric-card-label">Scalar Throughput</div>
              <div className="metric-card-value">
                {totalScalarOps.toLocaleString()}
                <span className="metric-unit"> rows/s</span>
              </div>
              <div className="metric-card-hint">
                Row-by-row scalar function dispatch
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 4. Results List / Cards */}
      {results.length === 0 && !isRunning && (
        <div className="empty-results-box">
          <div className="empty-icon-wrap">
            <Zap size={32} className="text-muted" />
          </div>
          <h3 className="empty-title">Ready to Benchmark WebDB Vector Execution</h3>
          <p className="empty-desc">
            Select your dataset size and target workloads above, then click{' '}
            <strong>Run Vector Benchmark</strong> to observe real-time latency and throughput comparisons.
          </p>
        </div>
      )}

      {results.length > 0 && (
        <section className="udf-results-section">
          <div className="results-section-header">
            <h2 className="results-section-title">
              Workload Performance Breakdown
            </h2>
            <span className="results-section-count">
              {results.length} workloads measured ({datasetSize.toLocaleString()} rows each)
            </span>
          </div>

          <div className="udf-cards-grid">
            {results.map((res) => {
              const info = UDF_WORKLOADS.find((w) => w.id === res.workloadId)!;
              const maxOps = Math.max(res.scalar.opsPerSec, res.vector.opsPerSec);
              const scalarWidth = Math.max(8, (res.scalar.opsPerSec / maxOps) * 100);
              const vectorWidth = Math.max(8, (res.vector.opsPerSec / maxOps) * 100);

              const isVectorWinner = res.vector.meanMs <= res.scalar.meanMs;

              return (
                <div key={res.workloadId} className="udf-card">
                  <div className="udf-card-header">
                    <div>
                      <div className="udf-card-badge-row">
                        <span className={`udf-category-pill cat-${info.category}`}>
                          {info.category.toUpperCase()}
                        </span>
                        {res.speedup >= 1.05 && (
                          <span className="speedup-pill">
                            <Sparkles size={12} />
                            <span>{res.speedup.toFixed(2)}x FASTER</span>
                          </span>
                        )}
                      </div>
                      <h3 className="udf-card-title">{res.workloadName}</h3>
                      <p className="udf-card-desc">{info.description}</p>
                    </div>

                    <button
                      className="btn-view-code"
                      title="View Scalar vs Vector Code Comparison"
                      onClick={() => setActiveModal(info)}
                    >
                      <Code2 size={14} />
                      <span>Code</span>
                    </button>
                  </div>

                  {/* Visual Bar Comparison */}
                  <div className="udf-bars-container">
                    {/* Vector Bar */}
                    <div className="bar-row">
                      <div className="bar-label">
                        <span className="mode-tag tag-vector">
                          Vector (batchCall)
                        </span>
                        <span className="bar-latency-val">
                          {res.vector.meanMs.toFixed(2)} ms
                        </span>
                      </div>
                      <div className="bar-track">
                        <div
                          className="bar-fill fill-vector"
                          style={{ width: `${vectorWidth}%` }}
                        >
                          <span className="bar-fill-text">
                            {Math.round(res.vector.opsPerSec).toLocaleString()} rows/s
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Scalar Bar */}
                    <div className="bar-row">
                      <div className="bar-label">
                        <span className="mode-tag tag-scalar">
                          Scalar (call)
                        </span>
                        <span className="bar-latency-val">
                          {res.scalar.meanMs.toFixed(2)} ms
                        </span>
                      </div>
                      <div className="bar-track">
                        <div
                          className="bar-fill fill-scalar"
                          style={{ width: `${scalarWidth}%` }}
                        >
                          <span className="bar-fill-text">
                            {Math.round(res.scalar.opsPerSec).toLocaleString()} rows/s
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Details stats footer */}
                  <div className="udf-card-footer">
                    <div className="footer-stat">
                      <span className="stat-label">Latency Saved:</span>
                      <span className="stat-val text-emerald">
                        {res.timeSavedPercent.toFixed(1)}% (
                        {Math.abs(res.latencyDiffMs).toFixed(1)}ms)
                      </span>
                    </div>
                    <div className="footer-stat">
                      <span className="stat-label">p95 Latency:</span>
                      <span className="stat-val">
                        Vector: {res.vector.p95Ms.toFixed(1)}ms | Scalar:{' '}
                        {res.scalar.p95Ms.toFixed(1)}ms
                      </span>
                    </div>
                    <div className="footer-query-hint" title={info.queryHint}>
                      <code>{info.queryHint}</code>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 5. Deep-Dive Explainer Card */}
      <section className="udf-explainer-card">
        <div className="explainer-header">
          <Info size={18} className="text-primary" />
          <h3 className="explainer-title">
            How Vectorized Execution Works in WebDB
          </h3>
        </div>

        <div className="explainer-grid">
          <div className="explainer-col">
            <h4 className="col-title text-danger">🔴 Row-by-Row Scalar Dispatch</h4>
            <p className="col-desc">
              When a function only implements <code>call(...)</code>, the query VM must evaluate it individually for every single row. For a 50,000-row table scan, this requires <strong>50,000 separate function invocations</strong>, continuous argument unpacking, and frequent context switches between the VM instruction loop and the host JavaScript runtime.
            </p>
            <div className="code-snippet-box">
              <pre>{`// Dispatched 50,000 times:
db.registerFunction('calc', {
  call: (val) => val * 1.0825
});`}</pre>
            </div>
          </div>

          <div className="explainer-col">
            <h4 className="col-title text-success">🟢 128-Row Vectorized Batching</h4>
            <p className="col-desc">
              When a function provides <code>batchCall(batch)</code>, WebDB partitions row streams into power-of-two chunks (128 rows per vector). The function is called once per chunk (reducing 50,000 calls to <strong>391 calls</strong>). Inside the chunk, V8 Turbofan executes tight, inline, monomorphic loops with optimal CPU L1 cache locality and pre-allocated result arrays.
            </p>
            <div className="code-snippet-box">
              <pre>{`// Dispatched once per 128 rows (391 times):
db.registerFunction('calc', {
  batchCall: (batch) => batch.map(([val]) => val * 1.0825)
});`}</pre>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Code Comparison Modal */}
      {activeModal && (
        <div className="modal-backdrop" onClick={() => setActiveModal(null)}>
          <div
            className="udf-modal-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div className="modal-title-wrap">
                <Code2 size={18} className="text-primary" />
                <h3 className="modal-title">{activeModal.name}</h3>
              </div>
              <button
                className="btn-modal-close"
                onClick={() => setActiveModal(null)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="modal-desc-box">
                <p>{activeModal.description}</p>
                <div className="modal-query-box">
                  <strong>Query: </strong>
                  <code>{activeModal.queryHint}</code>
                </div>
              </div>

              <div className="modal-code-comparison">
                {/* Scalar Column */}
                <div className="modal-code-col">
                  <div className="code-col-header">
                    <span className="code-col-title text-danger">
                      Scalar Implementation (call)
                    </span>
                    <button
                      className="btn-copy-code"
                      onClick={() =>
                        copyToClipboard(activeModal.scalarSnippet, false)
                      }
                    >
                      {copiedScalar ? <Check size={12} /> : <Copy size={12} />}
                      <span>{copiedScalar ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="code-view">
                    <code>{activeModal.scalarSnippet}</code>
                  </pre>
                  <div className="code-col-footer">
                    <span>Dispatched once per individual row.</span>
                  </div>
                </div>

                {/* Vector Column */}
                <div className="modal-code-col">
                  <div className="code-col-header">
                    <span className="code-col-title text-success">
                      Vectorized Implementation (batchCall)
                    </span>
                    <button
                      className="btn-copy-code"
                      onClick={() =>
                        copyToClipboard(activeModal.vectorSnippet, true)
                      }
                    >
                      {copiedVector ? <Check size={12} /> : <Copy size={12} />}
                      <span>{copiedVector ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="code-view">
                    <code>{activeModal.vectorSnippet}</code>
                  </pre>
                  <div className="code-col-footer">
                    <span>Dispatched in 128-row vector chunks.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

