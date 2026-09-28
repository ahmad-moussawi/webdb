import React, { useEffect, useState } from 'react';
import { Database, ShieldCheck, AlertTriangle, Cpu, Layers } from 'lucide-react';
import { SqliteWasmAdapter } from '../adapters/sqlite_adapter.js';

export const Header: React.FC = () => {
  const [isIsolated, setIsIsolated] = useState(false);
  const [hasOpfs, setHasOpfs] = useState(false);
  const [heapSize, setHeapSize] = useState<string>('N/A');

  useEffect(() => {
    // Check Cross-Origin Isolation (COOP + COEP)
    const isolated = typeof window !== 'undefined' && window.crossOriginIsolated;
    setIsIsolated(!!isolated);

    // Check OPFS support in SQLite Wasm
    SqliteWasmAdapter.isOpfsSupported().then(setHasOpfs);

    // Heap stats
    const updateHeap = () => {
      if (typeof performance !== 'undefined' && (performance as any).memory) {
        const bytes = (performance as any).memory.usedJSHeapSize;
        setHeapSize(`${(bytes / (1024 * 1024)).toFixed(1)} MB`);
      }
    };
    updateHeap();
    const interval = setInterval(updateHeap, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="header-container">
      <div className="header-top">
        <div className="header-brand">
          <div className="brand-icon">
            <Database size={26} className="text-brand" />
          </div>
          <div>
            <div className="brand-title-row">
              <h1 className="brand-title">Browser Database Benchmark Suite</h1>
              <span className="version-pill">v0.1.0</span>
            </div>
            <p className="brand-subtitle">
              High-precision latency, throughput, and memory profiling between Raw JS Arrays, WebDB, IndexedDB, and SQLite WASM.
            </p>
          </div>
        </div>

        <div className="header-badges">
          <div className={`env-badge ${isIsolated ? 'badge-success' : 'badge-warning'}`} title={isIsolated ? 'COOP/COEP headers active. High-precision timers & SharedArrayBuffer enabled.' : 'Cross-Origin-Isolation inactive.'}>
            {isIsolated ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
            <span>COOP/COEP: {isIsolated ? 'Isolated' : 'Restricted'}</span>
          </div>

          <div className={`env-badge ${hasOpfs ? 'badge-success' : 'badge-neutral'}`} title="Origin Private File System support for SQLite WASM">
            <Layers size={14} />
            <span>OPFS: {hasOpfs ? 'Ready' : 'In-Memory Only'}</span>
          </div>

          <div className="env-badge badge-neutral" title="Current V8 JavaScript Heap">
            <Cpu size={14} />
            <span>Heap: {heapSize}</span>
          </div>
        </div>
      </div>
    </header>
  );
};
