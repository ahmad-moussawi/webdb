import React, { useState, useEffect, useRef } from 'react';
import { useStudio } from '../../context/StudioContext';
import type { VfsType } from '../../types/studio';
import {
  Database,
  X,
  Zap,
  HardDrive,
  Check,
  FileCode,
  ShoppingBag,
  Layers,
  Globe,
  Plus,
} from 'lucide-react';

interface TemplateOption {
  key: string;
  name: string;
  tag: string;
  isPopular?: boolean;
  icon: React.ReactNode;
  description: string;
}

const TEMPLATES: TemplateOption[] = [
  {
    key: 'empty',
    name: 'Empty Database',
    tag: '0 rows',
    icon: <FileCode size={18} />,
    description: 'Clean slate with 0 tables. Ready for custom SQL schemas and DDL.',
  },
  {
    key: 'store_standard',
    name: 'E-Commerce Store',
    tag: '1,500 rows',
    isPopular: true,
    icon: <ShoppingBag size={18} />,
    description: '5 relational tables: categories, products, customers, orders, and reviews.',
  },
  {
    key: 'store_large',
    name: 'Large Benchmark Store',
    tag: '10,000 rows',
    icon: <Layers size={18} />,
    description: 'Stress-test dataset for query optimization, B-Tree splits, and indexing.',
  },
  {
    key: 'store_real_api',
    name: 'Real Products API',
    tag: 'Live HTTP',
    icon: <Globe size={18} />,
    description: 'Fetches real-world catalog data from dummyjson.com API.',
  },
];

export const NewDbModal: React.FC = () => {
  const { isNewDbModalOpen, setIsNewDbModalOpen, createDb } = useStudio();
  const [dbName, setDbName] = useState<string>('');
  const [vfs, setVfs] = useState<VfsType>('memory');
  const [template, setTemplate] = useState<string>('store_standard');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNewDbModalOpen) {
      setDbName('');
      setError(null);
      setTouched(false);
      setVfs('memory');
      setTemplate('store_standard');
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [isNewDbModalOpen]);

  useEffect(() => {
    if (!isNewDbModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsNewDbModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isNewDbModalOpen, setIsNewDbModalOpen]);

  if (!isNewDbModalOpen) return null;

  const rawTrimmed = dbName.trim();
  const cleanName = rawTrimmed.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const isValidName = cleanName.length > 0;

  const handleNameChange = (val: string) => {
    setDbName(val);
    if (error) setError(null);
  };

  const handleConfirm = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setTouched(true);

    if (!rawTrimmed) {
      setError('Database name is required');
      inputRef.current?.focus();
      return;
    }

    if (!isValidName) {
      setError('Name must contain alphanumeric characters or underscores');
      inputRef.current?.focus();
      return;
    }

    setIsNewDbModalOpen(false);
    await createDb(cleanName, vfs, template);
  };

  return (
    <div
      id="newDbModal"
      className="modal-backdrop"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setIsNewDbModalOpen(false);
        }
      }}
    >
      <div className="modal-card modal-card-wide" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <Database size={18} className="modal-title-icon" />
            <div>
              <div className="modal-title-text">Create New Database</div>
              <div className="modal-subtitle-text">
                Configure storage engine and starting dataset
              </div>
            </div>
          </div>
          <button
            id="closeModalBtn"
            className="modal-close-btn"
            onClick={() => setIsNewDbModalOpen(false)}
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body Form */}
        <form onSubmit={handleConfirm}>
          <div className="modal-body">
            {/* 1. Database Name */}
            <div className="form-group">
              <div className="modal-label-row">
                <label htmlFor="modalDbNameInput" className="modal-label">
                  Database Name
                </label>
                <span className="required-badge">Required</span>
              </div>
              <input
                ref={inputRef}
                id="modalDbNameInput"
                type="text"
                className={`modal-input ${touched && !isValidName ? 'input-error' : ''}`}
                value={dbName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. ecommerce_db, analytics_db, sandbox"
                autoComplete="off"
                spellCheck={false}
              />
              {cleanName && cleanName !== rawTrimmed && (
                <div className="name-sanitized-hint">
                  Identifier: <code>{cleanName}</code>
                </div>
              )}
              {error && <div className="modal-field-error">{error}</div>}
            </div>

            {/* 2. Storage Engine (VFS) */}
            <div className="form-group">
              <div className="modal-label-row">
                <label className="modal-label">Storage Engine (VFS)</label>
              </div>
              <div className="vfs-cards-grid">
                {/* Memory Card */}
                <div
                  className={`vfs-card ${vfs === 'memory' ? 'selected' : ''}`}
                  onClick={() => setVfs('memory')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setVfs('memory')}
                >
                  <div className="vfs-card-header">
                    <div className="vfs-card-icon-title">
                      <Zap size={16} style={{ color: '#f59e0b' }} />
                      <span>Memory (RAM)</span>
                    </div>
                    <span className="vfs-card-badge ephemeral">Ephemeral</span>
                  </div>
                  <div className="vfs-card-desc">
                    Ultra-fast in-memory buffer pool. Perfect for scratchpad queries and automated tests. Resets upon closing page.
                  </div>
                  {vfs === 'memory' && (
                    <div className="card-check-badge">
                      <Check size={12} />
                    </div>
                  )}
                </div>

                {/* IndexedDB Card */}
                <div
                  className={`vfs-card ${vfs === 'idb' ? 'selected' : ''}`}
                  onClick={() => setVfs('idb')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setVfs('idb')}
                >
                  <div className="vfs-card-header">
                    <div className="vfs-card-icon-title">
                      <HardDrive size={16} style={{ color: '#10b981' }} />
                      <span>IndexedDB</span>
                    </div>
                    <span className="vfs-card-badge persistent">Persistent</span>
                  </div>
                  <div className="vfs-card-desc">
                    Persists 4KB slotted binary pages into browser local IndexedDB. Survives page refreshes and browser restarts.
                  </div>
                  {vfs === 'idb' && (
                    <div className="card-check-badge">
                      <Check size={12} />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 3. Initial Data Template */}
            <div className="form-group">
              <div className="modal-label-row">
                <label className="modal-label">Starter Template</label>
              </div>
              <div className="template-cards-grid">
                {TEMPLATES.map((t) => {
                  const isSelected = template === t.key;
                  return (
                    <div
                      key={t.key}
                      className={`template-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => setTemplate(t.key)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && setTemplate(t.key)}
                    >
                      <div className="template-card-header">
                        <div className="template-card-title-group">
                          <span style={{ color: isSelected ? 'var(--accent)' : 'var(--text-secondary)' }}>
                            {t.icon}
                          </span>
                          <span>{t.name}</span>
                        </div>
                        <span className={`template-card-badge ${t.isPopular ? 'popular' : ''}`}>
                          {t.tag}
                        </span>
                      </div>
                      <div className="template-card-desc">{t.description}</div>
                      {isSelected && (
                        <div className="card-check-badge">
                          <Check size={12} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="modal-footer">
            <button
              type="button"
              id="cancelModalBtn"
              className="btn btn-secondary"
              onClick={() => setIsNewDbModalOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              id="confirmCreateDbBtn"
              className="btn btn-primary"
              disabled={!isValidName}
              title={!isValidName ? 'Please enter a database name' : 'Create database'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Plus size={14} />
              <span>Create Database</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
