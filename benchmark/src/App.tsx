import React, { useState, useRef } from 'react';
import { Header } from './components/Header.js';
import { BenchmarkControls } from './components/BenchmarkControls.js';
import { ResultsView } from './components/ResultsView.js';
import { EngineId, ScenarioId, ScenarioResult } from './adapters/index.js';
import { ProgressUpdate, runBenchmarkSuite } from './engine/runner.js';

const STORAGE_KEYS = {
  ENGINES: 'webdb_benchmark_selected_engines_v2',
  SCENARIOS: 'webdb_benchmark_selected_scenarios_v2',
  DATASET_SIZE: 'webdb_benchmark_dataset_size_v2',
  ITERATIONS: 'webdb_benchmark_iterations_v2',
};

const DEFAULT_ENGINES: EngineId[] = ['webdb_idb', 'indexeddb'];
const DEFAULT_SCENARIOS: ScenarioId[] = [
  'bulk_insert',
  'point_lookup',
  'range_scan',
  'sort_limit',
  'aggregation',
  'join_query',
];

function getStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(fallback) && Array.isArray(parsed)) {
        return parsed as T;
      }
      if (typeof fallback === typeof parsed) {
        return parsed as T;
      }
    }
  } catch {
    // fallback
  }
  return fallback;
}

export const App: React.FC = () => {
  const [datasetSize, setDatasetSize] = useState<number>(() =>
    getStoredValue(STORAGE_KEYS.DATASET_SIZE, 5000),
  );
  const [iterations, setIterations] = useState<number>(() =>
    getStoredValue(STORAGE_KEYS.ITERATIONS, 5),
  );
  const [selectedEngines, setSelectedEngines] = useState<EngineId[]>(() =>
    getStoredValue(STORAGE_KEYS.ENGINES, DEFAULT_ENGINES),
  );
  const [selectedScenarios, setSelectedScenarios] = useState<ScenarioId[]>(() =>
    getStoredValue(STORAGE_KEYS.SCENARIOS, DEFAULT_SCENARIOS),
  );

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.DATASET_SIZE, JSON.stringify(datasetSize));
    } catch {}
  }, [datasetSize]);

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.ITERATIONS, JSON.stringify(iterations));
    } catch {}
  }, [iterations]);

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.ENGINES, JSON.stringify(selectedEngines));
    } catch {}
  }, [selectedEngines]);

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.SCENARIOS, JSON.stringify(selectedScenarios));
    } catch {}
  }, [selectedScenarios]);

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
