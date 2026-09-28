import React from 'react';
import { useStudio } from '../../context/StudioContext';
import { ResultsHeader } from './ResultsHeader';
import { DataGrid } from './DataGrid';
import { StructureView } from './StructureView';
import { BytecodeView } from './BytecodeView';
import { ConsoleView } from './ConsoleView';
import { PageInspector } from './PageInspector';

export const ResultsPanel: React.FC = () => {
  const { resultTab, isResultsOpen } = useStudio();

  return (
    <div
      className="results-container-wrapper"
      style={!isResultsOpen ? { height: '34px', flex: 'none', minHeight: '34px' } : undefined}
    >
      <ResultsHeader />
      {isResultsOpen && (
        <div className="tab-view-content">
          {resultTab === 'results' && <DataGrid />}
          {resultTab === 'structure' && <StructureView />}
          {resultTab === 'pages' && <PageInspector />}
          {resultTab === 'bytecode' && <BytecodeView />}
          {resultTab === 'console' && <ConsoleView />}
        </div>
      )}
    </div>
  );
};
