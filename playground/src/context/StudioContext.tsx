import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { WebDB } from '@webdb/core';
import type {
  EditorTab,
  TableMeta,
  ExplainOutput,
  ThemeMode,
  VfsType,
  ResultTabType,
  RowInspectorMode,
  SeedingProgress,
} from '../types/studio';
import {
  loadTabsState,
  saveTabsState,
  getRegisteredDbs,
  addRegisteredDb,
  getStoredThemePreference,
  setStoredThemePreference,
  getStoredRowInspectorMode,
  setStoredRowInspectorMode,
} from '../utils/storage';
import { seedDatabaseTemplate } from '../utils/seeder';
import { SNIPPETS } from '../constants/snippets';

interface StudioContextValue {
  db: any;
  activeDbName: string;
  activeStorage: VfsType;
  tables: TableMeta[];
  tabs: EditorTab[];
  activeTabId: string;
  activeTab: EditorTab | undefined;
  themeMode: ThemeMode;
  activeTheme: 'dark' | 'light';
  resultTab: ResultTabType;
  resultRows: any[];
  resultColumns: string[];
  selectedRowIndex: number;
  selectedRow: any;
  rowInspectorMode: RowInspectorMode;
  timingMs: string;
  statusText: string;
  statusColor: string;
  executionError: { name: string; message: string; stack?: string } | null;
  logs: string[];
  explainOutput: ExplainOutput | null;
  selectedTableForStructure: TableMeta | null;
  isNewDbModalOpen: boolean;
  seedingProgress: SeedingProgress;
  toastMessage: string | null;

  // Layout Panels
  isExplorerOpen: boolean;
  isDetailsOpen: boolean;
  isResultsOpen: boolean;
  explorerWidth: number;
  detailsWidth: number;
  editorHeightPct: number;
  toggleExplorer: () => void;
  toggleDetails: () => void;
  toggleResults: () => void;
  setExplorerWidth: (w: number) => void;
  setDetailsWidth: (w: number) => void;
  setEditorHeightPct: (pct: number) => void;

  // Actions
  openDb: (name: string, storage: VfsType) => Promise<void>;
  createDb: (name: string, storage: VfsType, templateKey: string) => Promise<void>;
  refreshSchema: () => Promise<void>;
  executeCode: () => Promise<void>;
  updateActiveCode: (code: string) => void;
  openNewTab: (initialCode?: string, title?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string) => void;
  selectRow: (idx: number) => void;
  setRowInspectorMode: (mode: RowInspectorMode) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setResultTab: (tab: ResultTabType) => void;
  viewTableStructure: (tableName: string) => void;
  queryTable: (tableName: string) => void;
  loadSnippet: (key: string, label: string) => void;
  clearActiveTabCode: () => void;
  setIsNewDbModalOpen: (open: boolean) => void;
  showToast: (msg: string) => void;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export const StudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [db, setDb] = useState<any>(null);
  const [activeDbName, setActiveDbName] = useState<string>(() => {
    try {
      return localStorage.getItem('webdb_active_db') || 'ecommerce_db';
    } catch {
      return 'ecommerce_db';
    }
  });
  const [activeStorage, setActiveStorage] = useState<VfsType>(() => {
    try {
      return (localStorage.getItem('webdb_active_storage') as VfsType) || 'memory';
    } catch {
      return 'memory';
    }
  });

  const [tables, setTables] = useState<TableMeta[]>([]);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');
  const tabCounterRef = useRef<number>(1);

  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getStoredThemePreference());
  const [activeTheme, setActiveTheme] = useState<'dark' | 'light'>('light');

  const [resultTab, setResultTab] = useState<ResultTabType>('results');
  const [resultRows, setResultRows] = useState<any[]>([]);
  const [resultColumns, setResultColumns] = useState<string[]>([]);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
  const [rowInspectorMode, setRowInspectorModeState] = useState<RowInspectorMode>(() => getStoredRowInspectorMode());

  const [timingMs, setTimingMs] = useState<string>('0.00 ms');
  const [statusText, setStatusText] = useState<string>('READY');
  const [statusColor, setStatusColor] = useState<string>('var(--emerald)');
  const [executionError, setExecutionError] = useState<{ name: string; message: string; stack?: string } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [explainOutput, setExplainOutput] = useState<ExplainOutput | null>(null);
  const [selectedTableForStructure, setSelectedTableForStructure] = useState<TableMeta | null>(null);

  const [isNewDbModalOpen, setIsNewDbModalOpen] = useState<boolean>(false);
  const [seedingProgress, setSeedingProgress] = useState<SeedingProgress>({
    visible: false,
    title: '',
    step: '',
    current: 0,
    total: 0,
  });
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<any>(null);

  // Layout Panels State with LocalStorage Persistence
  const [isExplorerOpen, setIsExplorerOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('webdb_layout_explorer_open');
      return v !== null ? v === 'true' : true;
    } catch {
      return true;
    }
  });

  const [isDetailsOpen, setIsDetailsOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('webdb_layout_details_open');
      return v !== null ? v === 'true' : true;
    } catch {
      return true;
    }
  });

  const [isResultsOpen, setIsResultsOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('webdb_layout_results_open');
      return v !== null ? v === 'true' : true;
    } catch {
      return true;
    }
  });

  const [explorerWidth, setExplorerWidthState] = useState<number>(() => {
    try {
      const v = localStorage.getItem('webdb_layout_explorer_width');
      return v ? parseInt(v, 10) : 230;
    } catch {
      return 230;
    }
  });

  const [detailsWidth, setDetailsWidthState] = useState<number>(() => {
    try {
      const v = localStorage.getItem('webdb_layout_details_width');
      return v ? parseInt(v, 10) : 280;
    } catch {
      return 280;
    }
  });

  const [editorHeightPct, setEditorHeightPctState] = useState<number>(() => {
    try {
      const v = localStorage.getItem('webdb_layout_editor_height_pct');
      return v ? parseFloat(v) : 48;
    } catch {
      return 48;
    }
  });

  const toggleExplorer = useCallback(() => {
    setIsExplorerOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem('webdb_layout_explorer_open', String(next)); } catch {}
      return next;
    });
  }, []);

  const toggleDetails = useCallback(() => {
    setIsDetailsOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem('webdb_layout_details_open', String(next)); } catch {}
      return next;
    });
  }, []);

  const toggleResults = useCallback(() => {
    setIsResultsOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem('webdb_layout_results_open', String(next)); } catch {}
      return next;
    });
  }, []);

  const setExplorerWidth = useCallback((w: number) => {
    const clamped = Math.max(160, Math.min(500, Math.round(w)));
    setExplorerWidthState(clamped);
    try { localStorage.setItem('webdb_layout_explorer_width', String(clamped)); } catch {}
  }, []);

  const setDetailsWidth = useCallback((w: number) => {
    const clamped = Math.max(200, Math.min(600, Math.round(w)));
    setDetailsWidthState(clamped);
    try { localStorage.setItem('webdb_layout_details_width', String(clamped)); } catch {}
  }, []);

  const setEditorHeightPct = useCallback((pct: number) => {
    const clamped = Math.max(15, Math.min(85, Math.round(pct)));
    setEditorHeightPctState(clamped);
    try { localStorage.setItem('webdb_layout_editor_height_pct', String(clamped)); } catch {}
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const selectedRow = selectedRowIndex >= 0 ? resultRows[selectedRowIndex] : null;

  // Resolve system theme and apply to html data-theme
  useEffect(() => {
    const updateTheme = () => {
      let resolved: 'dark' | 'light' = 'light';
      if (themeMode === 'auto') {
        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        resolved = isDark ? 'dark' : 'light';
      } else {
        resolved = themeMode;
      }
      setActiveTheme(resolved);
      document.documentElement.setAttribute('data-theme', resolved);
    };

    updateTheme();

    if (window.matchMedia) {
      const matcher = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => {
        if (themeMode === 'auto') updateTheme();
      };
      matcher.addEventListener('change', listener);
      return () => matcher.removeEventListener('change', listener);
    }
  }, [themeMode]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    setStoredThemePreference(mode);
  }, []);

  const setRowInspectorMode = useCallback((mode: RowInspectorMode) => {
    setRowInspectorModeState(mode);
    setStoredRowInspectorMode(mode);
  }, []);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2200);
  }, []);

  // Save tabs debounce
  const saveTimerRef = useRef<any>(null);
  const persistTabs = useCallback((currentTabs: EditorTab[], curActiveId: string, counter: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTabsState({
        tabs: currentTabs,
        activeTabId: curActiveId,
        tabCounter: counter,
      });
    }, 300);
  }, []);

  // Load Initial Tabs
  useEffect(() => {
    async function initTabs() {
      const saved = await loadTabsState();
      if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
        setTabs(saved.tabs);
        setActiveTabId(saved.activeTabId || saved.tabs[0].id);
        tabCounterRef.current = saved.tabCounter || saved.tabs.length;
      } else {
        const initialTabs: EditorTab[] = [
          {
            id: 'tab-1',
            title: 'Query 1',
            code: `// Welcome to WebDB Studio!\n// Query top 10 products with rating >= 4.5 sorted by rating\nreturn db.from("products")\n  .where("rating", ">=", 4.5)\n  .orderBy("rating", "desc")\n  .limit(10);`,
          },
        ];
        setTabs(initialTabs);
        setActiveTabId('tab-1');
        tabCounterRef.current = 1;
      }
    }
    initTabs();
  }, []);

  const updateActiveCode = useCallback((newCode: string) => {
    setTabs((prev) => {
      const updated = prev.map((t) => (t.id === activeTabId ? { ...t, code: newCode } : t));
      persistTabs(updated, activeTabId, tabCounterRef.current);
      return updated;
    });
  }, [activeTabId, persistTabs]);

  const openNewTab = useCallback((initialCode?: string, customTitle?: string) => {
    tabCounterRef.current++;
    const newId = `tab-${tabCounterRef.current}`;
    const title = customTitle || `Query ${tabCounterRef.current}`;
    const code = initialCode !== undefined
      ? initialCode
      : `// ${title}\nreturn db.from("products")\n  .limit(25);`;

    const newTabObj: EditorTab = { id: newId, title, code };
    setTabs((prev) => {
      const updated = [...prev, newTabObj];
      persistTabs(updated, newId, tabCounterRef.current);
      return updated;
    });
    setActiveTabId(newId);
  }, [persistTabs]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;

      const updated = prev.filter((t) => t.id !== tabId);
      let nextActive = activeTabId;
      if (activeTabId === tabId) {
        const nextTab = updated[Math.max(0, idx - 1)];
        nextActive = nextTab.id;
        setActiveTabId(nextActive);
      }
      persistTabs(updated, nextActive, tabCounterRef.current);
      return updated;
    });
  }, [activeTabId, persistTabs]);

  const clearActiveTabCode = useCallback(() => {
    updateActiveCode('');
  }, [updateActiveCode]);

  // Schema Refresh
  const refreshSchema = useCallback(async () => {
    if (!db) return;
    try {
      const meta = await db.listTables();
      setTables(meta);
    } catch (err: any) {
      console.error('Schema refresh error:', err);
    }
  }, [db]);

  // Open Database with fallback
  const openDb = useCallback(async (name: string, storage: VfsType) => {
    setStatusText('OPENING DB...');
    setStatusColor('#f59e0b');

    let currentInstance = db;
    if (currentInstance) {
      try {
        await currentInstance.close();
      } catch {}
    }

    try {
      const instance = await WebDB.open({ name, storage });
      (window as any).db = instance;
      setDb(instance);
      setActiveDbName(name);
      setActiveStorage(storage);

      try {
        localStorage.setItem('webdb_active_storage', storage);
        localStorage.setItem('webdb_active_db', name);
      } catch {}

      const meta = await instance.listTables();
      setTables(meta);
      setStatusText('READY');
      setStatusColor('var(--emerald)');

      // If standard ecommerce db is completely empty, seed standard template
      if (meta.length === 0 && name === 'ecommerce_db') {
        await seedDatabaseTemplate(instance, name, 'store_standard', (prog) => {
          setSeedingProgress(prog);
        });
        const reloaded = await instance.listTables();
        setTables(reloaded);
      }
    } catch (err) {
      console.warn(`Could not open DB ${name} on ${storage}, falling back to memory/ecommerce_db:`, err);
      showToast(`Fallback: Opened ecommerce_db on Memory`);
      setActiveStorage('memory');
      setActiveDbName('ecommerce_db');

      const fallbackInstance = await WebDB.open({ name: 'ecommerce_db', storage: 'memory' });
      (window as any).db = fallbackInstance;
      setDb(fallbackInstance);
      const meta = await fallbackInstance.listTables();
      setTables(meta);

      if (meta.length === 0) {
        await seedDatabaseTemplate(fallbackInstance, 'ecommerce_db', 'store_standard', (prog) => {
          setSeedingProgress(prog);
        });
        const reloaded = await fallbackInstance.listTables();
        setTables(reloaded);
      }
      setStatusText('READY');
      setStatusColor('var(--emerald)');
    }
  }, [db, showToast]);

  // Initialize DB on mount
  useEffect(() => {
    openDb(activeDbName, activeStorage);
  }, []);

  // Create Database
  const createDb = useCallback(async (name: string, storage: VfsType, templateKey: string) => {
    addRegisteredDb(storage, name);
    await openDb(name, storage);

    if (templateKey !== 'empty') {
      // openDb sets db asynchronously, so let's open explicitly
      const newInst = await WebDB.open({ name, storage });
      (window as any).db = newInst;
      setDb(newInst);
      await seedDatabaseTemplate(newInst, name, templateKey, (p) => {
        setSeedingProgress(p);
      });
      const meta = await newInst.listTables();
      setTables(meta);
    } else {
      showToast(`Created empty database: ${name}`);
    }
  }, [openDb, showToast]);

  // Execute User Code
  const executeCode = useCallback(async () => {
    if (!activeTab) return;
    let currentDb = db;
    if (!currentDb) {
      currentDb = await WebDB.open({ name: activeDbName, storage: activeStorage });
      setDb(currentDb);
      (window as any).db = currentDb;
    }

    const rawCode = activeTab.code;
    const t0 = performance.now();
    setStatusText('RUNNING...');
    setStatusColor('#3b82f6');
    setExecutionError(null);

    const captured: string[] = [];
    const customConsole = {
      log: (...args: any[]) => {
        const line = args
          .map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)))
          .join(' ');
        captured.push(line);
      },
      warn: (...args: any[]) => {
        captured.push('[WARN] ' + args.join(' '));
      },
      error: (...args: any[]) => {
        captured.push('[ERR] ' + args.join(' '));
      },
    };

    try {
      const trimmed = rawCode.trim();
      let codeToRun = rawCode;
      if (
        !trimmed.includes('return') &&
        !trimmed.startsWith('let ') &&
        !trimmed.startsWith('const ') &&
        !trimmed.startsWith('var ') &&
        !trimmed.startsWith('//')
      ) {
        codeToRun = `return (${rawCode});`;
      }

      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      let fn: any;
      try {
        fn = new AsyncFunction('db', 'WebDB', 'console', codeToRun);
      } catch {
        fn = new AsyncFunction('db', 'WebDB', 'console', rawCode);
      }

      let result = await fn(currentDb, WebDB, customConsole);

      if (result && typeof result.toArray === 'function') {
        try {
          const exp = await result.explain();
          setExplainOutput(exp);
        } catch (explainErr) {
          console.warn('Explain error:', explainErr);
        }
        result = await result.toArray();
      } else {
        setExplainOutput(null);
      }

      const totalMs = (performance.now() - t0).toFixed(2);
      setTimingMs(`${totalMs} ms`);
      setStatusText('SUCCESS');
      setStatusColor('var(--emerald)');
      setLogs(captured);

      if (Array.isArray(result)) {
        setResultRows(result);
        const colSet = new Set<string>();
        for (const r of result) {
          if (r && typeof r === 'object') {
            Object.keys(r).forEach((k) => colSet.add(k));
          }
        }
        const cols = Array.from(colSet);
        if (cols.length === 0) cols.push('value');
        setResultColumns(cols);
        setSelectedRowIndex(result.length > 0 ? 0 : -1);
      } else if (result !== undefined) {
        setResultRows([result]);
        setResultColumns(typeof result === 'object' && result !== null ? Object.keys(result) : ['value']);
        setSelectedRowIndex(0);
      } else {
        setResultRows([]);
        setResultColumns([]);
        setSelectedRowIndex(-1);
      }

      setResultTab('results');
      const meta = await currentDb.listTables();
      setTables(meta);
    } catch (err: any) {
      const totalMs = (performance.now() - t0).toFixed(2);
      setTimingMs(`${totalMs} ms`);
      setStatusText('ERROR');
      setStatusColor('var(--rose)');
      setExecutionError({
        name: err.name || 'Error',
        message: err.message || String(err),
        stack: err.stack,
      });
      captured.push(`[Execution Error] ${err.stack || err.message}`);
      setLogs(captured);
      setResultRows([]);
      setResultColumns([]);
      setSelectedRowIndex(-1);
    }
  }, [activeTab, db, activeDbName, activeStorage]);

  const selectRow = useCallback((idx: number) => {
    setSelectedRowIndex(idx);
  }, []);

  const viewTableStructure = useCallback((tableName: string) => {
    const tbl = tables.find((t) => t.name === tableName);
    if (tbl) {
      setSelectedTableForStructure(tbl);
      setResultTab('structure');
    }
  }, [tables]);

  const queryTable = useCallback((tableName: string) => {
    const queryCode = `// Query all rows from "${tableName}"\nreturn db.from("${tableName}")\n  .limit(25);`;

    let firstTab = tabs.find((t) => t.id === 'tab-1');
    if (!firstTab) {
      const newFirstTab: EditorTab = {
        id: 'tab-1',
        title: 'Query 1',
        code: queryCode,
      };
      setTabs((prev) => [newFirstTab, ...prev]);
      setActiveTabId('tab-1');
    } else {
      setTabs((prev) =>
        prev.map((t) => (t.id === 'tab-1' ? { ...t, code: queryCode } : t))
      );
      setActiveTabId('tab-1');
    }

    // Auto-execute query
    setTimeout(() => {
      executeCode();
    }, 50);
  }, [tabs, executeCode]);

  const loadSnippet = useCallback((key: string, label: string) => {
    const snippetCode = SNIPPETS[key];
    if (!snippetCode) return;

    const currentCode = activeTab?.code.trim() || '';
    const snippetName = label.split('(')[0].trim();

    if (currentCode === '') {
      updateActiveCode(snippetCode);
      setTimeout(() => executeCode(), 50);
    } else {
      openNewTab(snippetCode, snippetName);
      setTimeout(() => executeCode(), 50);
    }
  }, [activeTab, updateActiveCode, openNewTab, executeCode]);

  return (
    <StudioContext.Provider
      value={{
        db,
        activeDbName,
        activeStorage,
        tables,
        tabs,
        activeTabId,
        activeTab,
        themeMode,
        activeTheme,
        resultTab,
        resultRows,
        resultColumns,
        selectedRowIndex,
        selectedRow,
        rowInspectorMode,
        timingMs,
        statusText,
        statusColor,
        executionError,
        logs,
        explainOutput,
        selectedTableForStructure,
        isNewDbModalOpen,
        seedingProgress,
        toastMessage,

        isExplorerOpen,
        isDetailsOpen,
        isResultsOpen,
        explorerWidth,
        detailsWidth,
        editorHeightPct,
        toggleExplorer,
        toggleDetails,
        toggleResults,
        setExplorerWidth,
        setDetailsWidth,
        setEditorHeightPct,

        openDb,
        createDb,
        refreshSchema,
        executeCode,
        updateActiveCode,
        openNewTab,
        closeTab,
        setActiveTabId,
        selectRow,
        setRowInspectorMode,
        setThemeMode,
        setResultTab,
        viewTableStructure,
        queryTable,
        loadSnippet,
        clearActiveTabCode,
        setIsNewDbModalOpen,
        showToast,
      }}
    >
      {children}
    </StudioContext.Provider>
  );
};

export const useStudio = () => {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio must be used within a StudioProvider');
  return ctx;
};
