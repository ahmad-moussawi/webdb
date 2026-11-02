import React, { useState, useEffect, useRef } from 'react';
import { useStudio } from '../../context/StudioContext';
import { getRegisteredDbs } from '../../utils/storage';
import type { VfsType } from '../../types/studio';
import {
  X,
  Zap,
  HardDrive,
  Check,
  Upload,
  FileArchive,
} from 'lucide-react';

export const ImportDbModal: React.FC = () => {
  const {
    isImportDbModalOpen,
    setIsImportDbModalOpen,
    createDb,
    activeDbName,
  } = useStudio();
  const [dbName, setDbName] = useState<string>('');
  const [vfs, setVfs] = useState<VfsType>('memory');
  const [importedBytes, setImportedBytes] = useState<Uint8Array | null>(null);
  const [importedFileName, setImportedFileName] = useState<string>('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isImportDbModalOpen) {
      setDbName('');
      setError(null);
      setFileError(null);
      setImportedBytes(null);
      setImportedFileName('');
      setTouched(false);
      setVfs('memory');
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [isImportDbModalOpen]);

  useEffect(() => {
    if (!isImportDbModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsImportDbModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isImportDbModalOpen, setIsImportDbModalOpen]);

  if (!isImportDbModalOpen) return null;

  const existingDbSet = new Set([
    ...getRegisteredDbs('memory'),
    ...getRegisteredDbs('idb'),
    activeDbName,
  ]);

  const rawTrimmed = dbName.trim();
  const cleanName = rawTrimmed.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const isDuplicateName = cleanName.length > 0 && existingDbSet.has(cleanName);
  const isValidName = cleanName.length > 0 && !isDuplicateName;
  const canSubmit = isValidName && importedBytes !== null;

  const suggestUniqueDbName = (rawFileName: string): string => {
    const base =
      rawFileName
        .replace(/\.(webdb|db|bin|sqlite)$/i, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_') || 'imported_db';
    if (!existingDbSet.has(base)) return base;
    let suffix = 2;
    while (existingDbSet.has(`${base}_${suffix}`)) {
      suffix++;
    }
    return `${base}_${suffix}`;
  };

  const handleFileSelect = async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.byteLength < 4096 || bytes.byteLength % 4096 !== 0) {
        setImportedBytes(null);
        setImportedFileName('');
        setFileError(
          `Invalid file size (${bytes.byteLength} bytes): must be a multiple of 4,096 bytes.`,
        );
        return;
      }
      const hasValidMagic =
        bytes[0] === 0x57 && // 'W'
        bytes[1] === 0x45 && // 'E'
        bytes[2] === 0x42 && // 'B'
        bytes[3] === 0x44 && // 'D'
        bytes[4] === 0x42 && // 'B'
        bytes[5] === 0x00;   // '\0'
      if (!hasValidMagic) {
        setImportedBytes(null);
        setImportedFileName('');
        setFileError(
          'Invalid WebDB binary header: expected "WEBDB\\0" magic bytes at offset 0.',
        );
        return;
      }
      setImportedBytes(bytes);
      setImportedFileName(file.name);
      if (!dbName.trim()) {
        setDbName(suggestUniqueDbName(file.name));
        setError(null);
      }
    } catch (err: any) {
      setImportedBytes(null);
      setImportedFileName('');
      setFileError(err?.message || 'Could not read binary file');
    }
  };

  const handleNameChange = (val: string) => {
    setDbName(val);
    if (error) setError(null);
  };

  const handleConfirm = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setTouched(true);

    if (!importedBytes) {
      setFileError('Please select a valid .webdb binary file to import');
      return;
    }

    if (!rawTrimmed) {
      setError('Database name is required');
      inputRef.current?.focus();
      return;
    }

    if (!cleanName) {
      setError('Name must contain alphanumeric characters or underscores');
      inputRef.current?.focus();
      return;
    }

    if (isDuplicateName) {
      setError(
        `Database "${cleanName}" already exists. Importing requires a new database name.`,
      );
      inputRef.current?.focus();
      return;
    }

    setIsImportDbModalOpen(false);
    await createDb(cleanName, vfs, 'import_binary', importedBytes);
  };

  return (
    <div
      id="importDbModal"
      className="modal-backdrop"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setIsImportDbModalOpen(false);
        }
      }}
    >
      <div className="modal-card modal-card-wide" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <FileArchive size={18} className="modal-title-icon" />
            <div>
              <div className="modal-title-text">Import Binary Database (.webdb)</div>
              <div className="modal-subtitle-text">
                Creates a new database from an exported .webdb binary image (existing databases cannot be overwritten)
              </div>
            </div>
          </div>
          <button
            id="closeImportModalBtn"
            className="modal-close-btn"
            onClick={() => setIsImportDbModalOpen(false)}
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body Form */}
        <form onSubmit={handleConfirm}>
          <div className="modal-body">
            {/* 1. Binary File Picker */}
            <div className="form-group">
              <div className="modal-label-row">
                <label className="modal-label">Binary Database File (.webdb)</label>
                <span className="required-badge">Required</span>
              </div>
              <input
                ref={fileInputRef}
                id="importBinaryFileInput"
                type="file"
                accept=".webdb,.db,.bin,application/octet-stream"
                style={{ display: 'none' }}
                onChange={(e) => handleFileSelect(e.target.files?.[0])}
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
                style={{
                  border: `1.5px dashed ${importedBytes ? 'var(--emerald)' : 'var(--card-border)'}`,
                  borderRadius: 'var(--radius-lg, 8px)',
                  padding: '16px',
                  background: 'var(--bg-panel)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Upload
                    size={18}
                    style={{
                      color: importedBytes ? 'var(--emerald)' : 'var(--accent)',
                    }}
                  />
                  <div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)' }}>
                      {importedFileName || 'Click to choose a .webdb binary file'}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      {importedBytes
                        ? `${(importedBytes.byteLength / 1024).toFixed(1)} KB • ${importedBytes.byteLength / 4096} pages (WEBDB header verified)`
                        : 'Validates WEBDB header and 4KB page CRC32 checksums on import'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                >
                  {importedBytes ? 'Change File' : 'Browse...'}
                </button>
              </div>
              {fileError && <div className="modal-field-error">{fileError}</div>}
            </div>

            {/* 2. New Database Name */}
            <div className="form-group">
              <div className="modal-label-row">
                <label htmlFor="importDbNameInput" className="modal-label">
                  New Database Name
                </label>
                <span className="required-badge">Required (Must be new)</span>
              </div>
              <input
                ref={inputRef}
                id="importDbNameInput"
                type="text"
                className={`modal-input ${(touched && !isValidName) || isDuplicateName ? 'input-error' : ''}`}
                value={dbName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. imported_store, backup_2026"
                autoComplete="off"
                spellCheck={false}
              />
              {cleanName && cleanName !== rawTrimmed && (
                <div className="name-sanitized-hint">
                  Identifier: <code>{cleanName}</code>
                </div>
              )}
              {isDuplicateName && (
                <div className="modal-field-error">
                  Database &ldquo;{cleanName}&rdquo; already exists. Cannot import into or overwrite an existing database.
                </div>
              )}
              {!isDuplicateName && error && (
                <div className="modal-field-error">{error}</div>
              )}
            </div>

            {/* 3. Storage Engine (VFS) */}
            <div className="form-group">
              <div className="modal-label-row">
                <label className="modal-label">Target Storage Engine (VFS)</label>
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
                    Ultra-fast in-memory buffer pool. Perfect for inspecting snapshots. Resets upon closing page.
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
                    Persists imported 4KB slotted binary pages into browser IndexedDB. Survives page refreshes.
                  </div>
                  {vfs === 'idb' && (
                    <div className="card-check-badge">
                      <Check size={12} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="modal-footer">
            <button
              type="button"
              id="cancelImportModalBtn"
              className="btn btn-secondary"
              onClick={() => setIsImportDbModalOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              id="confirmImportDbBtn"
              className="btn btn-primary"
              disabled={!canSubmit}
              title={
                !importedBytes
                  ? 'Please choose a .webdb file to import'
                  : !isValidName
                    ? isDuplicateName
                      ? 'Database name already exists'
                      : 'Please enter a new database name'
                    : 'Import into new database'
              }
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Upload size={14} />
              <span>Import as New Database</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

