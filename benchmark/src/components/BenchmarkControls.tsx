import React from 'react';
import { Play, Square, Loader2, CheckSquare } from 'lucide-react';
import { AVAILABLE_ENGINES, AVAILABLE_SCENARIOS, EngineId, ScenarioId } from '../adapters/index.js';
import { ProgressUpdate } from '../engine/runner.js';

interface Props {
  datasetSize: number;
  setDatasetSize: (size: number) => void;
  selectedEngines: EngineId[];
  setSelectedEngines: (engines: EngineId[]) => void;
  selectedScenarios: ScenarioId[];
  setSelectedScenarios: (scenarios: ScenarioId[]) => void;
  iterations: number;
  setIterations: (iters: number) => void;
  isRunning: boolean;
  progress: ProgressUpdate | null;
  onRun: () => void;
  onStop: () => void;
}

export const BenchmarkControls: React.FC<Props> = ({
  datasetSize,
  setDatasetSize,
  selectedEngines,
  setSelectedEngines,
  selectedScenarios,
  setSelectedScenarios,
  iterations,
  setIterations,
  isRunning,
  progress,
  onRun,
  onStop,
}) => {
  const toggleEngine = (id: EngineId) => {
    if (isRunning) return;
    if (selectedEngines.includes(id)) {
      if (selectedEngines.length > 1) {
        setSelectedEngines(selectedEngines.filter((e) => e !== id));
      }
    } else {
      setSelectedEngines([...selectedEngines, id]);
    }
  };

  const toggleScenario = (id: ScenarioId) => {
    if (isRunning) return;
    if (selectedScenarios.includes(id)) {
      if (selectedScenarios.length > 1) {
        setSelectedScenarios(selectedScenarios.filter((s) => s !== id));
      }
    } else {
      setSelectedScenarios([...selectedScenarios, id]);
    }
  };

  const selectFilter = (type: 'all' | 'memory' | 'persistent') => {
    if (isRunning) return;
    if (type === 'all') {
      setSelectedEngines(AVAILABLE_ENGINES.map((e) => e.id));
    } else if (type === 'memory') {
      setSelectedEngines(AVAILABLE_ENGINES.filter((e) => e.storage === 'memory').map((e) => e.id));
    } else {
      setSelectedEngines(AVAILABLE_ENGINES.filter((e) => e.storage === 'persistent').map((e) => e.id));
    }
  };

  const percentComplete = progress
    ? Math.round((progress.currentStep / progress.totalSteps) * 100)
    : 0;

  return (
    <aside className="sidebar-controls">
      {/* Primary Action Button */}
      <div className="action-box">
        {!isRunning ? (
          <button className="btn-run" onClick={onRun}>
            <Play size={15} fill="currentColor" />
            <span>Run Benchmark</span>
          </button>
        ) : (
          <button className="btn-stop" onClick={onStop}>
            <Square size={14} fill="currentColor" />
            <span>Cancel Benchmark</span>
          </button>
        )}

        {/* Inline Progress Bar */}
        {isRunning && progress && (
          <div className="sidebar-progress">
            <div className="progress-info-row">
              <span className="progress-current">
                <Loader2 size={12} className="spinner" />
                <strong>{progress.engineName}</strong>
              </span>
              <span className="progress-step">
                {progress.currentStep}/{progress.totalSteps} ({percentComplete}%)
              </span>
            </div>
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${percentComplete}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Dataset Scale & Iterations */}
      <div className="control-section">
        <div className="section-label">Dataset Size (Rows)</div>
        <div className="segmented-control">
          {[1000, 5000, 10000, 25000].map((size) => (
            <button
              key={size}
              disabled={isRunning}
              onClick={() => setDatasetSize(size)}
              className={`seg-btn ${datasetSize === size ? 'active' : ''}`}
            >
              {size >= 1000 ? `${size / 1000}k` : size}
            </button>
          ))}
        </div>
      </div>

      <div className="control-section">
        <div className="section-label">Iterations</div>
        <div className="segmented-control">
          {[3, 5, 10].map((count) => (
            <button
              key={count}
              disabled={isRunning}
              onClick={() => setIterations(count)}
              className={`seg-btn ${iterations === count ? 'active' : ''}`}
            >
              {count}x
            </button>
          ))}
        </div>
      </div>

      {/* Target Database Engines */}
      <div className="control-section">
        <div className="section-header-row">
          <span className="section-label">Database Engines ({selectedEngines.length})</span>
          <div className="mini-presets">
            <button onClick={() => selectFilter('all')} disabled={isRunning}>All</button>
            <button onClick={() => selectFilter('memory')} disabled={isRunning}>RAM</button>
            <button onClick={() => selectFilter('persistent')} disabled={isRunning}>Disk</button>
          </div>
        </div>

        <div className="items-list">
          {AVAILABLE_ENGINES.map((engine) => {
            const checked = selectedEngines.includes(engine.id);
            return (
              <label
                key={engine.id}
                className={`item-row ${checked ? 'checked' : ''} ${isRunning ? 'disabled' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleEngine(engine.id)}
                  disabled={isRunning}
                />
                <span className="item-name">{engine.name}</span>
                <span className={`type-tag ${engine.storage === 'memory' ? 'tag-ram' : 'tag-disk'}`}>
                  {engine.storage === 'memory' ? 'RAM' : 'Disk'}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Benchmark Scenarios */}
      <div className="control-section">
        <div className="section-header-row">
          <span className="section-label">Test Scenarios ({selectedScenarios.length})</span>
        </div>

        <div className="items-list">
          {AVAILABLE_SCENARIOS.map((scen) => {
            const checked = selectedScenarios.includes(scen.id);
            return (
              <label
                key={scen.id}
                className={`item-row ${checked ? 'checked' : ''} ${isRunning ? 'disabled' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleScenario(scen.id)}
                  disabled={isRunning}
                />
                <div className="item-details">
                  <span className="item-name">{scen.name}</span>
                </div>
              </label>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
