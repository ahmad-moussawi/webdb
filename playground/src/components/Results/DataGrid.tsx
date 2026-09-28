import React, { useMemo } from 'react';
import { useStudio } from '../../context/StudioContext';

export const DataGrid: React.FC = () => {
  const {
    resultRows,
    resultColumns,
    selectedRowIndex,
    selectRow,
    executionError,
  } = useStudio();

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

  return (
    <div id="tableView" className="table-view" style={{ display: 'block' }}>
      <table id="resultsTable" className="results-table">
        <thead id="resultsThead">
          <tr>
            <th style={{ width: '36px', textAlign: 'center' }}>#</th>
            {resultColumns.map((col) => (
              <th
                key={col}
                style={{ textAlign: numCols.has(col) ? 'right' : 'left' }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody id="resultsTbody">
          {resultRows.map((row, idx) => {
            const isSelected = idx === selectedRowIndex;

            return (
              <tr
                key={idx}
                className={isSelected ? 'selected' : ''}
                onClick={() => selectRow(idx)}
              >
                <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                  {idx + 1}
                </td>
                {resultColumns.map((col) => {
                  const val = row && typeof row === 'object' ? row[col] : row;

                  if (val === null || val === undefined) {
                    return (
                      <td key={col}>
                        <span className="null-badge">NULL</span>
                      </td>
                    );
                  }

                  if (typeof val === 'number') {
                    return (
                      <td
                        key={col}
                        style={{
                          fontFamily: 'var(--font-mono)',
                          textAlign: 'right',
                          color: 'var(--accent)',
                          fontWeight: 500,
                        }}
                      >
                        {val}
                      </td>
                    );
                  }

                  if (typeof val === 'boolean') {
                    return (
                      <td key={col}>
                        <span
                          style={{
                            color: val ? 'var(--emerald)' : 'var(--rose)',
                            fontWeight: 600,
                          }}
                        >
                          {String(val)}
                        </span>
                      </td>
                    );
                  }

                  return (
                    <td key={col} title={String(val)}>
                      {String(val)}
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
