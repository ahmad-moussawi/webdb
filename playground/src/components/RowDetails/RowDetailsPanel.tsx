import React, { useMemo } from 'react';
import { useStudio } from '../../context/StudioContext';
import { getColumnMetaType } from '../../constants/snippets';
import { copyTextToClipboard } from '../../utils/storage';
import { Copy, Braces, PanelRightClose } from 'lucide-react';

export const RowDetailsPanel: React.FC = () => {
  const {
    selectedRow,
    selectedRowIndex,
    rowInspectorMode,
    setRowInspectorMode,
    tables,
    showToast,
    isDetailsOpen,
    detailsWidth,
    toggleDetails,
  } = useStudio();

  const jsonStr = useMemo(() => {
    if (!selectedRow) return '';
    try {
      return JSON.stringify(selectedRow, null, 2);
    } catch {
      return String(selectedRow);
    }
  }, [selectedRow]);

  const byteCount = useMemo(() => {
    if (!jsonStr) return 0;
    return new Blob([jsonStr]).size;
  }, [jsonStr]);

  const handleCopyJson = async () => {
    if (!selectedRow) {
      showToast('Please select a row first');
      return;
    }
    await copyTextToClipboard(jsonStr);
    showToast('Row JSON copied to clipboard');
  };

  const toggleInspectorMode = () => {
    setRowInspectorMode(rowInspectorMode === 'json' ? 'fields' : 'json');
  };

  const entries = useMemo(() => {
    if (!selectedRow || typeof selectedRow !== 'object') return [];
    return Object.entries(selectedRow);
  }, [selectedRow]);

  if (!isDetailsOpen) return null;

  return (
    <div
      className="ide-panel panel-details"
      style={{
        width: `${detailsWidth}px`,
        flexBasis: `${detailsWidth}px`,
        position: 'relative',
      }}
    >
      {/* Floating Buttons on Top Right */}
      <div
        style={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        {rowInspectorMode === 'json' && selectedRow && (
          <button
            id="copyJsonBtn"
            className="panel-icon-btn"
            title="Copy JSON"
            onClick={handleCopyJson}
          >
            <Copy size={12} />
          </button>
        )}
        <button
          className="panel-icon-btn"
          title="Close Row Details"
          onClick={toggleDetails}
        >
          <PanelRightClose size={12} />
        </button>
      </div>

      <div id="detailsContent" className="details-content">
        {!selectedRow ? (
          <div className="details-empty-state">
            Select any row from the query results table to inspect its fields, types, and raw JSON.
          </div>
        ) : typeof selectedRow !== 'object' ? (
          <div>
            <div className="details-sub-header">
              <span>ROW #{selectedRowIndex + 1}</span>
            </div>
            <div style={{ padding: '10px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
              {String(selectedRow)}
            </div>
          </div>
        ) : rowInspectorMode === 'json' ? (
          <div>
            <div className="details-sub-header">
              <span>ROW #{selectedRowIndex + 1} &bull; RAW JSON</span>
              <span className="badge-count">{byteCount} bytes</span>
            </div>
            <pre className="row-json-view">{jsonStr}</pre>
          </div>
        ) : (
          <div>
            <div className="details-sub-header">
              <span>ROW #{selectedRowIndex + 1} ATTRIBUTES</span>
              <span className="badge-count">{entries.length} Fields</span>
            </div>
            <table className="fields-table">
              <tbody>
                {entries.map(([key, val]) => {
                  const typeMeta = getColumnMetaType(key, val, tables);
                  const isNum = typeof val === 'number';

                  let valDisplay: React.ReactNode;
                  if (val === null || val === undefined) {
                    valDisplay = <span className="null-badge">NULL</span>;
                  } else if (isNum) {
                    valDisplay = (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--accent)',
                          fontWeight: 500,
                        }}
                        title={String(val)}
                      >
                        {val}
                      </span>
                    );
                  } else if (typeof val === 'boolean') {
                    valDisplay = (
                      <span
                        style={{
                          color: val ? 'var(--emerald)' : 'var(--rose)',
                          fontWeight: 600,
                        }}
                        title={String(val)}
                      >
                        {String(val)}
                      </span>
                    );
                  } else {
                    const strVal = String(val);
                    valDisplay = <span title={strVal}>{strVal}</span>;
                  }

                  return (
                    <tr key={key}>
                      <td className="field-key">
                        <div style={{ display: 'flex', alignSelf: 'center', minWidth: 0 }}>
                          <span className="col-type-tag" title={typeMeta.label}>
                            {typeMeta.short}
                          </span>
                          <span className="field-key-name" title={key}>
                            {key}
                          </span>
                        </div>
                      </td>
                      <td className="field-val">{valDisplay}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fixed Bottom Bar with JSON Icon Toggle */}
      <div className="panel-details-footer">
        <button
          id="rowJsonToggleBtn"
          className={`json-toggle-btn ${rowInspectorMode === 'json' ? 'active' : ''}`}
          title="Toggle JSON / Fields View"
          onClick={toggleInspectorMode}
        >
          <Braces size={14} />
          <span>JSON</span>
        </button>
        <span id="rowDetailsMeta" className="details-footer-meta">
          {selectedRow
            ? rowInspectorMode === 'json'
              ? `${byteCount} B`
              : `${entries.length} fields`
            : ''}
        </span>
      </div>
    </div>
  );
};
