import React, { useEffect, useState } from 'react';
import { Database, ShieldCheck, AlertTriangle, Cpu, Layers, ExternalLink } from 'lucide-react';
import { SqliteWasmAdapter } from '../adapters/sqlite_adapter.js';

export const Header: React.FC = () => {
  const [isIsolated, setIsIsolated] = useState(false);
  const [hasOpfs, setHasOpfs] = useState(false);
  const [heapSize, setHeapSize] = useState<string>('N/A');

  useEffect(() => {
    const isolated = typeof window !== 'undefined' && window.crossOriginIsolated;
    setIsIsolated(!!isolated);

    SqliteWasmAdapter.isOpfsSupported().then(setHasOpfs);

    const updateHeap = () => {
      const perfWithMemory = performance as unknown as {
        memory?: { usedJSHeapSize: number };
      };
      if (typeof performance !== 'undefined' && perfWithMemory.memory) {
        const bytes = perfWithMemory.memory.usedJSHeapSize;
        setHeapSize(`${(bytes / (1024 * 1024)).toFixed(1)} MB`);
      }
    };
    updateHeap();
    const interval = setInterval(updateHeap, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="app-header">
      <div className="header-left">
        <div className="app-logo">
          <Database size={18} className="logo-icon" />
          <span className="logo-title">WebDB Benchmark</span>
          <span className="logo-badge">v0.1</span>
        </div>
        <span className="header-divider" />
        <span className="header-subtitle">Performance & Memory Comparison</span>
      </div>

      <div className="header-center">
        <div className={`status-chip ${isIsolated ? 'chip-success' : 'chip-neutral'}`} title={isIsolated ? 'COOP/COEP headers active. High-precision timers & SharedArrayBuffer enabled.' : 'Cross-Origin-Isolation inactive.'}>
          {isIsolated ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
          <span>COOP/COEP: {isIsolated ? 'Isolated' : 'Restricted'}</span>
        </div>

        <div className={`status-chip ${hasOpfs ? 'chip-success' : 'chip-neutral'}`} title="Origin Private File System support for SQLite WASM">
          <Layers size={13} />
          <span>OPFS: {hasOpfs ? 'Ready' : 'In-Memory Only'}</span>
        </div>

        <div className="status-chip chip-neutral" title="V8 JavaScript Heap Size">
          <Cpu size={13} />
          <span>Heap: {heapSize}</span>
        </div>
      </div>

      <div className="header-right">
        <a href="../" className="nav-btn" title="Documentation">Docs</a>
        <a href="../playground/" className="nav-btn" title="WebDB Studio IDE">Studio IDE</a>
        <a
          href="https://github.com/ahmad-moussawi/webdb"
          target="_blank"
          rel="noopener noreferrer"
          className="nav-btn nav-btn-github"
          title="GitHub Repository"
        >
          <span>GitHub</span>
          <ExternalLink size={11} />
        </a>
      </div>
    </header>
  );
};
