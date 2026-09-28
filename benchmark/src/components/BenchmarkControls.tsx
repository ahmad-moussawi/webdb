import React from 'react';
import { Play, Square, Settings, HardDrive, Cpu, CheckSquare } from 'lucide-react';
import { AVAILABLE_ENGINES, AVAILABLE_SCENARIOS, EngineId, ScenarioId } from '../adapters/index.js';

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

  return (
    <div className="controls-card">
      <div className="controls-section">
        {/* Dataset Scale */}
        <div className="config-group">
          <label className="config-label">
            <Settings size={15} />
            <span>Dataset Scale (Rows)</span>
          </label>
          <div className="button-group">
            {[1000, 5000, 10000, 25000].map((size) => (
              <button
                key={size}
                disabled={isRunning}
                onClick={() => setDatasetSize(size)}
                className={`pill-btn ${datasetSize === size ? 'active' : ''}`}
              >
                {size.toLocaleString()}
              </button>
            ))}
          </div>
        </div>

        {/* Iterations */}
        <div className="config-group">
          <label className="config-label">
            <CheckSquare size={15} />
            <span>Sample Iterations</span>
          </label>
          <div className="button-group">
            {[3, 5, 10].map((count) => (
              <button
                key={count}
                disabled={isRunning}
                onClick={() => setIterations(count)}
                className={`pill-btn ${iterations === count ? 'active' : ''}`}
              >
                {count}x
              </button>
            ))}
          </div>
        </div>

        {/* Quick Filter */}
        <div className="config-group">
          <label className="config-label">
            <span>Filter Presets</span>
          </label>
          <div className="button-group">
            <button
              disabled={isRunning}
              onClick={() => selectFilter('all')}
              className="preset-btn"
            >
              All Engines
            </button>
            <button
              disabled={isRunning}
              onClick={() => selectFilter('memory')}
              className="preset-btn"
            >
              In-Memory Only
            </button>
            <button
              disabled={isRunning}
              onClick={() => selectFilter('persistent')}
              className="preset-btn"
            >
              Persistent Only
            </button>
          </div>
        </div>

        {/* Action Button */}
        <div className="run-action-container">
          {!isRunning ? (
            <button className="primary-run-btn" onClick={onRun}>
              <Play size={18} fill="currentColor" />
              <span>Run Suite</span>
            </button>
          ) : (
            <button className="stop-run-btn" onClick={onStop}>
              <Square size={16} fill="currentColor" />
              <span>Cancel Run</span>
            </button>
          )}
        </div>
      </div>

      {/* Engine Selection Grid */}
      <div className="selection-grid-container">
        <div className="grid-header">
          <span className="grid-title">Database Engines ({selectedEngines.length} selected)</span>
        </div>
        <div className="engines-grid">
          {AVAILABLE_ENGINES.map((engine) => {
            const isSelected = selectedEngines.includes(engine.id);
            return (
              <div
                key={engine.id}
                onClick={() => toggleEngine(engine.id)}
                className={`engine-card ${isSelected ? 'selected' : ''} ${isRunning ? 'disabled' : ''}`}
              >
                <div className="engine-card-header">
                  <div className="engine-card-checkbox">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      readOnly
                      disabled={isRunning}
                    />
                  </div>
                  <div className="engine-card-titles">
                    <div className="engine-card-name">{engine.name}</div>
                    <div className="engine-card-sub">{engine.subtitle}</div>
                  </div>
                  <span
                    className={`storage-tag ${
                      engine.storage === 'memory' ? 'tag-mem' : 'tag-disk'
                    }`}
                  >
                    {engine.storage === 'memory' ? (
                      <>
                        <Cpu size={11} /> RAM
                      </>
                    ) : (
                      <>
                        <HardDrive size={11} /> Disk
                      </>
                    )}
                  </span>
                </div>
                <div className="engine-card-desc">{engine.description}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Scenario Selection Grid */}
      <div className="selection-grid-container">
        <div className="grid-header">
          <span className="grid-title">Benchmark Scenarios ({selectedScenarios.length} selected)</span>
        </div>
        <div className="scenarios-grid">
          {AVAILABLE_SCENARIOS.map((scen) => {
            const isSelected = selectedScenarios.includes(scen.id);
            return (
              <div
                key={scen.id}
                onClick={() => toggleScenario(scen.id)}
                className={`scenario-card ${isSelected ? 'selected' : ''} ${isRunning ? 'disabled' : ''}`}
              >
                <div className="scenario-card-header">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    disabled={isRunning}
                  />
                  <span className="scenario-card-name">{scen.name}</span>
                  <span className={`category-tag cat-${scen.category}`}>
                    {scen.category}
                  </span>
                </div>
                <p className="scenario-card-desc">{scen.description}</p>
                <code className="scenario-card-code">{scen.queryHint}</code>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
