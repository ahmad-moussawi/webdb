import React, { useEffect } from 'react';
import { useStudio } from '../../context/StudioContext';
import { X, Cpu, Layers, ShieldCheck, Zap, ExternalLink, BookOpen } from 'lucide-react';

export const AboutModal: React.FC = () => {
  const {
    isAboutModalOpen,
    setIsAboutModalOpen,
    coreMode,
    activeDbName,
    activeStorage,
    tables,
  } = useStudio();

  useEffect(() => {
    if (!isAboutModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsAboutModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAboutModalOpen, setIsAboutModalOpen]);

  if (!isAboutModalOpen) return null;

  return (
    <div
      id="aboutModal"
      className="modal-backdrop"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setIsAboutModalOpen(false);
        }
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: '480px', width: '100%' }}
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <svg
              className="brand-logo"
              viewBox="0 0 100 100"
              width="28"
              height="28"
            >
              <defs>
                <linearGradient
                  id="aboutBrandGrad"
                  x1="0"
                  y1="0"
                  x2="100"
                  y2="100"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#3B82F6" />
                  <stop offset="1" stopColor="#8B5CF6" />
                </linearGradient>
              </defs>
              <rect width="100" height="100" rx="20" fill="url(#aboutBrandGrad)" />
              <path
                d="M25 35L50 20L75 35L50 50L25 35Z"
                fill="#ffffff"
                fillOpacity="0.9"
              />
              <path
                d="M25 50L50 65L75 50"
                stroke="#ffffff"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M25 65L50 80L75 65"
                stroke="#ffffff"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div>
              <div
                className="modal-title-text"
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                <span>WebDB Studio</span>
                <span className="brand-badge">IDE</span>
              </div>
              <div className="modal-subtitle-text">
                Version 0.1.0-alpha.0 • Browser-Native Relational Database Engine
              </div>
            </div>
          </div>
          <button
            id="closeAboutModalBtn"
            className="modal-close-btn"
            onClick={() => setIsAboutModalOpen(false)}
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            <strong>WebDB</strong> is an ultra-lean (&lt; 100 KB), zero-dependency relational database engine built for local-first web apps, featuring 4 KB slotted binary pages, a register-based VDBE bytecode execution engine, ACID Write-Ahead Logging (WAL), and real-time multi-tab synchronization.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '8px',
              background: 'var(--bg-panel)',
              border: '1px solid var(--card-border)',
              borderRadius: 'var(--radius)',
              padding: '10px 12px',
              fontSize: '0.73rem',
            }}
          >
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem', textTransform: 'uppercase', fontWeight: 700 }}>
                Package Version
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text)', marginTop: '2px' }}>
                @ahmadmoussawi/webdb@0.1.0-alpha.0
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem', textTransform: 'uppercase', fontWeight: 700 }}>
                Active Core Engine
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent)', marginTop: '2px' }}>
                {coreMode === 'wasm' ? 'WebAssembly (Compiled C)' : 'JavaScript (Pure JS)'}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem', textTransform: 'uppercase', fontWeight: 700 }}>
                Active Database
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text)', marginTop: '2px' }}>
                {activeDbName} ({tables.length} tables)
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem', textTransform: 'uppercase', fontWeight: 700 }}>
                Storage Backend (VFS)
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text)', marginTop: '2px' }}>
                {activeStorage === 'idb' ? 'IndexedDB (Persistent)' : 'Memory (Ephemeral RAM)'}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Layers size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span>4,096-byte Slotted Binary Pages with IEEE 802.3 CRC32 Checksums</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Cpu size={14} style={{ color: '#8b5cf6', flexShrink: 0 }} />
              <span>64-Register VDBE Bytecode VM with 8-Frame Subquery Stack</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck size={14} style={{ color: 'var(--emerald)', flexShrink: 0 }} />
              <span>ACID Write-Ahead Log (WAL), Savepoints &amp; Multi-Tab Web Locks</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Zap size={14} style={{ color: '#f59e0b', flexShrink: 0 }} />
              <span>Transactional Sync Hooks, Coalesced Changesets &amp; BroadcastChannel</span>
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => window.open('../getting-started.html', '_blank')}
            >
              <BookOpen size={12} />
              <span>Docs</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => window.open('https://github.com/ahmad-moussawi/webdb', '_blank')}
            >
              <ExternalLink size={12} />
              <span>GitHub</span>
            </button>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setIsAboutModalOpen(false)}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

