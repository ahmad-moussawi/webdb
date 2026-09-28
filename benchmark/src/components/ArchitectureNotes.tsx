import React from 'react';
import { BookOpen, Layers, Cpu, Database, Binary } from 'lucide-react';

export const ArchitectureNotes: React.FC = () => {
  return (
    <div className="notes-card">
      <div className="notes-header">
        <BookOpen className="text-brand" size={20} />
        <h2 className="notes-title">Architectural Underpinnings & Analysis</h2>
      </div>

      <div className="notes-grid">
        <div className="note-item">
          <div className="note-item-header">
            <Cpu size={16} className="text-amber" />
            <h4 className="note-item-title">Raw JS Array (The Theoretical Ceiling)</h4>
          </div>
          <p className="note-item-desc">
            Raw JavaScript arrays store native V8 Heap objects with JIT-optimized hidden classes (Shapes).
            There is zero serialization, zero page-boundary tracking, and zero transaction log. It represents
            the absolute memory-speed limit in the browser.
          </p>
        </div>

        <div className="note-item">
          <div className="note-item-header">
            <Binary size={16} className="text-indigo" />
            <h4 className="note-item-title">WebDB (Slotted Pages & Bytecode VM)</h4>
          </div>
          <p className="note-item-desc">
            WebDB packs records into 4KB slotted binary pages within WebAssembly linear memory, managed by
            an LRU buffer pool. Queries compile directly into compact VDBE bytecode executed by an in-engine
            virtual machine. In-memory mode eliminates VFS IPC entirely while keeping relational ACID guarantees.
          </p>
        </div>

        <div className="note-item">
          <div className="note-item-header">
            <Layers size={16} className="text-pink" />
            <h4 className="note-item-title">Native IndexedDB (Structured Clone & IPC)</h4>
          </div>
          <p className="note-item-desc">
            IndexedDB operations marshal JavaScript objects through the browser’s internal structured clone
            algorithm across IPC boundaries to disk-backed LevelDB/SQLite storage. B-tree indexes enable fast
            bounded range scans, but individual object deserialization adds noticeable CPU overhead.
          </p>
        </div>

        <div className="note-item">
          <div className="note-item-header">
            <Database size={16} className="text-sky" />
            <h4 className="note-item-title">SQLite WASM (C Engine & OPFS Sync)</h4>
          </div>
          <p className="note-item-desc">
            The full SQLite3 C codebase compiled to WebAssembly. Features mature B-Tree paging and an industrial-grade
            query planner. When backed by OPFS (Origin Private File System), it achieves near-native I/O throughput
            via synchronous file handles, but suffers JS-to-WASM bridge translation overhead on point lookups.
          </p>
        </div>
      </div>
    </div>
  );
};
