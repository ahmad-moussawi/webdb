import React, { useState } from 'react';
import { useStudio } from '../../context/StudioContext';
import { Eraser, Play, PanelLeft, PanelBottom, PanelRight, Download } from 'lucide-react';
import { exportDatabaseToSql, downloadSqlFile } from '../../utils/sqlExporter';

export const TopBar: React.FC = () => {
  const {
    db,
    activeDbName,
    showToast,
    clearActiveTabCode,
    executeCode,
    loadSnippet,
    isExplorerOpen,
    isDetailsOpen,
    isResultsOpen,
    toggleExplorer,
    toggleDetails,
    toggleResults,
  } = useStudio();

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

  const handleSnippetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const key = e.target.value;
    if (!key) return;
    const opt = e.target.options[e.target.selectedIndex];
    const label = opt ? opt.text : 'Query';
    loadSnippet(key, label);
    e.target.value = '';
  };

  return (
    <header>
      <div className="brand">
        <svg
          className="brand-logo"
          viewBox="0 0 100 100"
          width="24"
          height="24"
        >
          <defs>
            <linearGradient id="brandGrad" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
              <stop stopColor="#3B82F6" />
              <stop offset="1" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="20" fill="url(#brandGrad)" />
          <path d="M25 35L50 20L75 35L50 50L25 35Z" fill="#ffffff" fillOpacity="0.9" />
          <path d="M25 50L50 65L75 50" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M25 65L50 80L75 65" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="brand-title">WebDB Studio</span>
        <span className="brand-badge">IDE</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <select
          id="querySnippetSelect"
          className="header-snippet-select"
          title="Insert Code Snippet"
          defaultValue=""
          onChange={handleSnippetChange}
        >
          <option value="" disabled>-- CODE SNIPPETS --</option>
          <option value="topRated">Top Rated Products (Filter & Sort)</option>
          <option value="udfRegex">Regex Search UDF (Sony, Apple, Logitech)</option>
          <option value="udfDate">Date Operations UDF (Orders in Last 30 Days)</option>
          <option value="udfMargin">Profit Margin Calculator UDF (&gt;= 55%)</option>
          <option value="lowStock">Inventory Alert (Stock &lt; 15)</option>
          <option value="deliveredOrders">Delivered High-Value Orders (&gt; $200)</option>
          <option value="vipCustomers">VIP Customers (Spent &gt; $1,000)</option>
          <option value="explainBytecode">Inspect VDBE Bytecode & Plan</option>
        </select>

        <div className="topbar-divider" />

        {/* Panel Layout Toggles */}
        <div className="topbar-layout-toggles">
          <button
            type="button"
            className={`topbar-toggle-btn ${isExplorerOpen ? 'active' : ''}`}
            title={isExplorerOpen ? 'Hide Explorer' : 'Show Explorer'}
            onClick={toggleExplorer}
          >
            <PanelLeft size={15} />
          </button>
          <button
            type="button"
            className={`topbar-toggle-btn ${isResultsOpen ? 'active' : ''}`}
            title={isResultsOpen ? 'Hide Bottom Panel' : 'Show Bottom Panel'}
            onClick={toggleResults}
          >
            <PanelBottom size={15} />
          </button>
          <button
            type="button"
            className={`topbar-toggle-btn ${isDetailsOpen ? 'active' : ''}`}
            title={isDetailsOpen ? 'Hide Row Details' : 'Show Row Details'}
            onClick={toggleDetails}
          >
            <PanelRight size={15} />
          </button>
        </div>

        <div className="topbar-divider" />

        <button
          id="exportSqlBtn"
          className="btn btn-secondary"
          title="Export database as SQLite-compatible .sql file"
          onClick={handleExportSql}
          disabled={isExporting}
        >
          <Download size={13} style={{ strokeWidth: 2.2 }} />
          <span>{isExporting ? 'Exporting...' : 'Export SQL'}</span>
        </button>

        <button
          id="clearBtn"
          className="btn btn-secondary"
          title="Clear editor contents"
          onClick={clearActiveTabCode}
        >
          <Eraser size={13} style={{ strokeWidth: 2.2 }} />
          <span>Clear</span>
        </button>

        <button
          id="runBtn"
          className="btn btn-primary"
          title="Execute Query (Cmd+Enter)"
          onClick={executeCode}
        >
          <Play size={13} fill="currentColor" />
          <span>Run</span>
          <span style={{ fontSize: '0.65rem', opacity: 0.7, marginLeft: '2px', fontWeight: 400 }}>
            Cmd+Enter
          </span>
        </button>
      </div>
    </header>
  );
};
