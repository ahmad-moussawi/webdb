import React from 'react';
import { useStudio } from '../../context/StudioContext';
import { EditorTabs } from './EditorTabs';
import { CodeEditor } from './CodeEditor';

export const EditorArea: React.FC = () => {
  const { isResultsOpen, editorHeightPct } = useStudio();

  return (
    <div
      className="editor-container-wrapper"
      style={
        isResultsOpen
          ? { height: `${editorHeightPct}%` }
          : { flex: 1, height: 'auto', minHeight: '180px', borderBottom: 'none' }
      }
    >
      <div className="editor-toolbar">
        <EditorTabs />
      </div>
      <div id="monacoEditor">
        <CodeEditor />
      </div>
    </div>
  );
};
