import React, { useState } from 'react';
import { useStudio } from '../../context/StudioContext';
import { RotateCw, Table, PanelLeftClose, Layers, Download } from 'lucide-react';
import { exportDatabaseToSql, downloadSqlFile } from '../../utils/sqlExporter';

export const TableTree: React.FC = () => {
  const { db, activeDbName, showToast, tables, refreshSchema, queryTable, viewTableStructure, toggleExplorer, inspectPage } = useStudio();
  const [isExporting, setIsExporting] = useState<boolean>(false);

  const handleExportSql = async () => {
    if (!db) {
      showToast('No active database to export.');
      return;
    }
    setIsExporting(true);
    try {
      showToast('Generating SQLite dump...');
      const { sql, tableCount, rowCount } = await exportDatabaseToSql(db, activeDbName);
      downloadSqlFile(`${activeDbName}.sqlite.sql`, sql);
      showToast(`Exported ${tableCount} table(s) (${rowCount} rows) to ${activeDbName}.sqlite.sql`);
    } catch (err: any) {
      showToast(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <>
      <div className="tree-section-title">
        <span>TABLES</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span id="tableCountBadge" className="badge-count">
            {tables.length}
          </span>
          <button
            id="exportSqlTreeBtn"
            className="panel-icon-btn"
            title="Export to SQLite (.sql)"
            onClick={handleExportSql}
            disabled={isExporting}
          >
            <Download size={12} />
          </button>
          <button
            id="refreshSchemaBtn"
            className="panel-icon-btn"
            title="Refresh Tables"
            onClick={refreshSchema}
          >
            <RotateCw size={12} />
          </button>
          <button
            className="panel-icon-btn"
            title="Close Explorer"
            onClick={toggleExplorer}
          >
            <PanelLeftClose size={12} />
          </button>
        </div>
      </div>

      <div className="explorer-tree">
        <div id="tablesTreeContainer">
          {tables.length === 0 ? (
            <div
              style={{
                padding: '16px 10px',
                fontSize: '0.74rem',
                color: 'var(--text-muted)',
                textAlign: 'center',
              }}
            >
              No tables in this database.
              <br />
              Use <code>db.createTable(...)</code> or create from template.
            </div>
          ) : (
            tables.map((tbl) => (
              <div key={tbl.name} className="tree-table-item">
                <div
                  className="table-item-header"
                  id={`tbl-header-${tbl.name}`}
                  onClick={() => queryTable(tbl.name)}
                >
                  <div className="table-title-group">
                    <span
                      className="table-icon-btn"
                      title="View Table Structure"
                      onClick={(e) => {
                        e.stopPropagation();
                        viewTableStructure(tbl.name);
                      }}
                    >
                      <Table size={14} />
                    </span>
                    <span
                      className="table-icon-btn"
                      title={`Inspect Root Page (Page ${tbl.rootPageId})`}
                      onClick={(e) => {
                        e.stopPropagation();
                        inspectPage(tbl.rootPageId);
                      }}
                    >
                      <Layers size={13} />
                    </span>
                    <span
                      className="table-name-link"
                      title="Query Table Rows"
                      onClick={(e) => {
                        e.stopPropagation();
                        queryTable(tbl.name);
                      }}
                    >
                      {tbl.name}
                    </span>
                  </div>
                  <span className="tree-row-count">
                    {tbl.rowCountEstimate.toLocaleString()}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
};
