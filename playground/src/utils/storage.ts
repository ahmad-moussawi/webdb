import type { EditorTab, VfsType, ThemeMode, RowInspectorMode } from '../types/studio';

export function openStudioMetaDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.indexedDB) return resolve(null);
    try {
      const req = indexedDB.open('WebDBStudioDB', 1);
      req.onupgradeneeded = (e) => {
        const d = (e.target as IDBOpenDBRequest).result;
        if (!d.objectStoreNames.contains('state')) {
          d.createObjectStore('state');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export interface SavedTabsState {
  tabs: EditorTab[];
  activeTabId: string;
  tabCounter: number;
}

export async function saveTabsState(state: SavedTabsState): Promise<void> {
  try {
    try {
      localStorage.setItem('webdb_tabs_backup', JSON.stringify(state));
    } catch {}

    const idb = await openStudioMetaDB();
    if (idb) {
      const tx = idb.transaction('state', 'readwrite');
      tx.objectStore('state').put(state, 'editor_tabs');
    }
  } catch (err) {
    console.warn('Failed to persist tabs to IndexedDB:', err);
  }
}

export async function loadTabsState(): Promise<SavedTabsState | null> {
  try {
    const idb = await openStudioMetaDB();
    if (idb) {
      const result = await new Promise<SavedTabsState | null>((resolve) => {
        try {
          const tx = idb.transaction('state', 'readonly');
          const req = tx.objectStore('state').get('editor_tabs');
          req.onsuccess = () => resolve((req.result as SavedTabsState) || null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (result && Array.isArray(result.tabs) && result.tabs.length > 0) {
        return result;
      }
    }
  } catch {}

  try {
    const raw = localStorage.getItem('webdb_tabs_backup');
    if (raw) {
      const parsed = JSON.parse(raw) as SavedTabsState;
      if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        return parsed;
      }
    }
  } catch {}

  return null;
}

export function getRegisteredDbs(vfs: VfsType): string[] {
  try {
    const raw = localStorage.getItem(`webdb_dbs_${vfs}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  return vfs === 'memory' ? ['ecommerce_db'] : ['persistent_store'];
}

export function saveRegisteredDbs(vfs: VfsType, list: string[]): void {
  try {
    localStorage.setItem(`webdb_dbs_${vfs}`, JSON.stringify(list));
  } catch {}
}

export function addRegisteredDb(vfs: VfsType, dbName: string): void {
  const list = getRegisteredDbs(vfs);
  if (!list.includes(dbName)) {
    list.push(dbName);
    saveRegisteredDbs(vfs, list);
  }
}

export function getStoredThemePreference(): ThemeMode {
  try {
    const pref = localStorage.getItem('webdb_theme_preference');
    if (pref === 'dark' || pref === 'light' || pref === 'auto') return pref;
  } catch {}
  return 'light';
}

export function setStoredThemePreference(pref: ThemeMode): void {
  try {
    localStorage.setItem('webdb_theme_preference', pref);
  } catch {}
}

export function getStoredRowInspectorMode(): RowInspectorMode {
  try {
    const mode = localStorage.getItem('webdb_row_inspector_mode');
    if (mode === 'json' || mode === 'fields') return mode;
  } catch {}
  return 'fields';
}

export function setStoredRowInspectorMode(mode: RowInspectorMode): void {
  try {
    localStorage.setItem('webdb_row_inspector_mode', mode);
  } catch {}
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  let copied = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {}
  }
  if (!copied) {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      textArea.style.pointerEvents = 'none';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      copied = document.execCommand('copy');
      document.body.removeChild(textArea);
    } catch {}
  }
  return copied;
}
