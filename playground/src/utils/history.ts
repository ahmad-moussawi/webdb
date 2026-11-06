import { openStudioMetaDB } from './storage';
import type { VfsType } from '../types/studio';

export const DEFAULT_HISTORY_LIMIT = 100;
export const MIN_HISTORY_LIMIT = 10;
export const MAX_HISTORY_LIMIT = 1000;

const LIMIT_KEY = 'history_limit';

export interface HistoryEntry {
  /** `${dbKey}\u0000${hash}` */
  id: string;
  /** `${storage}:${databaseName}` */
  dbKey: string;
  hash: string;
  /** Most recent code that produced this entry. */
  code: string;
  /** 'query' when the snippet returned a QueryBuilder (identity = canonical query), else 'script'. */
  kind: 'query' | 'script';
  count: number;
  firstRunAt: number;
  lastRunAt: number;
  status: 'success' | 'error';
  error?: string;
  durationMs: number;
  rowCount: number;
  pinned: boolean;
}

export interface RunRecord {
  code: string;
  /** Canonical string of the returned QueryBuilder, when there is one. */
  canonical?: string | null;
  status: 'success' | 'error';
  error?: string;
  durationMs: number;
  rowCount: number;
}

export function dbKeyFor(storage: VfsType | string, name: string): string {
  return `${storage}:${name}`;
}

export function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(MIN_HISTORY_LIMIT, Math.min(MAX_HISTORY_LIMIT, Math.round(n)));
}

/** Trims and normalizes line endings so trivially different copies of the same text match. */
export function normalizeCode(code: string): string {
  return code.replace(/\r\n?/g, '\n').trim();
}

/** Fast 53-bit string hash (cyrb53), returned as hex. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Identity of a run: canonical query structure when available, otherwise the normalized code text. */
export function computeHash(run: Pick<RunRecord, 'code' | 'canonical'>): {
  hash: string;
  kind: 'query' | 'script';
} {
  if (run.canonical) return { hash: `q${hashText(run.canonical)}`, kind: 'query' };
  return { hash: `t${hashText(normalizeCode(run.code))}`, kind: 'script' };
}

// ---------------------------------------------------------------------------
// Persistence (the `history` store of WebDBStudioDB, with an in-memory fallback)
// ---------------------------------------------------------------------------

const memoryFallback = new Map<string, HistoryEntry>();
let memoryLimit: number | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = openStudioMetaDB().then((db) => {
      if (db) {
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        if (!db.objectStoreNames.contains('history')) return null;
      }
      return db;
    });
  }
  return dbPromise;
}

/** Test hook: drops the cached connection. */
export function __resetHistoryConnection(): void {
  dbPromise = null;
  memoryFallback.clear();
  memoryLimit = null;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function pickEvictions(entries: HistoryEntry[], limit: number): HistoryEntry[] {
  return entries
    .filter((e) => !e.pinned)
    .sort((a, b) => b.lastRunAt - a.lastRunAt)
    .slice(limit);
}

export async function listHistory(dbKey: string): Promise<HistoryEntry[]> {
  const db = await getDb();
  if (!db) {
    return [...memoryFallback.values()].filter((e) => e.dbKey === dbKey);
  }
  const tx = db.transaction('history', 'readonly');
  const all = await req(tx.objectStore('history').index('byDb').getAll(dbKey));
  return (all as HistoryEntry[]).sort((a, b) => b.lastRunAt - a.lastRunAt);
}

export async function getHistoryLimit(): Promise<number> {
  const db = await getDb();
  if (!db) return memoryLimit ?? DEFAULT_HISTORY_LIMIT;
  const tx = db.transaction('state', 'readonly');
  const v = await req(tx.objectStore('state').get(LIMIT_KEY));
  return typeof v === 'number' ? clampLimit(v) : DEFAULT_HISTORY_LIMIT;
}

export async function setHistoryLimit(limit: number): Promise<number> {
  const value = clampLimit(limit);
  const db = await getDb();
  if (!db) {
    memoryLimit = value;
    return value;
  }
  const tx = db.transaction('state', 'readwrite');
  tx.objectStore('state').put(value, LIMIT_KEY);
  await txDone(tx);
  return value;
}

/** Inserts a run, or bumps the counter when the same query already exists. Evicts beyond `limit`. */
export async function recordRun(dbKey: string, run: RunRecord, limit: number): Promise<HistoryEntry | null> {
  if (!run.code || !run.code.trim()) return null;
  const { hash, kind } = computeHash(run);
  const id = `${dbKey}\u0000${hash}`;
  const now = Date.now();
  const lim = clampLimit(limit);

  const merge = (prev: HistoryEntry | undefined): HistoryEntry => ({
    id,
    dbKey,
    hash,
    kind,
    code: run.code,
    count: (prev?.count ?? 0) + 1,
    firstRunAt: prev?.firstRunAt ?? now,
    lastRunAt: now,
    status: run.status,
    error: run.status === 'error' ? run.error : undefined,
    durationMs: run.durationMs,
    rowCount: run.rowCount,
    pinned: prev?.pinned ?? false,
  });

  const db = await getDb();
  if (!db) {
    const entry = merge(memoryFallback.get(id));
    memoryFallback.set(id, entry);
    const mine = [...memoryFallback.values()].filter((e) => e.dbKey === dbKey);
    for (const ev of pickEvictions(mine, lim)) memoryFallback.delete(ev.id);
    return entry;
  }

  const tx = db.transaction('history', 'readwrite');
  const st = tx.objectStore('history');
  const prev = (await req(st.get(id))) as HistoryEntry | undefined;
  const entry = merge(prev);
  st.put(entry);
  const all = (await req(st.index('byDb').getAll(dbKey))) as HistoryEntry[];
  const merged = all.filter((e) => e.id !== id).concat(entry);
  for (const ev of pickEvictions(merged, lim)) st.delete(ev.id);
  await txDone(tx);
  return entry;
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const db = await getDb();
  if (!db) {
    const e = memoryFallback.get(id);
    if (e) memoryFallback.set(id, { ...e, pinned });
    return;
  }
  const tx = db.transaction('history', 'readwrite');
  const st = tx.objectStore('history');
  const e = (await req(st.get(id))) as HistoryEntry | undefined;
  if (e) st.put({ ...e, pinned });
  await txDone(tx);
}

export async function deleteEntry(id: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    memoryFallback.delete(id);
    return;
  }
  const tx = db.transaction('history', 'readwrite');
  tx.objectStore('history').delete(id);
  await txDone(tx);
}

/** Removes a database's history. Pinned entries are kept unless `includePinned`. Returns removed count. */
export async function clearHistory(dbKey: string, includePinned: boolean): Promise<number> {
  const db = await getDb();
  if (!db) {
    let n = 0;
    for (const e of [...memoryFallback.values()]) {
      if (e.dbKey === dbKey && (includePinned || !e.pinned)) {
        memoryFallback.delete(e.id);
        n++;
      }
    }
    return n;
  }
  const tx = db.transaction('history', 'readwrite');
  const st = tx.objectStore('history');
  const all = (await req(st.index('byDb').getAll(dbKey))) as HistoryEntry[];
  let n = 0;
  for (const e of all) {
    if (includePinned || !e.pinned) {
      st.delete(e.id);
      n++;
    }
  }
  await txDone(tx);
  return n;
}

/** How many unpinned entries would be evicted if the limit were `limit`. */
export async function countEvictable(dbKey: string, limit: number): Promise<number> {
  const entries = await listHistory(dbKey);
  return pickEvictions(entries, clampLimit(limit)).length;
}

/** Evicts least-recently-run unpinned entries beyond `limit`. */
export async function enforceLimit(dbKey: string, limit: number): Promise<number> {
  const entries = await listHistory(dbKey);
  const victims = pickEvictions(entries, clampLimit(limit));
  for (const v of victims) await deleteEntry(v.id);
  return victims.length;
}

