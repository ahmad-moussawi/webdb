import React from 'react';
import { useStudio } from '../../context/StudioContext';

export const StructureView: React.FC = () => {
  const { selectedTableForStructure, queryTable, inspectPage } = useStudio();

  if (!selectedTableForStructure) {
    return (
      <div id="structureView" className="structure-view" style={{ display: 'block' }}>
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Click on the table icon next to any table in the Explorer to inspect its structure.
        </div>
      </div>
    );
  }

  const typeMap: Record<number, string> = {
    0: 'NULL',
    1: 'INT32',
    2: 'INT64',
    3: 'FLOAT64',
    4: 'TEXT',
    5: 'BLOB',
    6: 'UUID',
    7: 'ULID',
  };

  const columns = selectedTableForStructure.columns || [];

  return (
    <div id="structureView" className="structure-view" style={{ display: 'block' }}>
      <div className="structure-card">
        <div className="structure-header">
          <div>
            <strong id="structTitle">{selectedTableForStructure.name}</strong>
            <span
              id="structMeta"
              style={{
                color: 'var(--text-muted)',
                marginLeft: '8px',
                fontFamily: 'var(--font-mono)',
              }}
            >
              Root Page:{' '}
              <button
                className="link-btn-highlight"
                style={{ fontSize: 'inherit', padding: '1px 4px' }}
                onClick={() => inspectPage(selectedTableForStructure.rootPageId)}
                title="Inspect this table's root 4KB page in Page Inspector"
              >
                Page {selectedTableForStructure.rootPageId} &rarr;
              </button>
              {' '}• Col Catalog Page: {selectedTableForStructure.colCatalogPageId} • ~
              {selectedTableForStructure.rowCountEstimate.toLocaleString()} rows
            </span>
          </div>
          <button
            id="queryStructBtn"
            className="btn btn-sm"
            onClick={() => queryTable(selectedTableForStructure.name)}
          >
            QUERY ROWS
          </button>
        </div>

        <table className="results-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>#</th>
              <th>COLUMN</th>
              <th>DATA TYPE</th>
              <th>CONSTRAINTS</th>
            </tr>
          </thead>
          <tbody id="structTbody">
            {columns.map((col, idx) => {
              const typeStr =
                typeof col.type === 'number'
                  ? typeMap[col.type] || `TYPE_${col.type}`
                  : col.type;

              const flagsNum = typeof col.flags === 'number' ? col.flags : 0;
              const isPk = (flagsNum & 0x01) !== 0 || (typeof col.flags === 'object' && col.flags?.primaryKey);
              const isNotNull = (flagsNum & 0x02) !== 0 || (typeof col.flags === 'object' && col.flags?.notNull);
              const isAutoInc = (flagsNum & 0x08) !== 0 || (typeof col.flags === 'object' && col.flags?.autoInc);

              return (
                <tr key={col.name}>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{idx + 1}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{col.name}</td>
                  <td>
                    <span className="col-type-pill">{typeStr}</span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {isPk && <span className="col-pk-pill">PRIMARY KEY</span>}
                      {isNotNull && <span className="col-type-pill">NOT NULL</span>}
                      {isAutoInc && <span className="col-type-pill">AUTO_INC</span>}
                      {!isPk && !isNotNull && !isAutoInc && (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
