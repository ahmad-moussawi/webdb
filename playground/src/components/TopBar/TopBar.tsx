import React, { useState, useEffect, useRef } from 'react';
import { useStudio } from '../../context/StudioContext';
import {
  Eraser,
  Play,
  PanelLeft,
  PanelBottom,
  PanelRight,
  Download,
  Upload,
  Plus,
  FilePlus,
  X,
  Copy,
  Check,
  RefreshCw,
  Database,
  Sun,
  Moon,
  Monitor,
  BookOpen,
  ExternalLink,
  Cpu,
  Layers,
  Terminal,
  Table,
  Info,
  Globe,
} from 'lucide-react';

type MenuKey = 'file' | 'edit' | 'view' | 'database' | 'help' | null;

export const TopBar: React.FC = () => {
  const {
    db,
    coreMode,
    setCoreMode,
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
    openNewDbModal,
    openImportDbModal,
    openExportDbModal,
    openNewTab,
    closeTab,
    activeTabId,
    activeTab,
    tabs,
    refreshSchema,
    setResultTab,
    resultTab,
    themeMode,
    setThemeMode,
    setIsAboutModalOpen,
  } = useStudio();

  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuBarRef.current &&
        !menuBarRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  const closeMenuAndRun = (action: () => void | Promise<void>) => {
    setOpenMenu(null);
    void action();
  };

  const handleCopyQuery = async () => {
    const code = activeTab?.code || '';
    if (!code.trim()) {
      showToast('Active editor tab is empty.');
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      showToast('Copied query code to clipboard.');
    } catch {
      showToast('Could not copy to clipboard.');
    }
  };

  const handleCheckpoint = async () => {
    if (!db || typeof db.checkpoint !== 'function') return;
    try {
      const res = await db.checkpoint();
      showToast(
        `WAL checkpoint complete (${res?.pagesWritten ?? 0} dirty pages flushed).`,
      );
    } catch (err: any) {
      showToast(`Checkpoint failed: ${err?.message || 'Unknown error'}`);
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

  const toggleMenu = (key: Exclude<MenuKey, null>) => {
    setOpenMenu((prev) => (prev === key ? null : key));
  };

  const hoverMenu = (key: Exclude<MenuKey, null>) => {
    if (openMenu !== null && openMenu !== key) {
      setOpenMenu(key);
    }
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
            <linearGradient
              id="brandGrad"
              x1="0"
              y1="0"
              x2="100"
              y2="100"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#3B82F6" />
              <stop offset="1" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="20" fill="url(#brandGrad)" />
          <path
            d="M25 35L50 20L75 35L50 50L25 35Z"
            fill="#ffffff"
            fillOpacity="0.9"
          />
          <path
            d="M25 50L50 65L75 50"
            stroke="#ffffff"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M25 65L50 80L75 65"
            stroke="#ffffff"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        {/* Desktop Application Menu Bar */}
        <nav
          ref={menuBarRef}
          className="desktop-menubar"
          aria-label="Application Menu"
        >
          {/* FILE MENU */}
          <div
            className="menubar-item-wrapper"
            onMouseEnter={() => hoverMenu('file')}
          >
            <button
              type="button"
              id="menuFileBtn"
              className={`menubar-trigger ${openMenu === 'file' ? 'active' : ''}`}
              onClick={() => toggleMenu('file')}
            >
              File
            </button>
            {openMenu === 'file' && (
              <div className="menubar-dropdown" role="menu">
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => openNewDbModal('store_standard'))
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Plus size={14} />
                    </span>
                    <span>New Database...</span>
                  </span>
                </button>
                <button
                  type="button"
                  id="importBinaryMenuBtn"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => openImportDbModal('file'))
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Upload size={14} />
                    </span>
                    <span>Import Database (.webdb / .gz)...</span>
                  </span>
                </button>
                <button
                  type="button"
                  id="openRemoteDbMenuBtn"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => openImportDbModal('url'))
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Globe size={14} />
                    </span>
                    <span>Open Remote Database (URL)...</span>
                  </span>
                </button>

                <div className="menubar-divider" />

                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => openNewTab())}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <FilePlus size={14} />
                    </span>
                    <span>New Query Tab</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  disabled={tabs.length <= 1}
                  onClick={() => closeMenuAndRun(() => closeTab(activeTabId))}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <X size={14} />
                    </span>
                    <span>Close Active Tab</span>
                  </span>
                </button>

                <div className="menubar-divider" />

                <button
                  type="button"
                  id="openExportModalMenuBtn"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(openExportDbModal)}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Download size={14} />
                    </span>
                    <span>Export Database...</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* EDIT MENU */}
          <div
            className="menubar-item-wrapper"
            onMouseEnter={() => hoverMenu('edit')}
          >
            <button
              type="button"
              id="menuEditBtn"
              className={`menubar-trigger ${openMenu === 'edit' ? 'active' : ''}`}
              onClick={() => toggleMenu('edit')}
            >
              Edit
            </button>
            {openMenu === 'edit' && (
              <div className="menubar-dropdown" role="menu">
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => executeCode())}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Play size={14} />
                    </span>
                    <span>Execute Query</span>
                  </span>
                  <span className="menubar-shortcut">Cmd+Enter</span>
                </button>

                <div className="menubar-divider" />

                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(handleCopyQuery)}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Copy size={14} />
                    </span>
                    <span>Copy Active Query</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(clearActiveTabCode)}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Eraser size={14} />
                    </span>
                    <span>Clear Active Editor</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* VIEW MENU */}
          <div
            className="menubar-item-wrapper"
            onMouseEnter={() => hoverMenu('view')}
          >
            <button
              type="button"
              id="menuViewBtn"
              className={`menubar-trigger ${openMenu === 'view' ? 'active' : ''}`}
              onClick={() => toggleMenu('view')}
            >
              View
            </button>
            {openMenu === 'view' && (
              <div className="menubar-dropdown" role="menu">
                <div className="menubar-section-label">Workspace Panels</div>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(toggleExplorer)}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {isExplorerOpen ? (
                        <Check size={14} />
                      ) : (
                        <PanelLeft size={14} />
                      )}
                    </span>
                    <span>Explorer Sidebar</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(toggleResults)}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {isResultsOpen ? (
                        <Check size={14} />
                      ) : (
                        <PanelBottom size={14} />
                      )}
                    </span>
                    <span>Results &amp; Inspector Panel</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(toggleDetails)}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {isDetailsOpen ? (
                        <Check size={14} />
                      ) : (
                        <PanelRight size={14} />
                      )}
                    </span>
                    <span>Row Details Sidebar</span>
                  </span>
                </button>

                <div className="menubar-divider" />
                <div className="menubar-section-label">Bottom Inspector Tab</div>

                <button
                  type="button"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => setResultTab('results'))
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {resultTab === 'results' ? (
                        <Check size={14} />
                      ) : (
                        <Table size={14} />
                      )}
                    </span>
                    <span>Data Grid Results</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => setResultTab('bytecode'))
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {resultTab === 'bytecode' ? (
                        <Check size={14} />
                      ) : (
                        <Cpu size={14} />
                      )}
                    </span>
                    <span>VDBE Bytecode Disassembly</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => setResultTab('pages'))}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {resultTab === 'pages' ? (
                        <Check size={14} />
                      ) : (
                        <Layers size={14} />
                      )}
                    </span>
                    <span>4KB Slotted Page Inspector</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => setResultTab('pool'))}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {resultTab === 'pool' ? (
                        <Check size={14} />
                      ) : (
                        <Database size={14} />
                      )}
                    </span>
                    <span>Buffer Pool Slots</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => setResultTab('console'))
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {resultTab === 'console' ? (
                        <Check size={14} />
                      ) : (
                        <Terminal size={14} />
                      )}
                    </span>
                    <span>Console Output</span>
                  </span>
                </button>

                <div className="menubar-divider" />
                <div className="menubar-section-label">Appearance</div>

                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => setThemeMode('light'))}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {themeMode === 'light' ? (
                        <Check size={14} />
                      ) : (
                        <Sun size={14} />
                      )}
                    </span>
                    <span>Light Theme</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => setThemeMode('dark'))}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {themeMode === 'dark' ? (
                        <Check size={14} />
                      ) : (
                        <Moon size={14} />
                      )}
                    </span>
                    <span>Dark Theme</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => setThemeMode('auto'))}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {themeMode === 'auto' ? (
                        <Check size={14} />
                      ) : (
                        <Monitor size={14} />
                      )}
                    </span>
                    <span>System Default</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* DATABASE MENU */}
          <div
            className="menubar-item-wrapper"
            onMouseEnter={() => hoverMenu('database')}
          >
            <button
              type="button"
              id="menuDatabaseBtn"
              className={`menubar-trigger ${openMenu === 'database' ? 'active' : ''}`}
              onClick={() => toggleMenu('database')}
            >
              Database
            </button>
            {openMenu === 'database' && (
              <div className="menubar-dropdown" role="menu">
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(refreshSchema)}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <RefreshCw size={14} />
                    </span>
                    <span>Refresh Schema Catalog</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(handleCheckpoint)}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Database size={14} />
                    </span>
                    <span>Force WAL Checkpoint</span>
                  </span>
                </button>

                <div className="menubar-divider" />
                <div className="menubar-section-label">Core Execution Engine</div>

                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => setCoreMode('js'))}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {coreMode === 'js' ? <Check size={14} /> : null}
                    </span>
                    <span>JavaScript Core (Pure JS)</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() => closeMenuAndRun(() => setCoreMode('wasm'))}
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      {coreMode === 'wasm' ? <Check size={14} /> : null}
                    </span>
                    <span>WebAssembly Core (Compiled C)</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* HELP MENU */}
          <div
            className="menubar-item-wrapper"
            onMouseEnter={() => hoverMenu('help')}
          >
            <button
              type="button"
              id="menuHelpBtn"
              className={`menubar-trigger ${openMenu === 'help' ? 'active' : ''}`}
              onClick={() => toggleMenu('help')}
            >
              Help
            </button>
            {openMenu === 'help' && (
              <div className="menubar-dropdown" role="menu">
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => {
                      window.open('/webdb/getting-started.html', '_blank');
                    })
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <BookOpen size={14} />
                    </span>
                    <span>Getting Started Guide</span>
                  </span>
                  <span className="menubar-shortcut">
                    <ExternalLink size={12} />
                  </span>
                </button>
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => {
                      window.open('/webdb/offline-sync.html', '_blank');
                    })
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <BookOpen size={14} />
                    </span>
                    <span>Offline Sync &amp; Reactivity Guide</span>
                  </span>
                  <span className="menubar-shortcut">
                    <ExternalLink size={12} />
                  </span>
                </button>
                <div className="menubar-divider" />
                <button
                  type="button"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => {
                      window.open(
                        'https://github.com/ahmad-moussawi/webdb',
                        '_blank',
                      );
                    })
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <ExternalLink size={14} />
                    </span>
                    <span>GitHub Repository</span>
                  </span>
                </button>
                <div className="menubar-divider" />
                <button
                  type="button"
                  id="menuAboutBtn"
                  className="menubar-option"
                  onClick={() =>
                    closeMenuAndRun(() => {
                      setIsAboutModalOpen(true);
                    })
                  }
                >
                  <span className="menubar-option-left">
                    <span className="menubar-option-icon">
                      <Info size={14} />
                    </span>
                    <span>About WebDB Studio...</span>
                  </span>
                </button>
              </div>
            )}
          </div>
        </nav>

        <div
          className="topbar-core-toggle"
          title={`Core Engine: ${coreMode === 'wasm' ? 'Compiled C (WebAssembly)' : 'JavaScript (Pure JS)'}`}
        >
          <button
            type="button"
            className={`topbar-core-btn ${coreMode === 'js' ? 'active' : ''}`}
            onClick={() => setCoreMode('js')}
            title="Use Pure JavaScript Core Engine"
          >
            JS
          </button>
          <button
            type="button"
            className={`topbar-core-btn ${coreMode === 'wasm' ? 'active' : ''}`}
            onClick={() => setCoreMode('wasm')}
            title="Use Compiled C WebAssembly Core Engine"
          >
            WASM
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <select
          id="querySnippetSelect"
          className="header-snippet-select"
          title="Insert Code Snippet"
          defaultValue=""
          onChange={handleSnippetChange}
        >
          <option value="" disabled>
            -- CODE SNIPPETS --
          </option>
          <option value="topRated">Top Rated Products (Filter &amp; Sort)</option>
          <option value="udfRegex">
            Regex Search UDF (Sony, Apple, Logitech)
          </option>
          <option value="udfDate">
            Date Operations UDF (Orders in Last 30 Days)
          </option>
          <option value="udfMargin">
            Profit Margin Calculator UDF (&gt;= 55%)
          </option>
          <option value="lowStock">Inventory Alert (Stock &lt; 15)</option>
          <option value="deliveredOrders">
            Delivered High-Value Orders (&gt; $200)
          </option>
          <option value="vipCustomers">VIP Customers (Spent &gt; $1,000)</option>
          <option value="explainBytecode">Inspect VDBE Bytecode &amp; Plan</option>
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
          onClick={() => executeCode()}
        >
          <Play size={13} fill="currentColor" />
          <span>Run</span>
          <span
            style={{
              fontSize: '0.65rem',
              opacity: 0.7,
              marginLeft: '2px',
              fontWeight: 400,
            }}
          >
            Cmd+Enter
          </span>
        </button>
      </div>
    </header>
  );
};
