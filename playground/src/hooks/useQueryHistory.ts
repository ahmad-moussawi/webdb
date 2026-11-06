import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_HISTORY_LIMIT,
  clampLimit,
  clearHistory,
  countEvictable,
  deleteEntry,
  enforceLimit,
  getHistoryLimit,
  listHistory,
  recordRun,
  setHistoryLimit,
  setPinned,
  type HistoryEntry,
  type RunRecord,
} from '../utils/history';

/** Query history of the currently open database (persisted in WebDBStudioDB). */
export function useQueryHistory(dbKey: string, showToast: (msg: string) => void) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [limit, setLimit] = useState<number>(DEFAULT_HISTORY_LIMIT);

  const dbKeyRef = useRef(dbKey);
  dbKeyRef.current = dbKey;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const refresh = useCallback(async () => {
    const key = dbKeyRef.current;
    const list = await listHistory(key);
    if (dbKeyRef.current === key) setEntries(list);
  }, []);

  useEffect(() => {
    void getHistoryLimit().then(setLimit);
  }, []);

  useEffect(() => {
    setEntries([]);
    void refresh();
  }, [dbKey, refresh]);

  const record = useCallback(
    async (run: RunRecord) => {
      try {
        await recordRun(dbKeyRef.current, run, limitRef.current);
        await refresh();
      } catch (err) {
        console.warn('Failed to record query history:', err);
      }
    },
    [refresh],
  );

  const togglePin = useCallback(
    async (id: string, pinned: boolean) => {
      await setPinned(id, pinned);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteEntry(id);
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(
    async (includePinned: boolean) => {
      const n = await clearHistory(dbKeyRef.current, includePinned);
      await refresh();
      showToast(`Cleared ${n} history entr${n === 1 ? 'y' : 'ies'}`);
    },
    [refresh, showToast],
  );

  const changeLimit = useCallback(
    async (next: number) => {
      const value = clampLimit(next);
      const lost = await countEvictable(dbKeyRef.current, value);
      if (lost > 0 && !window.confirm(`Lowering the limit to ${value} removes the ${lost} least recently run entr${lost === 1 ? 'y' : 'ies'}. Continue?`)) {
        return;
      }
      const saved = await setHistoryLimit(value);
      setLimit(saved);
      limitRef.current = saved;
      if (lost > 0) await enforceLimit(dbKeyRef.current, saved);
      await refresh();
    },
    [refresh],
  );

  return { entries, limit, dbKey, record, togglePin, remove, clear, changeLimit };
}

export type QueryHistory = ReturnType<typeof useQueryHistory>;

