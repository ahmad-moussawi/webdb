import React, { useState, useEffect } from 'react';
import { useStudio } from '../../context/StudioContext';
import {
  exportDatabaseToSql,
  downloadSqlFile,
  downloadBinaryDbFile,
} from '../../utils/sqlExporter';
import { compressGzip } from '../../utils/binaryLoader';
import {
  X,
  Download,
  HardDriveDownload,
  FileArchive,
  FileCode,
  Check,
} from 'lucide-react';

export type ExportFormatType = 'webdb' | 'webdb_gz' | 'sql';

interface ExportOption {
  key: ExportFormatType;
  title: string;
  ext: string;
  badge: string;
  isRecommended?: boolean;
  icon: React.ReactNode;
  description: string;
}

const EXPORT_OPTIONS: ExportOption[] = [
  {
    key: 'webdb',
    title: 'WebDB Binary Image',
    ext: '.webdb',
    badge: '4KB Pages + CRC32',
    icon: <HardDriveDownload size={18} />,
    description:
      'Uncompressed 4KB slotted binary image with verified IEEE 802.3 CRC32 page checksums.',
  },
  {
    key: 'webdb_gz',
    title: 'Compressed Binary (Gzip)',
    ext: '.webdb.gz',
    badge: 'Smallest Size',
    isRecommended: true,
    icon: <FileArchive size={18} />,
    description:
      'Gzip-compressed .webdb binary image. Ideal for hosting online and sharing via remote Studio URLs.',
  },
  {
    key: 'sql',
    title: 'SQLite Compatible Dump',
    ext: '.sqlite.sql',
    badge: 'Plain Text SQL',
    icon: <FileCode size={18} />,
    description:
      'Standard SQL script with CREATE TABLE DDL and batched INSERT statements compatible with SQLite 3.',
  },
];

export const ExportDbModal: React.FC = () => {
  const {
    db,
    activeDbName,
    tables,
    isExportDbModalOpen,
    setIsExportDbModalOpen,
    showToast,
  } = useStudio();

  const [format, setFormat] = useState<ExportFormatType>('webdb_gz');
  const [fileNameBase, setFileNameBase] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);

  useEffect(() => {
    if (isExportDbModalOpen) {
      setFileNameBase(activeDbName || 'database');
      setIsExporting(false);
    }
  }, [isExportDbModalOpen, activeDbName]);

  useEffect(() => {
    if (!isExportDbModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExporting) {
        setIsExportDbModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExportDbModalOpen, isExporting, setIsExportDbModalOpen]);

  if (!isExportDbModalOpen) return null;

  const selectedOption =
    EXPORT_OPTIONS.find((o) => o.key === format) || EXPORT_OPTIONS[0];

  const cleanBase =
    fileNameBase
      .trim()
      .replace(/\.(webdb\.gz|sqlite\.sql|webdb|sql|gz)$/i, '')
      .trim() ||
    activeDbName ||
    'database';

  const fullFileName = `${cleanBase}${selectedOption.ext}`;

  const handleExport = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!db) {
      showToast('No active database to export.');
      return;
    }

    setIsExporting(true);
    try {
      if (format === 'webdb') {
        const bytes: Uint8Array = await db.exportBinary();
        downloadBinaryDbFile(fullFileName, bytes);
        const kb = (bytes.byteLength / 1024).toFixed(1);
        const pages = bytes.byteLength / 4096;
        showToast(`Exported ${fullFileName} (${kb} KB, ${pages} pages)`);
      } else if (format === 'webdb_gz') {
        const rawBytes: Uint8Array = await db.exportBinary();
        const gzBytes = await compressGzip(rawBytes);
        downloadBinaryDbFile(fullFileName, gzBytes);
        const rawKb = (rawBytes.byteLength / 1024).toFixed(1);
        const gzKb = (gzBytes.byteLength / 1024).toFixed(1);
        const pages = rawBytes.byteLength / 4096;
        showToast(
          `Exported ${fullFileName} (${gzKb} KB compressed from ${rawKb} KB, ${pages} pages)`,
        );
      } else {
        const { sql, tableCount, rowCount } = await exportDatabaseToSql(
          db,
          cleanBase,
        );
        downloadSqlFile(fullFileName, sql);
        showToast(
          `Exported ${tableCount} table(s) (${rowCount} rows) to ${fullFileName}`,
        );
      }
      setIsExportDbModalOpen(false);
    } catch (err: any) {
      showToast(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      id="exportDbModal"
      className="modal-backdrop"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isExporting) {
          setIsExportDbModalOpen(false);
        }
      }}
    >
      <div className="modal-card modal-card-wide" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <Download size={18} className="modal-title-icon" />
            <div>
              <div className="modal-title-text">Export Database</div>
              <div className="modal-subtitle-text">
                Export &ldquo;{activeDbName}&rdquo; ({tables.length}{' '}
                {tables.length === 1 ? 'table' : 'tables'}) to a local file
              </div>
            </div>
          </div>
          <button
            id="closeExportModalBtn"
            className="modal-close-btn"
            disabled={isExporting}
            onClick={() => setIsExportDbModalOpen(false)}
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body Form */}
        <form onSubmit={handleExport}>
          <div className="modal-body">
            {/* 1. Export Format Selection */}
            <div className="form-group">
              <div className="modal-label-row">
                <label className="modal-label">Select Export Format</label>
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                {EXPORT_OPTIONS.map((opt) => {
                  const isSelected = format === opt.key;
                  return (
                    <div
                      key={opt.key}
                      id={`exportFormatCard_${opt.key}`}
                      className={`template-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => setFormat(opt.key)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && setFormat(opt.key)}
                      style={{ padding: '12px 14px' }}
                    >
                      <div className="template-card-header">
                        <div className="template-card-title-group">
                          <span
                            style={{
                              color: isSelected
                                ? 'var(--accent)'
                                : 'var(--text-secondary)',
                              display: 'inline-flex',
                            }}
                          >
                            {opt.icon}
                          </span>
                          <span>{opt.title}</span>
                          <code
                            style={{
                              fontSize: '0.7rem',
                              color: 'var(--text-muted)',
                              fontFamily: 'var(--font-mono)',
                            }}
                          >
                            ({opt.ext})
                          </code>
                        </div>
                        <span
                          className={`template-card-badge ${
                            opt.isRecommended ? 'popular' : ''
                          }`}
                        >
                          {opt.badge}
                        </span>
                      </div>
                      <div className="template-card-desc">{opt.description}</div>
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

            {/* 2. File Name */}
            <div className="form-group">
              <div className="modal-label-row">
                <label htmlFor="exportFileNameInput" className="modal-label">
                  Output File Name
                </label>
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {fullFileName}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  id="exportFileNameInput"
                  type="text"
                  className="modal-input"
                  value={fileNameBase}
                  onChange={(e) => setFileNameBase(e.target.value)}
                  placeholder={activeDbName || 'database'}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span
                  style={{
                    padding: '0 10px',
                    height: '36px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--card-border)',
                    borderRadius: '4px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.76rem',
                    color: 'var(--text-secondary)',
                    flexShrink: 0,
                  }}
                >
                  {selectedOption.ext}
                </span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="modal-footer">
            <button
              type="button"
              id="cancelExportModalBtn"
              className="btn btn-secondary"
              disabled={isExporting}
              onClick={() => setIsExportDbModalOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              id="confirmExportDbBtn"
              className="btn btn-primary"
              disabled={isExporting}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Download size={14} />
              <span>
                {isExporting ? 'Exporting...' : `Download ${fullFileName}`}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

