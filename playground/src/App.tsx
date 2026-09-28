import React, { useRef } from 'react';
import { StudioProvider, useStudio } from './context/StudioContext';
import { TopBar } from './components/TopBar/TopBar';
import { Explorer } from './components/Explorer/Explorer';
import { EditorArea } from './components/Editor/EditorArea';
import { ResultsPanel } from './components/Results/ResultsPanel';
import { RowDetailsPanel } from './components/RowDetails/RowDetailsPanel';
import { NewDbModal } from './components/Modals/NewDbModal';
import { ProgressOverlay } from './components/Modals/ProgressOverlay';
import { Toast } from './components/Toast/Toast';
import { VerticalSplitter, HorizontalSplitter } from './components/Common/Splitters';

export const AppContent: React.FC = () => {
  const {
    isExplorerOpen,
    isDetailsOpen,
    isResultsOpen,
    explorerWidth,
    detailsWidth,
    editorHeightPct,
    setExplorerWidth,
    setDetailsWidth,
    setEditorHeightPct,
  } = useStudio();

  const middlePanelRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <TopBar />
      <div className="ide-workspace">
        {isExplorerOpen && (
          <>
            <Explorer />
            <VerticalSplitter
              currentWidth={explorerWidth}
              onDrag={setExplorerWidth}
              direction="left"
            />
          </>
        )}

        <div className="panel-middle" ref={middlePanelRef}>
          <EditorArea />
          {isResultsOpen && (
            <HorizontalSplitter
              containerRef={middlePanelRef}
              currentPct={editorHeightPct}
              onDrag={setEditorHeightPct}
            />
          )}
          <ResultsPanel />
          <ProgressOverlay />
        </div>

        {isDetailsOpen && (
          <>
            <VerticalSplitter
              currentWidth={detailsWidth}
              onDrag={setDetailsWidth}
              direction="right"
            />
            <RowDetailsPanel />
          </>
        )}
      </div>
      <NewDbModal />
      <Toast />
    </>
  );
};

export const App: React.FC = () => {
  return (
    <StudioProvider>
      <AppContent />
    </StudioProvider>
  );
};

export default App;
