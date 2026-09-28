import React, { useState } from 'react';
import { AVAILABLE_ENGINES, AVAILABLE_SCENARIOS, ScenarioId, ScenarioResult } from '../adapters/index.js';
import { BarChart3, Clock, Zap } from 'lucide-react';

interface Props {
  results: ScenarioResult[];
}

export const ComparisonCharts: React.FC<Props> = ({ results }) => {
  const [metric, setMetric] = useState<'ops' | 'latency'>('ops');

  if (results.length === 0) {
    return null;
  }

  // Group results by scenario
  const groupedByScenario = new Map<ScenarioId, ScenarioResult[]>();
  for (const r of results) {
    if (!groupedByScenario.has(r.scenarioId)) {
      groupedByScenario.set(r.scenarioId, []);
    }
    groupedByScenario.get(r.scenarioId)!.push(r);
  }

  const engineMap = new Map(AVAILABLE_ENGINES.map((e) => [e.id, e]));

  return (
    <div className="charts-card">
      <div className="charts-header">
        <div className="charts-title-group">
          <BarChart3 className="text-brand" size={20} />
          <h2 className="charts-title">Performance Comparison</h2>
        </div>

        <div className="metric-switch">
          <button
            onClick={() => setMetric('ops')}
            className={`metric-btn ${metric === 'ops' ? 'active' : ''}`}
          >
            <Zap size={14} />
            <span>Throughput (Ops/sec - Higher is better)</span>
          </button>
          <button
            onClick={() => setMetric('latency')}
            className={`metric-btn ${metric === 'latency' ? 'active' : ''}`}
          >
            <Clock size={14} />
            <span>Mean Latency (ms - Lower is better)</span>
          </button>
        </div>
      </div>

      <div className="scenarios-chart-list">
        {AVAILABLE_SCENARIOS.filter((s) => groupedByScenario.has(s.id)).map((scenario) => {
          const scenarioResults = groupedByScenario.get(scenario.id) || [];
          if (scenarioResults.length === 0) return null;

          // Find maximum for scale
          const maxOps = Math.max(...scenarioResults.map((r) => r.opsPerSec || 0), 1);
          const maxLatency = Math.max(...scenarioResults.map((r) => r.meanMs || 0), 0.1);

          // Find fastest engine
          let fastestEngine: ScenarioResult | null = null;
          if (metric === 'ops') {
            fastestEngine = [...scenarioResults].sort((a, b) => b.opsPerSec - a.opsPerSec)[0];
          } else {
            fastestEngine = [...scenarioResults].filter(r => !r.error && r.meanMs > 0).sort((a, b) => a.meanMs - b.meanMs)[0] || null;
          }

          return (
            <div key={scenario.id} className="scenario-chart-group">
              <div className="scenario-chart-header">
                <div>
                  <h3 className="scenario-chart-title">{scenario.name}</h3>
                  <span className="scenario-chart-sub">{scenario.description}</span>
                </div>
                {fastestEngine && !fastestEngine.error && (
                  <span className="winner-pill">
                    Fastest: {engineMap.get(fastestEngine.engineId)?.name}
                  </span>
                )}
              </div>

              <div className="bars-container">
                {scenarioResults.map((res) => {
                  const engine = engineMap.get(res.engineId);
                  const isWinner = fastestEngine?.engineId === res.engineId;
                  const hasError = !!res.error;

                  let barPercentage = 0;
                  let displayVal = '';

                  if (hasError) {
                    barPercentage = 0;
                    displayVal = 'Error';
                  } else if (metric === 'ops') {
                    barPercentage = (res.opsPerSec / maxOps) * 100;
                    displayVal = `${res.opsPerSec.toLocaleString()} ops/s`;
                  } else {
                    // For latency: percentage is relative to maxLatency
                    barPercentage = Math.max((res.meanMs / maxLatency) * 100, 2);
                    displayVal = `${res.meanMs.toFixed(2)} ms`;
                  }

                  return (
                    <div key={res.engineId} className="bar-row">
                      <div className="bar-label-col">
                        <span className="bar-engine-name">{engine?.name ?? res.engineId}</span>
                        <span
                          className={`storage-dot ${
                            engine?.storage === 'memory' ? 'dot-mem' : 'dot-disk'
                          }`}
                          title={engine?.storage === 'memory' ? 'In-Memory RAM' : 'Persistent Storage'}
                        />
                      </div>

                      <div className="bar-track-col">
                        <div className="bar-track">
                          <div
                            className={`bar-fill ${isWinner ? 'bar-winner' : ''} ${hasError ? 'bar-error' : ''}`}
                            style={{
                              width: `${Math.min(Math.max(barPercentage, hasError ? 0 : 2), 100)}%`,
                              backgroundColor: hasError ? '#ef4444' : engine?.badgeColor || '#6366f1',
                            }}
                          />
                        </div>
                      </div>

                      <div className="bar-val-col">
                        <span className={`bar-value-text ${isWinner ? 'val-winner' : ''} ${hasError ? 'val-error' : ''}`}>
                          {displayVal}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
