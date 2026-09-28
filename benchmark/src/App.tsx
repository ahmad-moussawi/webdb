import React, { useState, useRef } from 'react';
import { Header } from './components/Header.js';
import { BenchmarkControls } from './components/BenchmarkControls.js';
import { ComparisonCharts } from './components/ComparisonCharts.js';
import { ResultsTable } from './components/ResultsTable.js';
import { ArchitectureNotes } from './components/ArchitectureNotes.js';
import { AVAILABLE_ENGINES, AVAILABLE_SCENARIOS, EngineId, ScenarioId, ScenarioResult } from './adapters/index.js';
import { ProgressUpdate, runBenchmarkSuite } from './engine/runner.js';
import { Loader2 } from 'lucide-react';

export const App: React.FC = () => {
  const [datasetSize, setDatasetSize] = useState<number>(5000);
  const [iterations, setIterations] = useState<number>(5);
  const [selectedEngines, setSelectedEngines] = useState<EngineId[]>([
    'raw_array',
    'webdb_mem',
    'sqlite_mem',
    'indexeddb',
  ]);
  const [selectedScenarios, setSelectedScenarios] = useState<ScenarioId[]>([
    'bulk_insert',
    'point_lookup',
    'range_scan',
    'sort_limit',
    'aggregation',
    'join_query',
  ]);

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [results, setResults] = useState<ScenarioResult[]>([]);

  const abortRequestedRef = useRef<boolean>(false);

  const handleRun = async () => {
    if (isRunning) return;
    setIsRunning(true);
    abortRequestedRef.current = false;
    setResults([]);
    setProgress(null);

    try {
      const suiteResults = await runBenchmarkSuite(
        {
          datasetSize,
          engines: selectedEngines,
          scenarios: selectedScenarios,
          iterations,
        },
        (update) => {
          setProgress(update);
          if (update.latestResult) {
            setResults((prev) => {
              // Replace existing result if present, otherwise append
              const filtered = prev.filter(
                (r) =>
                  !(
                    r.engineId === update.latestResult!.engineId &&
                    r.scenarioId === update.latestResult!.scenarioId
                  )
              );
              return [...filtered, update.latestResult!];
            });
          }
        },
        () => abortRequestedRef.current
      );

      setResults(suiteResults);
    } catch (err) {
      console.error('Benchmark suite execution failed:', err);
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  };

  const handleStop = () => {
    abortRequestedRef.current = true;
  };

  const percentComplete = progress
    ? Math.round((progress.currentStep / progress.totalSteps) * 100)
    : 0;

  return (
    <div className="app-container">
      <Header />

      <main className="main-content">
        {/* Progress Alert Bar */}
        {isRunning && progress && (
          <div className="progress-banner">
            <div className="progress-banner-inner">
              <div className="progress-text-row">
                <div className="progress-indicator">
                  <Loader2 size={18} className="spinner" />
                  <span className="progress-title">
                    Benchmarking <strong>{progress.engineName}</strong> —{' '}
                    <span>{progress.scenarioId.replace(/_/g, ' ').toUpperCase()}</span>
                  </span>
                </div>
                <span className="progress-percent">
                  Step {progress.currentStep} of {progress.totalSteps} ({percentComplete}%)
                </span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${percentComplete}%` }}
                />
              </div>
            </div>
          </div>
        )}

        <BenchmarkControls
          datasetSize={datasetSize}
          setDatasetSize={setDatasetSize}
          selectedEngines={selectedEngines}
          setSelectedEngines={setSelectedEngines}
          selectedScenarios={selectedScenarios}
          setSelectedScenarios={setSelectedScenarios}
          iterations={iterations}
          setIterations={setIterations}
          isRunning={isRunning}
          onRun={handleRun}
          onStop={handleStop}
        />

        {results.length > 0 && (
          <>
            <ComparisonCharts results={results} />
            <ResultsTable results={results} datasetSize={datasetSize} />
          </>
        )}

        <ArchitectureNotes />
      </main>

      <footer className="footer-container">
        <p>
          WebDB Benchmarking Suite • Browser Native Database Performance Lab • Built with Vite & React
        </p>
      </footer>
    </div>
  );
};
