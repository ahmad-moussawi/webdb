import React from 'react';
import { useStudio } from '../../context/StudioContext';
import { Plus } from 'lucide-react';

export const EditorTabs: React.FC = () => {
  const { tabs, activeTabId, setActiveTabId, openNewTab, closeTab } = useStudio();

  return (
    <div className="editor-tabs-bar">
      <div className="editor-tabs-list" id="editorTabsList">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const canClose = tabs.length > 1;

          return (
            <div
              key={tab.id}
              className={`editor-tab-item ${isActive ? 'active' : ''}`}
              title={tab.title}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="editor-tab-lang">JS</span>
              <span className="editor-tab-title">{tab.title}</span>
              {canClose && (
                <button
                  type="button"
                  className="editor-tab-close"
                  title="Close Tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  &times;
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        id="newTabBtn"
        className="editor-tab-add-btn"
        title="Open New Query Tab"
        onClick={() => openNewTab()}
      >
        <Plus size={11} />
      </button>
    </div>
  );
};
