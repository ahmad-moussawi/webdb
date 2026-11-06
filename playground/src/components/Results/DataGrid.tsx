import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataType } from '@ahmadmoussawi/webdb';
import { useStudio } from '../../context/StudioContext';
import { editKey } from '../../hooks/useResultEditing';
import {
  cellValueToText,
  getCellEditability,
  parseCellInput,
} from '../../utils/resultEditing';

interface ActiveCell {
  row: number;
  col: number;
}

export const DataGrid: React.FC = () => {
  const {
    resultRows,
    resultColumns,
    selectedRowIndex,
    selectRow,
    executionError,
    resultEditability,
    pendingEdits,
    pendingEditCount,
    isApplyingEdits,
    stageEdit,
    applyEdits,
    discardEdits,
    showToast,
  } = useStudio();

  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ActiveCell | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const editingRef = useRef(false);
  const wasEditingRef = useRef(false);

  // Identify numeric columns for right alignment
  const numCols = useMemo(() => {
    const set = new Set<string>();
    for (const col of resultColumns) {
      for (const r of resultRows) {
        if (r && typeof r[col] === 'number') {
          set.add(col);
          break;
        }
      }
    }
    return set;
  }, [resultColumns, resultRows]);

  const rowCount = resultRows.length;
  const colCount = resultColumns.length;

  // New result -> reset the active cell
  useEffect(() => {
    setActive(null);
    setEditing(false);
    editingRef.current = false;
  }, [resultRows.length, resultColumns]);

  // Return keyboard focus to the grid when an edit finishes
  useEffect(() => {
    if (wasEditingRef.current && !editing) {
      containerRef.current?.focus({ preventScroll: true });
    }
    wasEditingRef.current = editing;
  }, [editing]);

  // Keep the active cell visible while navigating
  useEffect(() => {
    if (!active) return;
    const el = containerRef.current?.querySelector('td.cell-active') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const displayValue = useCallback(
    (row: number, col: string) => {
      const pending = pendingEdits[editKey(row, col)];
      if (pending) return pending.value;
      const r = resultRows[row];
      return r && typeof r === 'object' ? r[col] : r;
    },
    [pendingEdits, resultRows],
  );

  const cellInfo = useCallback(
    (row: number, colIdx: number) =>
      getCellEditability(resultEditability, resultColumns[colIdx], resultRows[row]),
    [resultEditability, resultColumns, resultRows],
  );

  const startEdit = useCallback(
    (row: number, colIdx: number, seed?: string) => {
      setActive({ row, col: colIdx });
      const info = cellInfo(row, colIdx);
      if (!info.editable) {
        showToast(`Editing disabled: ${info.reason ?? 'this cell is read-only.'}`);
        return false;
      }
      const col = resultColumns[colIdx];
      editingRef.current = true;
      setDraft(seed !== undefined ? seed : cellValueToText(displayValue(row, col)));
      setEditing(true);
      return true;
    },
    [cellInfo, displayValue, resultColumns, showToast],
  );

  const cancelEdit = useCallback(() => {
    editingRef.current = false;
    setEditing(false);
  }, []);

  /** Stages the current draft. Returns false if it's invalid (a toast explains why). */
  const commitEdit = useCallback((): boolean => {
    if (!active || !editingRef.current) return true;
    const info = cellInfo(active.row, active.col);
    const col = resultColumns[active.col];
    if (!info.editable || !info.target) {
      cancelEdit();
      return true;
    }
    const nullable = !info.target.notNull && !info.target.isPrimaryKey;
    // Empty input means NULL for nullable non-text columns; TEXT keeps the empty string.
    const asNull = draft === '' && nullable && info.target.type !== DataType.TEXT;
    const parsed = parseCellInput(draft, info.target, asNull);
    if (!parsed.ok) {
      showToast(`Invalid value for "${info.target.column}": ${parsed.error}`);
      return false;
    }
    stageEdit(active.row, col, parsed.value);
    cancelEdit();
    return true;
  }, [active, cellInfo, resultColumns, draft, stageEdit, cancelEdit, showToast]);

  const moveTo = useCallback(
    (row: number, col: number) => {
      if (rowCount === 0 || colCount === 0) return;
      const r = Math.max(0, Math.min(rowCount - 1, row));
      const c = Math.max(0, Math.min(colCount - 1, col));
      setActive({ row: r, col: c });
      selectRow(r);
    },
    [rowCount, colCount, selectRow],
  );

  const tabTarget = useCallback(
    (from: ActiveCell, backwards: boolean): ActiveCell => {
      let { row, col } = from;
      if (backwards) {
        col -= 1;
        if (col < 0) {
          if (row > 0) {
            row -= 1;
            col = colCount - 1;
          } else {
            col = 0;
          }
        }
      } else {
        col += 1;
        if (col >= colCount) {
          if (row < rowCount - 1) {
            row += 1;
            col = 0;
          } else {
            col = colCount - 1;
          }
        }
      }
      return { row, col };
    },
    [colCount, rowCount],
  );

  const onContainerKeyDown = (e: React.KeyboardEvent) => {
    if (editing || rowCount === 0) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      if (pendingEditCount > 0) {
        e.preventDefault();
        void applyEdits();
      }
      return;
    }
    const cur = active ?? { row: 0, col: 0 };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveTo(active ? cur.row + 1 : 0, cur.col);
        return;
      case 'ArrowUp':
        e.preventDefault();
        moveTo(active ? cur.row - 1 : 0, cur.col);
        return;
      case 'ArrowRight':
        e.preventDefault();
        moveTo(cur.row, active ? cur.col + 1 : 0);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        moveTo(cur.row, active ? cur.col - 1 : 0);
        return;
      case 'Tab': {
        e.preventDefault();
        const t = tabTarget(cur, e.shiftKey);
        moveTo(t.row, t.col);
        return;
      }
      case 'Enter':
      case 'F2':
        if (active) {
          e.preventDefault();
          startEdit(active.row, active.col);
        }
        return;
      case 'Delete':
      case 'Backspace':
        if (active) {
          e.preventDefault();
          const info = cellInfo(active.row, active.col);
          if (!info.editable || !info.target) {
            showToast(`Editing disabled: ${info.reason ?? 'this cell is read-only.'}`);
          } else if (info.target.notNull || info.target.isPrimaryKey) {
            showToast(`"${info.target.column}" is NOT NULL and can't be cleared.`);
          } else {
            stageEdit(active.row, resultColumns[active.col], null);
          }
        }
        return;
      default:
        if (active && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          startEdit(active.row, active.col, e.key);
        }
    }
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (!active) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (commitEdit()) void applyEdits();
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        cancelEdit();
        return;
      case 'Enter':
        e.preventDefault();
        if (commitEdit()) moveTo(active.row + 1, active.col);
        return;
      case 'Tab': {
        e.preventDefault();
        if (commitEdit()) {
          const t = tabTarget(active, e.shiftKey);
          moveTo(t.row, t.col);
        }
        return;
      }
      case 'ArrowDown':
        e.preventDefault();
        if (commitEdit()) moveTo(active.row + 1, active.col);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (commitEdit()) moveTo(active.row - 1, active.col);
        return;
      default:
    }
  };

  if (executionError) {
    return (
      <div id="tableView" className="table-view" style={{ display: 'block' }}>
        <table id="resultsTable" className="results-table">
          <thead>
            <tr>
              <th>Execution Error</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td
                style={{
                  color: 'var(--rose)',
                  padding: '14px',
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.4,
                }}
              >
                {executionError.name}: {executionError.message}
                {executionError.stack ? `\n\n${executionError.stack}` : ''}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  if (resultRows.length === 0) {
    return (
      <div id="tableView" className="table-view" style={{ display: 'block' }}>
        <table id="resultsTable" className="results-table">
          <thead>
            <tr>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td
                style={{
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  padding: '24px',
                }}
              >
                Hit &quot;RUN&quot; or press ⌘↵ to execute query
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  const renderValue = (val: unknown) => {
    if (val === null || val === undefined) {
      return <span className="null-badge">NULL</span>;
    }
    if (typeof val === 'boolean') {
      return (
        <span style={{ color: val ? 'var(--emerald)' : 'var(--rose)', fontWeight: 600 }}>
          {String(val)}
        </span>
      );
    }
    return <>{String(val)}</>;
  };

  const hasErrors = Object.values(pendingEdits).some((p) => p.error);

  return (
    <div
      id="tableView"
      ref={containerRef}
      className="table-view grid-editable"
      style={{ display: 'block' }}
      tabIndex={0}
      onKeyDown={onContainerKeyDown}
    >
      {pendingEditCount > 0 && (
        <div className="edit-bar">
          <span>
            ✎ {pendingEditCount} pending edit{pendingEditCount === 1 ? '' : 's'}
            {hasErrors ? ' — fix the cells highlighted in red' : ''}
          </span>
          <span className="edit-bar-spacer" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={isApplyingEdits}
            onClick={() => void applyEdits()}
            title="Apply all edits in one transaction (⌘/Ctrl+S)"
          >
            {isApplyingEdits ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isApplyingEdits}
            onClick={discardEdits}
          >
            Discard
          </button>
        </div>
      )}
      <table
        id="resultsTable"
        className={`results-table${pendingEditCount > 0 ? ' has-edit-bar' : ''}`}
      >
        <thead id="resultsThead">
          <tr>
            <th style={{ width: '36px', textAlign: 'center' }}>#</th>
            {resultColumns.map((col) => (
              <th key={col} style={{ textAlign: numCols.has(col) ? 'right' : 'left' }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody id="resultsTbody">
          {resultRows.map((row, idx) => {
            const isSelected = idx === selectedRowIndex;

            return (
              <tr key={idx} className={isSelected ? 'selected' : ''} onClick={() => selectRow(idx)}>
                <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                  {idx + 1}
                </td>
                {resultColumns.map((col, cIdx) => {
                  const pending = pendingEdits[editKey(idx, col)];
                  const val = row && typeof row === 'object' ? displayValue(idx, col) : row;
                  const isActive = active?.row === idx && active.col === cIdx;
                  const isEditingCell = isActive && editing;
                  const isNumber = typeof val === 'number' || typeof val === 'bigint';

                  const classes: string[] = [];
                  if (isActive) classes.push('cell-active');
                  if (pending) classes.push(pending.error ? 'cell-error' : 'cell-dirty');
                  if (isEditingCell) classes.push('cell-editing');

                  const style: React.CSSProperties = isNumber
                    ? {
                        fontFamily: 'var(--font-mono)',
                        textAlign: 'right',
                        color: 'var(--accent)',
                        fontWeight: 500,
                      }
                    : {};

                  return (
                    <td
                      key={col}
                      className={classes.join(' ') || undefined}
                      style={style}
                      title={pending?.error ?? (typeof val === 'string' ? val : undefined)}
                      onClick={() => {
                        if (isEditingCell) return;
                        setActive({ row: idx, col: cIdx });
                        containerRef.current?.focus({ preventScroll: true });
                      }}
                      onDoubleClick={() => startEdit(idx, cIdx)}
                    >
                      {isEditingCell ? (
                        <input
                          className="cell-editor"
                          value={draft}
                          ref={(el) => {
                            if (el && document.activeElement !== el) {
                              el.focus();
                              el.setSelectionRange(el.value.length, el.value.length);
                            }
                          }}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={onEditorKeyDown}
                          onBlur={() => {
                            if (editingRef.current && !commitEdit()) cancelEdit();
                          }}
                          spellCheck={false}
                        />
                      ) : (
                        renderValue(val)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
