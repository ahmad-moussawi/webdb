import React from 'react';
import { useStudio } from '../../context/StudioContext';
import { ChevronDown, ChevronUp, PanelBottomClose, PanelBottomOpen } from 'lucide-react';

export const ResultsHeader: React.FC = () => {
  const {
    resultTab,
    setResultTab,
    resultRows,
    logs,
    selectedTableForStructure,
    timingMs,
    statusText,
    statusColor,
    isResultsOpen,
    toggleResults,
  } = useStudio();

  return (
    <div className="results-tabs-bar">
      <div className="tab-buttons">
        <button
          id="tabResultsBtn"
          className={`result-tab-btn ${resultTab === 'results' ? 'active' : ''}`}
          onClick={() => {
            if (!isResultsOpen) toggleResults();
            setResultTab('results');
          }}
        >
          RESULTS <span id="resCountBadge" className="badge-count">{resultRows.length}</span>
        </button>

        {selectedTableForStructure && (
          <button
            id="tabStructureBtn"
            className={`result-tab-btn ${resultTab === 'structure' ? 'active' : ''}`}
            onClick={() => {
              if (!isResultsOpen) toggleResults();
              setResultTab('structure');
            }}
          >
            STRUCTURE: <span id="structTableName">{selectedTableForStructure.name}</span>
          </button>
        )}

        <button
          id="tabPagesBtn"
          className={`result-tab-btn ${resultTab === 'pages' ? 'active' : ''}`}
          onClick={() => {
            if (!isResultsOpen) toggleResults();
            setResultTab('pages');
          }}
        >
          PAGES
        </button>

        <button
          id="tabPoolBtn"
          className={`result-tab-btn ${resultTab === 'pool' ? 'active' : ''}`}
          onClick={() => {
            if (!isResultsOpen) toggleResults();
            setResultTab('pool');
          }}
        >
          POOL
        </button>

        <button
          id="tabBytecodeBtn"
          className={`result-tab-btn ${resultTab === 'bytecode' ? 'active' : ''}`}
          onClick={() => {
            if (!isResultsOpen) toggleResults();
            setResultTab('bytecode');
          }}
        >
          VDBE BYTECODE
        </button>

        <button
          id="tabConsoleBtn"
          className={`result-tab-btn ${resultTab === 'console' ? 'active' : ''}`}
          onClick={() => {
            if (!isResultsOpen) toggleResults();
            setResultTab('console');
          }}
        >
          CONSOLE
          {logs.length > 0 && (
            <span id="logCountBadge" className="badge-count">
              {logs.length}
            </span>
          )}
        </button>
      </div>

      <div className="results-meta" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span id="timingBadge" className="meta-pill">{timingMs}</span>
        <span id="statusBadge" className="meta-pill" style={{ color: statusColor }}>
          {statusText}
        </span>
        <button
          className="panel-icon-btn"
          title={isResultsOpen ? 'Collapse Results Panel' : 'Expand Results Panel'}
          onClick={toggleResults}
          style={{ width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' }}
        >
          {isResultsOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>
    </div>
  );
};
