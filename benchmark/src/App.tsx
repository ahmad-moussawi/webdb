import React, { useState, useRef } from 'react';
import { Header } from './components/Header.js';
import { BenchmarkControls } from './components/BenchmarkControls.js';
import { ResultsView } from './components/ResultsView.js';
import { EngineId, ScenarioId, ScenarioResult } from './adapters/index.js';
import { ProgressUpdate, runBenchmarkSuite } from './engine/runner.js';

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

  return (
    <div className="app-shell">
      <Header />

      <div className="workspace-layout">
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
          progress={progress}
          onRun={handleRun}
          onStop={handleStop}
        />

        <main className="workspace-main">
          <ResultsView results={results} datasetSize={datasetSize} />
        </main>
      </div>
    </div>
  );
};
