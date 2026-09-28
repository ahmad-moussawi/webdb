import React from 'react';
import { AVAILABLE_ENGINES, AVAILABLE_SCENARIOS, ScenarioResult } from '../adapters/index.js';
import { Download, Table as TableIcon, AlertCircle } from 'lucide-react';

interface Props {
  results: ScenarioResult[];
  datasetSize: number;
}

export const ResultsTable: React.FC<Props> = ({ results, datasetSize }) => {
  if (results.length === 0) return null;

  const engineMap = new Map(AVAILABLE_ENGINES.map((e) => [e.id, e]));
  const scenarioMap = new Map(AVAILABLE_SCENARIOS.map((s) => [s.id, s]));

  const exportJson = () => {
    const payload = {
      timestamp: new Date().toISOString(),
      datasetSize,
      results,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `benchmark-results-${datasetSize}-rows.json`;
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
      'Samples',
      'MemoryDeltaMB',
      'Error',
    ];
    const rows = results.map((r) => {
      const eng = engineMap.get(r.engineId);
      const scen = scenarioMap.get(r.scenarioId);
      const memMb = r.memoryDeltaBytes ? (r.memoryDeltaBytes / (1024 * 1024)).toFixed(2) : '';
      return [
        eng?.name ?? r.engineId,
        eng?.storage ?? 'unknown',
        scen?.name ?? r.scenarioId,
        r.opsPerSec,
        r.meanMs,
        r.minMs,
        r.maxMs,
        r.p95Ms,
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
    a.download = `benchmark-results-${datasetSize}-rows.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="table-card">
      <div className="table-card-header">
        <div className="table-title-group">
          <TableIcon className="text-brand" size={20} />
          <h2 className="table-title">Benchmark Metrics Table</h2>
          <span className="dataset-tag">({datasetSize.toLocaleString()} rows)</span>
        </div>

        <div className="export-actions">
          <button onClick={exportCsv} className="export-btn">
            <Download size={14} />
            <span>Export CSV</span>
          </button>
          <button onClick={exportJson} className="export-btn">
            <Download size={14} />
            <span>Export JSON</span>
          </button>
        </div>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Engine</th>
              <th>Type</th>
              <th>Scenario</th>
              <th className="th-num">Throughput</th>
              <th className="th-num">Mean (ms)</th>
              <th className="th-num">Min (ms)</th>
              <th className="th-num">p95 (ms)</th>
              <th className="th-num">Max (ms)</th>
              <th className="th-num">Heap Delta</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, idx) => {
              const eng = engineMap.get(r.engineId);
              const scen = scenarioMap.get(r.scenarioId);
              const memMb = r.memoryDeltaBytes
                ? `${(r.memoryDeltaBytes / (1024 * 1024)).toFixed(1)} MB`
                : '—';

              if (r.error) {
                return (
                  <tr key={`${r.engineId}-${r.scenarioId}-${idx}`} className="row-error">
                    <td className="td-engine font-bold">{eng?.name ?? r.engineId}</td>
                    <td>
                      <span className={`mini-tag ${eng?.storage === 'memory' ? 'tag-mem' : 'tag-disk'}`}>
                        {eng?.storage}
                      </span>
                    </td>
                    <td>{scen?.name ?? r.scenarioId}</td>
                    <td colSpan={6} className="td-error-msg">
                      <div className="error-cell">
                        <AlertCircle size={14} />
                        <span>{r.error}</span>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={`${r.engineId}-${r.scenarioId}-${idx}`}>
                  <td className="td-engine font-bold">{eng?.name ?? r.engineId}</td>
                  <td>
                    <span className={`mini-tag ${eng?.storage === 'memory' ? 'tag-mem' : 'tag-disk'}`}>
                      {eng?.storage}
                    </span>
                  </td>
                  <td className="td-scen">{scen?.name ?? r.scenarioId}</td>
                  <td className="td-num font-mono td-highlight">
                    {r.opsPerSec.toLocaleString()} ops/s
                  </td>
                  <td className="td-num font-mono">{r.meanMs.toFixed(2)}</td>
                  <td className="td-num font-mono text-muted">{r.minMs.toFixed(2)}</td>
                  <td className="td-num font-mono">{r.p95Ms.toFixed(2)}</td>
                  <td className="td-num font-mono text-muted">{r.maxMs.toFixed(2)}</td>
                  <td className="td-num font-mono text-muted">{memMb}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
