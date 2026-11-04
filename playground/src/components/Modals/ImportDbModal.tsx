import React, { useState, useEffect, useRef } from 'react';
import { useStudio, type ImportModalSourceMode } from '../../context/StudioContext';
import { getRegisteredDbs, copyTextToClipboard } from '../../utils/storage';
import {
  loadWebDbFromFile,
  fetchRemoteWebDb,
  deriveDbNameFromSource,
  buildShareablePlaygroundUrl,
  type LoadedBinaryDb,
} from '../../utils/binaryLoader';
import type { VfsType } from '../../types/studio';
import {
  X,
  Zap,
  HardDrive,
  Check,
  Upload,
  FileArchive,
  Globe,
  Link2,
  Copy,
  RefreshCw,
} from 'lucide-react';

export const ImportDbModal: React.FC = () => {
  const {
    isImportDbModalOpen,
    importModalInitialMode,
    setIsImportDbModalOpen,
    createDb,
    activeDbName,
    coreMode,
    showToast,
  } = useStudio();

  const [sourceMode, setSourceMode] = useState<ImportModalSourceMode>('file');
  const [dbName, setDbName] = useState<string>('');
  const [nameManuallyEdited, setNameManuallyEdited] = useState<boolean>(false);
  const [vfs, setVfs] = useState<VfsType>('memory');

  // Local file state
  const [loadedFileDb, setLoadedFileDb] = useState<LoadedBinaryDb | null>(null);
  const [importedFileName, setImportedFileName] = useState<string>('');
  const [fileError, setFileError] = useState<string | null>(null);

  // Remote URL state
  const [remoteUrl, setRemoteUrl] = useState<string>('');
  const [loadedRemoteDb, setLoadedRemoteDb] = useState<LoadedBinaryDb | null>(null);
  const [isFetchingRemote, setIsFetchingRemote] = useState<boolean>(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [copiedShareLink, setCopiedShareLink] = useState<boolean>(false);

  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<boolean>(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const existingDbSet = new Set([
    ...getRegisteredDbs('memory'),
    ...getRegisteredDbs('idb'),
    activeDbName,
  ]);

  const suggestUniqueDbName = (rawSource: string): string => {
    const base = deriveDbNameFromSource(rawSource) || 'imported_db';
    if (!existingDbSet.has(base)) return base;
    let suffix = 2;
    while (existingDbSet.has(`${base}_${suffix}`)) {
      suffix++;
    }
    return `${base}_${suffix}`;
  };

  useEffect(() => {
    if (isImportDbModalOpen) {
      setSourceMode(importModalInitialMode || 'file');
      setDbName('');
      setNameManuallyEdited(false);
      setError(null);
      setFileError(null);
      setLoadedFileDb(null);
      setImportedFileName('');
      setRemoteUrl('');
      setLoadedRemoteDb(null);
      setIsFetchingRemote(false);
      setRemoteError(null);
      setCopiedShareLink(false);
      setTouched(false);
      setVfs('memory');
      const timer = setTimeout(() => {
        if (importModalInitialMode === 'url') {
          urlInputRef.current?.focus();
        } else {
          inputRef.current?.focus();
        }
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [isImportDbModalOpen, importModalInitialMode]);

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

  const rawTrimmed = dbName.trim();
  const cleanName = rawTrimmed.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const isDuplicateName = cleanName.length > 0 && existingDbSet.has(cleanName);
  const isValidName = cleanName.length > 0 && !isDuplicateName;

  const canSubmit =
    isValidName &&
    !isFetchingRemote &&
    (sourceMode === 'file' ? loadedFileDb !== null : remoteUrl.trim().length > 0);

  const handleFileSelect = async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    try {
      const loaded = await loadWebDbFromFile(file);
      setLoadedFileDb(loaded);
      setImportedFileName(file.name);
      if (!dbName.trim() || !nameManuallyEdited) {
        setDbName(suggestUniqueDbName(file.name));
        setError(null);
      }
    } catch (err: any) {
      setLoadedFileDb(null);
      setImportedFileName('');
      setFileError(err?.message || 'Could not read binary file');
    }
  };

  const handleRemoteUrlChange = (val: string) => {
    setRemoteUrl(val);
    setLoadedRemoteDb(null);
    if (remoteError) setRemoteError(null);
    if (copiedShareLink) setCopiedShareLink(false);

    if (val.trim() && (!dbName.trim() || !nameManuallyEdited)) {
      setDbName(suggestUniqueDbName(val));
      if (error) setError(null);
    }
  };

  const handleFetchAndVerifyRemote = async (): Promise<LoadedBinaryDb | null> => {
    const trimmed = remoteUrl.trim();
    if (!trimmed) {
      setRemoteError('Please enter a remote .webdb or .webdb.gz URL');
      return null;
    }
    setIsFetchingRemote(true);
    setRemoteError(null);
    try {
      const loaded = await fetchRemoteWebDb(trimmed);
      setLoadedRemoteDb(loaded);
      if (!dbName.trim() || !nameManuallyEdited) {
        setDbName(suggestUniqueDbName(trimmed));
        setError(null);
      }
      return loaded;
    } catch (err: any) {
      setLoadedRemoteDb(null);
      setRemoteError(err?.message || 'Failed to fetch remote database');
      return null;
    } finally {
      setIsFetchingRemote(false);
    }
  };

  const handleNameChange = (val: string) => {
    setDbName(val);
    setNameManuallyEdited(true);
    if (error) setError(null);
  };

  const shareableUrl = remoteUrl.trim()
    ? buildShareablePlaygroundUrl({
        remoteUrl: remoteUrl.trim(),
        core: coreMode,
        storage: vfs,
      })
    : '';

  const handleCopyShareLink = async () => {
    if (!shareableUrl) return;
    const ok = await copyTextToClipboard(shareableUrl);
    if (ok) {
      setCopiedShareLink(true);
      showToast('Copied direct Studio link to clipboard!');
      setTimeout(() => setCopiedShareLink(false), 2500);
    } else {
      showToast('Could not copy link to clipboard.');
    }
  };

  const handleConfirm = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setTouched(true);

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

    if (sourceMode === 'file') {
      if (!loadedFileDb) {
        setFileError('Please select a valid .webdb or .webdb.gz file to import');
        return;
      }
      setIsImportDbModalOpen(false);
      await createDb(cleanName, vfs, 'import_binary', loadedFileDb.bytes);
    } else {
      let remoteData = loadedRemoteDb;
      if (!remoteData) {
        remoteData = await handleFetchAndVerifyRemote();
        if (!remoteData) return;
      }
      setIsImportDbModalOpen(false);
      await createDb(
        cleanName,
        vfs,
        'import_binary',
        remoteData.bytes,
        remoteUrl.trim(),
      );
    }
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
              <div className="modal-title-text">
                Import or Open Remote Database (.webdb / .webdb.gz)
              </div>
              <div className="modal-subtitle-text">
                Load an uncompressed (.webdb) or gzip-compressed (.webdb.gz) binary image from disk or remote URL
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
            {/* Source Mode Tabs (Local File vs Remote URL) */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '6px',
                background: 'var(--bg-panel)',
                padding: '4px',
                borderRadius: '6px',
                border: '1px solid var(--card-border)',
              }}
            >
              <button
                type="button"
                id="importSourceFileTab"
                onClick={() => setSourceMode('file')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '7px',
                  padding: '7px 12px',
                  borderRadius: '4px',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.76rem',
                  fontWeight: 600,
                  background: sourceMode === 'file' ? 'var(--accent)' : 'transparent',
                  color: sourceMode === 'file' ? '#ffffff' : 'var(--text-secondary)',
                  transition: 'all 0.15s ease',
                }}
              >
                <Upload size={14} />
                <span>Local File (.webdb / .webdb.gz)</span>
              </button>
              <button
                type="button"
                id="importSourceUrlTab"
                onClick={() => {
                  setSourceMode('url');
                  setTimeout(() => urlInputRef.current?.focus(), 30);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '7px',
                  padding: '7px 12px',
                  borderRadius: '4px',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.76rem',
                  fontWeight: 600,
                  background: sourceMode === 'url' ? 'var(--accent)' : 'transparent',
                  color: sourceMode === 'url' ? '#ffffff' : 'var(--text-secondary)',
                  transition: 'all 0.15s ease',
                }}
              >
                <Globe size={14} />
                <span>Remote URL (Hosted .webdb / .gz)</span>
              </button>
            </div>

            {/* 1A. Local Binary / Gzip File Picker */}
            {sourceMode === 'file' ? (
              <div className="form-group">
                <div className="modal-label-row">
                  <label className="modal-label">
                    Binary Database File (.webdb or .webdb.gz)
                  </label>
                  <span className="required-badge">Required</span>
                </div>
                <input
                  ref={fileInputRef}
                  id="importBinaryFileInput"
                  type="file"
                  accept=".webdb,.gz,.db,.bin,application/octet-stream,application/gzip,application/x-gzip"
                  style={{ display: 'none' }}
                  onChange={(e) => handleFileSelect(e.target.files?.[0])}
                />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
                  style={{
                    border: `1.5px dashed ${loadedFileDb ? 'var(--emerald)' : 'var(--card-border)'}`,
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
                        color: loadedFileDb ? 'var(--emerald)' : 'var(--accent)',
                      }}
                    />
                    <div>
                      <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)' }}>
                        {importedFileName || 'Click to choose a .webdb or .webdb.gz file'}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                        {loadedFileDb
                          ? `${(loadedFileDb.bytes.byteLength / 1024).toFixed(1)} KB • ${loadedFileDb.pageCount} pages${
                              loadedFileDb.wasCompressed
                                ? ` (decompressed from ${(loadedFileDb.compressedByteLength / 1024).toFixed(1)} KB .gz)`
                                : ''
                            } • WEBDB header verified`
                          : 'Supports raw .webdb and gzip-compressed .webdb.gz images'}
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
                    {loadedFileDb ? 'Change File' : 'Browse...'}
                  </button>
                </div>
                {fileError && <div className="modal-field-error">{fileError}</div>}
              </div>
            ) : (
              /* 1B. Remote Database URL Input */
              <div className="form-group">
                <div className="modal-label-row">
                  <label htmlFor="remoteDbUrlInput" className="modal-label">
                    Remote Database URL (.webdb or .webdb.gz)
                  </label>
                  <span className="required-badge">Required (CORS enabled)</span>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    ref={urlInputRef}
                    id="remoteDbUrlInput"
                    type="url"
                    className={`modal-input ${remoteError ? 'input-error' : ''}`}
                    style={{ flex: 1 }}
                    value={remoteUrl}
                    onChange={(e) => handleRemoteUrlChange(e.target.value)}
                    placeholder="https://example.com/files/db.webdb.gz"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    id="verifyRemoteUrlBtn"
                    className="btn btn-secondary"
                    disabled={!remoteUrl.trim() || isFetchingRemote}
                    onClick={() => void handleFetchAndVerifyRemote()}
                    style={{ height: '36px', padding: '0 12px', flexShrink: 0 }}
                  >
                    <RefreshCw
                      size={13}
                      style={{
                        animation: isFetchingRemote ? 'spin 1s linear infinite' : 'none',
                      }}
                    />
                    <span>{isFetchingRemote ? 'Fetching...' : 'Verify URL'}</span>
                  </button>
                </div>

                {loadedRemoteDb && (
                  <div
                    style={{
                      fontSize: '0.73rem',
                      color: 'var(--emerald)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      marginTop: '4px',
                      fontWeight: 500,
                    }}
                  >
                    <Check size={13} />
                    <span>
                      Verified: {(loadedRemoteDb.bytes.byteLength / 1024).toFixed(1)} KB (
                      {loadedRemoteDb.pageCount} pages
                      {loadedRemoteDb.wasCompressed
                        ? `, decompressed from ${(loadedRemoteDb.compressedByteLength / 1024).toFixed(1)} KB .gz`
                        : ''}
                      )
                    </span>
                  </div>
                )}

                {remoteError && <div className="modal-field-error">{remoteError}</div>}

                {/* Direct Shareable External Link Generator */}
                {shareableUrl && (
                  <div
                    style={{
                      marginTop: '8px',
                      padding: '10px 12px',
                      background: 'var(--bg-panel)',
                      border: '1px solid var(--card-border)',
                      borderRadius: '6px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                      >
                        <Link2 size={12} style={{ color: 'var(--accent)' }} />
                        <span>Direct External Playground Link</span>
                      </span>
                      <button
                        type="button"
                        id="copyShareableUrlBtn"
                        className="btn btn-secondary btn-sm"
                        onClick={handleCopyShareLink}
                        style={{ height: '22px', padding: '0 8px', fontSize: '0.68rem' }}
                      >
                        {copiedShareLink ? <Check size={11} /> : <Copy size={11} />}
                        <span>{copiedShareLink ? 'Copied!' : 'Copy Link'}</span>
                      </button>
                    </div>
                    <code
                      id="shareableUrlPreview"
                      style={{
                        fontSize: '0.69rem',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text)',
                        wordBreak: 'break-all',
                        lineHeight: 1.4,
                      }}
                    >
                      {shareableUrl}
                    </code>
                  </div>
                )}
              </div>
            )}

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
                sourceMode === 'file' && !loadedFileDb
                  ? 'Please choose a .webdb or .webdb.gz file to import'
                  : sourceMode === 'url' && !remoteUrl.trim()
                    ? 'Please enter a remote .webdb or .webdb.gz URL'
                    : !isValidName
                      ? isDuplicateName
                        ? 'Database name already exists'
                        : 'Please enter a new database name'
                      : sourceMode === 'url'
                        ? 'Fetch and open remote database'
                        : 'Import into new database'
              }
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {sourceMode === 'url' ? <Globe size={14} /> : <Upload size={14} />}
              <span>
                {isFetchingRemote
                  ? 'Loading Remote DB...'
                  : sourceMode === 'url'
                    ? 'Open Remote Database'
                    : 'Import as New Database'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
