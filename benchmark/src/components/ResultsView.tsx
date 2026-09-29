import React, { useState, useEffect } from 'react';
import { AVAILABLE_ENGINES, AVAILABLE_SCENARIOS, EngineId, ScenarioId, ScenarioInfo, ScenarioResult } from '../adapters/index.js';
import { Download, LayoutGrid, BarChart2, Table as TableIcon, Zap, Clock, Medal, AlertCircle, BookOpen, Cpu, Binary, Layers, Database, Info, X, Copy, Check } from 'lucide-react';

interface Props {
  results: ScenarioResult[];
  datasetSize: number;
}

export const ResultsView: React.FC<Props> = ({ results, datasetSize }) => {
  const [activeTab, setActiveTab] = useState<'matrix' | 'charts' | 'table' | 'notes'>('matrix');
  const [chartMetric, setChartMetric] = useState<'ops' | 'latency'>('ops');
  const [modalScenario, setModalScenario] = useState<ScenarioInfo | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [selectedBaseline, setSelectedBaseline] = useState<EngineId | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModalScenario(null);
    };
    if (modalScenario) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [modalScenario]);

  if (results.length === 0) {
    return (
      <div className="empty-results-box">
        <div className="empty-icon-wrap">
          <LayoutGrid size={32} className="text-muted" />
        </div>
        <h3 className="empty-title">Ready to Benchmark</h3>
        <p className="empty-desc">
          Select your target database engines and test scenarios in the left panel, then click <strong>Run Benchmark</strong> to see real-time latency and throughput comparisons.
        </p>
      </div>
    );
  }

  const engineMap = new Map(AVAILABLE_ENGINES.map((e) => [e.id, e]));
  const scenarioMap = new Map(AVAILABLE_SCENARIOS.map((s) => [s.id, s]));

  // Active engines and scenarios present in results
  const presentEngineIds = Array.from(new Set(results.map((r) => r.engineId)));
  const presentScenarioIds = Array.from(new Set(results.map((r) => r.scenarioId)));

  const defaultBaseline: EngineId = presentEngineIds.includes('indexeddb')
    ? 'indexeddb'
    : presentEngineIds.includes('raw_array')
      ? 'raw_array'
      : (presentEngineIds[0] ?? 'webdb_idb');

  const baselineEngineId: EngineId =
    selectedBaseline && presentEngineIds.includes(selectedBaseline)
      ? selectedBaseline
      : defaultBaseline;

  // Lookup map: `${engineId}:${scenarioId}` -> ScenarioResult
  const resultMap = new Map<string, ScenarioResult>();
  for (const r of results) {
    resultMap.set(`${r.engineId}:${r.scenarioId}`, r);
  }

  // Calculate speedup relative to active baseline
  const getSpeedupInfo = (res: ScenarioResult, scenId: ScenarioId) => {
    if (res.engineId === baselineEngineId) {
      return { isBaseline: true, text: 'Baseline', shortText: 'Baseline', factor: 1 };
    }
    const baseRes = resultMap.get(`${baselineEngineId}:${scenId}`);
    if (!baseRes || baseRes.error || res.error || baseRes.opsPerSec <= 0 || res.opsPerSec <= 0) {
      return null;
    }
    const ratio = res.opsPerSec / baseRes.opsPerSec;
    if (ratio >= 1.05) {
      const text = `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}x faster`;
      return { isFaster: true, text, shortText: text, factor: ratio };
    } else if (ratio <= 0.95) {
      const slowerRatio = 1 / ratio;
      const text = `${slowerRatio >= 10 ? Math.round(slowerRatio) : slowerRatio.toFixed(1)}x slower`;
      return { isSlower: true, text, shortText: text, factor: ratio };
    } else {
      return { isParity: true, text: '~1.0x', shortText: '~1.0x', factor: 1 };
    }
  };

  // Find winner per scenario (highest ops/sec)
  const winners = new Map<ScenarioId, EngineId>();
  for (const scenId of presentScenarioIds) {
    let maxOps = -1;
    let winnerId: EngineId | null = null;
    for (const engId of presentEngineIds) {
      const res = resultMap.get(`${engId}:${scenId}`);
      if (res && !res.error && res.opsPerSec > maxOps) {
        maxOps = res.opsPerSec;
        winnerId = engId;
      }
    }
    if (winnerId) winners.set(scenId, winnerId);
  }

  const exportJson = () => {
    const payload = {
      timestamp: new Date().toISOString(),
      datasetSize,
      baseline: baselineEngineId,
      results,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `benchmark-${datasetSize}-rows.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const headers = [
      'Engine',
      'Storage',
      'Scenario',
      'OpsPerSec',
      'MeanMs',
      'MinMs',
      'MaxMs',
      'P95Ms',
      'VsBaseline',
      'Samples',
      'MemoryDeltaMB',
      'Error',
    ];
    const rows = results.map((r) => {
      const eng = engineMap.get(r.engineId);
      const scen = scenarioMap.get(r.scenarioId);
      const memMb = r.memoryDeltaBytes ? (r.memoryDeltaBytes / (1024 * 1024)).toFixed(2) : '';
      const speedup = getSpeedupInfo(r, r.scenarioId);
      return [
        eng?.name ?? r.engineId,
        eng?.storage ?? 'unknown',
        scen?.name ?? r.scenarioId,
        r.opsPerSec,
        r.meanMs,
        r.minMs,
        r.maxMs,
        r.p95Ms,
        speedup?.text ?? '',
        r.samples,
        memMb,
        r.error ? `"${r.error.replace(/"/g, '""')}"` : '',
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `benchmark-${datasetSize}-rows.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="results-wrapper">
      {/* View Toolbar */}
      <div className="results-toolbar">
        <div className="toolbar-tabs">
          <button
            onClick={() => setActiveTab('matrix')}
            className={`tab-btn ${activeTab === 'matrix' ? 'active' : ''}`}
          >
            <LayoutGrid size={14} />
            <span>Comparison Matrix</span>
          </button>
          <button
            onClick={() => setActiveTab('charts')}
            className={`tab-btn ${activeTab === 'charts' ? 'active' : ''}`}
          >
            <BarChart2 size={14} />
            <span>Bar Charts</span>
          </button>
          <button
            onClick={() => setActiveTab('table')}
            className={`tab-btn ${activeTab === 'table' ? 'active' : ''}`}
          >
            <TableIcon size={14} />
            <span>Full Data Table</span>
          </button>
          <button
            onClick={() => setActiveTab('notes')}
            className={`tab-btn ${activeTab === 'notes' ? 'active' : ''}`}
          >
            <BookOpen size={14} />
            <span>Architecture</span>
          </button>
        </div>

        <div className="toolbar-actions">
          <div className="baseline-selector-box">
            <span className="baseline-label">Baseline:</span>
            <select
              className="baseline-select"
              value={baselineEngineId}
              onChange={(e) => setSelectedBaseline(e.target.value as EngineId)}
              title="Reference baseline engine for speedup comparison"
            >
              {presentEngineIds.map((id) => (
                <option key={id} value={id}>
                  {engineMap.get(id)?.name ?? id}
                </option>
              ))}
            </select>
          </div>
          <span className="scale-indicator">Dataset: {datasetSize.toLocaleString()} rows</span>
          <button onClick={exportCsv} className="action-pill-btn" title="Export CSV">
            <Download size={13} />
            <span>CSV</span>
          </button>
          <button onClick={exportJson} className="action-pill-btn" title="Export JSON">
            <Download size={13} />
            <span>JSON</span>
          </button>
        </div>
      </div>

      {/* 1. Comparison Matrix (Compact, Zero-Scroll View) */}
      {activeTab === 'matrix' && (
        <div className="matrix-container">
          <table className="matrix-table">
            <thead>
              <tr>
                <th className="th-scenario">Scenario</th>
                {presentEngineIds.map((engId) => {
                  const eng = engineMap.get(engId);
                  return (
                    <th key={engId} className="th-engine">
                      <div className="th-engine-wrap">
                        <span className="th-name">{eng?.name ?? engId}</span>
                        <span className={`th-tag ${eng?.storage === 'memory' ? 'tag-ram' : 'tag-disk'}`}>
                          {eng?.storage === 'memory' ? 'RAM' : 'Disk'}
                        </span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {presentScenarioIds.map((scenId) => {
                const scen = scenarioMap.get(scenId);
                const winnerEngId = winners.get(scenId);

                return (
                  <tr key={scenId}>
                    <td className="td-scenario-info">
                      <div className="matrix-scen-header">
                        <span className="matrix-scen-title">{scen?.name ?? scenId}</span>
                        {scen && (
                          <button
                            className="btn-info-icon"
                            onClick={() => setModalScenario(scen)}
                            title="View full query & scenario details"
                          >
                            <Info size={12} />
                          </button>
                        )}
                      </div>
                      <div className="matrix-scen-hint" title={scen?.queryHint}>
                        {scen?.queryHint}
                      </div>
                    </td>

                    {presentEngineIds.map((engId) => {
                      const res = resultMap.get(`${engId}:${scenId}`);
                      const isWinner = winnerEngId === engId;

                      if (!res) {
                        return (
                          <td key={engId} className="td-matrix-cell cell-empty">
                            <span>—</span>
                          </td>
                        );
                      }

                      if (res.error) {
                        return (
                          <td key={engId} className="td-matrix-cell cell-error" title={res.error}>
                            <AlertCircle size={14} className="text-danger" />
                            <span className="error-text">Failed</span>
                          </td>
                        );
                      }

                      const speedup = getSpeedupInfo(res, scenId);

                      return (
                        <td
                          key={engId}
                          className={`td-matrix-cell ${isWinner ? 'cell-winner' : ''}`}
                        >
                          <div className="cell-content">
                            <div className="cell-primary">
                              <span className="cell-ops">
                                {res.opsPerSec >= 1000
                                  ? `${(res.opsPerSec / 1000).toFixed(1)}k`
                                  : res.opsPerSec.toFixed(0)}{' '}
                                <small>ops/s</small>
                              </span>
                              <div className="cell-badges">
                                {isWinner && (
                                  <span className="winner-medal-wrap" title="Fastest implementation">
                                    <Medal size={15} className="winner-medal" />
                                  </span>
                                )}
                                {speedup && (
                                  <span
                                    className={`speedup-badge ${
                                      isWinner
                                        ? 'badge-winner'
                                        : speedup.isFaster
                                        ? 'badge-faster'
                                        : speedup.isBaseline
                                        ? 'badge-baseline'
                                        : speedup.isSlower
                                        ? 'badge-slower'
                                        : 'badge-parity'
                                    }`}
                                    title={
                                      isWinner
                                        ? `Fastest implementation — ${speedup.isBaseline ? '1.0x baseline' : speedup.text} vs ${engineMap.get(baselineEngineId)?.name ?? baselineEngineId}`
                                        : `Speed relative to ${engineMap.get(baselineEngineId)?.name ?? baselineEngineId}`
                                    }
                                  >
                                    {speedup.text}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="cell-secondary">
                              <span className="cell-latency">{res.meanMs.toFixed(2)} ms</span>
                              <span className="cell-p95">p95: {res.p95Ms.toFixed(2)}ms</span>
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 2. Visual Bar Charts View */}
      {activeTab === 'charts' && (
        <div className="charts-view-container">
          <div className="metric-toggle-bar">
            <button
              onClick={() => setChartMetric('ops')}
              className={`metric-choice ${chartMetric === 'ops' ? 'active' : ''}`}
            >
              <Zap size={13} />
              <span>Throughput (Higher is better)</span>
            </button>
            <button
              onClick={() => setChartMetric('latency')}
              className={`metric-choice ${chartMetric === 'latency' ? 'active' : ''}`}
            >
              <Clock size={13} />
              <span>Latency (Lower is better)</span>
            </button>
          </div>

          <div className="charts-grid">
            {presentScenarioIds.map((scenId) => {
              const scen = scenarioMap.get(scenId);
              const scenarioResults = presentEngineIds
                .map((engId) => resultMap.get(`${engId}:${scenId}`))
                .filter((r): r is ScenarioResult => !!r);

              const maxOps = Math.max(...scenarioResults.map((r) => r.opsPerSec || 0), 1);
              const maxLat = Math.max(...scenarioResults.map((r) => r.meanMs || 0), 0.1);
              const winnerEngId = winners.get(scenId);

              return (
                <div key={scenId} className="chart-card">
                  <div className="chart-card-header">
                    <span className="chart-scen-name">{scen?.name ?? scenId}</span>
                    {winnerEngId && (
                      <span className="chart-winner-pill">
                        Fastest: {engineMap.get(winnerEngId)?.name}
                      </span>
                    )}
                  </div>

                  <div className="bars-stack">
                    {scenarioResults.map((res) => {
                      const eng = engineMap.get(res.engineId);
                      const isWinner = winnerEngId === res.engineId;
                      const hasError = !!res.error;
                      const speedup = getSpeedupInfo(res, scenId);
                      const speedupText = speedup ? (speedup.isBaseline ? ' (Baseline)' : ` (${speedup.text})`) : '';

                      let pct = 0;
                      let label = '';

                      if (hasError) {
                        pct = 0;
                        label = 'Error';
                      } else if (chartMetric === 'ops') {
                        pct = Math.max((res.opsPerSec / maxOps) * 100, 3);
                        label = `${res.opsPerSec.toLocaleString()} ops/s`;
                      } else {
                        pct = Math.max((res.meanMs / maxLat) * 100, 3);
                        label = `${res.meanMs.toFixed(2)} ms`;
                      }

                      return (
                        <div key={res.engineId} className="chart-bar-row">
                          <span className="bar-eng-label" title={eng?.name}>
                            {eng?.name}
                          </span>
                          <div className="bar-trough">
                            <div
                              className={`bar-fill-light ${isWinner ? 'winner' : ''} ${hasError ? 'error' : ''}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className={`bar-val-text ${isWinner ? 'winner' : ''}`}>
                            {isWinner && <Medal size={13} className="winner-medal-inline" />}
                            {label}
                            {speedupText && <small className="bar-speedup-hint">{speedupText}</small>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Detailed Data Table View */}
      {activeTab === 'table' && (
        <div className="table-view-container">
          <table className="detailed-table">
            <thead>
              <tr>
                <th>Engine</th>
                <th>Storage</th>
                <th>Scenario</th>
                <th className="num">Throughput</th>
                <th className="num">vs Baseline</th>
                <th className="num">Mean</th>
                <th className="num">Min</th>
                <th className="num">p95</th>
                <th className="num">Max</th>
                <th className="num">Heap Delta</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const eng = engineMap.get(r.engineId);
                const scen = scenarioMap.get(r.scenarioId);
                const memMb = r.memoryDeltaBytes
                  ? `${(r.memoryDeltaBytes / (1024 * 1024)).toFixed(1)} MB`
                  : '—';
                const speedup = getSpeedupInfo(r, r.scenarioId);
                const isWinner = winners.get(r.scenarioId) === r.engineId;

                if (r.error) {
                  return (
                    <tr key={`${r.engineId}-${r.scenarioId}-${i}`} className="row-fail">
                      <td className="bold">{eng?.name ?? r.engineId}</td>
                      <td>{eng?.storage}</td>
                      <td>{scen?.name ?? r.scenarioId}</td>
                      <td colSpan={7} className="text-danger">{r.error}</td>
                    </tr>
                  );
                }

                return (
                  <tr key={`${r.engineId}-${r.scenarioId}-${i}`}>
                    <td className="bold">{eng?.name ?? r.engineId}</td>
                    <td>
                      <span className={`th-tag ${eng?.storage === 'memory' ? 'tag-ram' : 'tag-disk'}`}>
                        {eng?.storage}
                      </span>
                    </td>
                    <td>{scen?.name ?? r.scenarioId}</td>
                    <td className="num bold font-mono">{r.opsPerSec.toLocaleString()} ops/s</td>
                    <td className="num font-mono">
                      <div className="table-speedup-cell">
                        {isWinner && <Medal size={13} className="winner-medal" title="Fastest implementation" />}
                        {speedup ? (
                          <span
                            className={`speedup-badge ${
                              isWinner
                                ? 'badge-winner'
                                : speedup.isFaster
                                ? 'badge-faster'
                                : speedup.isBaseline
                                ? 'badge-baseline'
                                : speedup.isSlower
                                ? 'badge-slower'
                                : 'badge-parity'
                            }`}
                          >
                            {speedup.text}
                          </span>
                        ) : (
                          '—'
                        )}
                      </div>
                    </td>
                    <td className="num font-mono">{r.meanMs.toFixed(2)} ms</td>
                    <td className="num font-mono text-muted">{r.minMs.toFixed(2)} ms</td>
                    <td className="num font-mono">{r.p95Ms.toFixed(2)} ms</td>
                    <td className="num font-mono text-muted">{r.maxMs.toFixed(2)} ms</td>
                    <td className="num font-mono text-muted">{memMb}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 4. Architecture Notes View */}
      {activeTab === 'notes' && (
        <div className="notes-view-container">
          <div className="notes-classic-grid">
            <div className="note-card">
              <div className="note-card-header">
                <Cpu size={16} className="text-muted" />
                <h4 className="note-title">Raw JS Array</h4>
              </div>
              <p className="note-body">
                Stores native V8 Heap objects with JIT-optimized hidden classes (Shapes).
                Zero serialization, zero page-boundary tracking, and zero transaction log. Represents the theoretical memory-speed ceiling in the browser.
              </p>
            </div>

            <div className="note-card">
              <div className="note-card-header">
                <Binary size={16} className="text-muted" />
                <h4 className="note-title">WebDB (Slotted Pages & Bytecode VM)</h4>
              </div>
              <p className="note-body">
                Packs records into 4KB slotted binary pages within WebAssembly linear memory managed by an LRU buffer pool. Queries compile into compact VDBE bytecode executed by an in-engine virtual machine.
              </p>
            </div>

            <div className="note-card">
              <div className="note-card-header">
                <Layers size={16} className="text-muted" />
                <h4 className="note-title">Native IndexedDB</h4>
              </div>
              <p className="note-body">
                Marshals JavaScript objects through the browser’s structured clone algorithm across IPC boundaries to disk-backed storage. B-tree indexes enable fast range scans, but individual object deserialization adds CPU overhead.
              </p>
            </div>

            <div className="note-card">
              <div className="note-card-header">
                <Database size={16} className="text-muted" />
                <h4 className="note-title">SQLite WASM (C Engine & OPFS)</h4>
              </div>
              <p className="note-body">
                The full SQLite3 C codebase compiled to WebAssembly. Features mature B-Tree paging and query planning. With OPFS, achieves near-native I/O throughput via synchronous file handles, with slight JS-to-WASM bridge translation cost on point operations.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Full Query Details Modal */}
      {modalScenario && (
        <div className="modal-backdrop" onClick={() => setModalScenario(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-wrap">
                <Info size={15} className="text-primary" />
                <h3 className="modal-title">{modalScenario.name}</h3>
              </div>
              <button
                className="btn-close-modal"
                onClick={() => setModalScenario(null)}
                title="Close"
              >
                <X size={15} />
              </button>
            </div>

            <div className="modal-body">
              <div className="modal-section">
                <label className="modal-label">Description</label>
                <p className="modal-desc">{modalScenario.description}</p>
              </div>

              <div className="modal-section">
                <div className="modal-label-row">
                  <label className="modal-label">Full Query / Target Operation</label>
                  <button
                    className="btn-copy-code"
                    onClick={() => {
                      navigator.clipboard.writeText(modalScenario.queryHint);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1800);
                    }}
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="modal-code-block">
                  <code>{modalScenario.queryHint}</code>
                </pre>
              </div>

              <div className="modal-section">
                <label className="modal-label">Category</label>
                <span className="modal-category-badge">{modalScenario.category.toUpperCase()}</span>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn-modal-close" onClick={() => setModalScenario(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
