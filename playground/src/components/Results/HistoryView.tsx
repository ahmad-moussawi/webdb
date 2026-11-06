import React, { useMemo, useState } from 'react';
import { Play, Plus, Star, Trash2 } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import {
  MAX_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  type HistoryEntry,
} from '../../utils/history';

type DateFilter = 'all' | '1d' | '7d' | '30d';
type SortMode = 'recent' | 'runs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_WINDOWS: Record<DateFilter, number> = {
  all: Infinity,
  '1d': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function preview(code: string): string {
  return code.trim().split('\n').slice(0, 3).join('\n');
}

export const HistoryView: React.FC = () => {
  const { history, updateActiveCode, openNewTab, executeCode, setResultTab } = useStudio();
  const { entries, limit, dbKey, togglePin, remove, clear, changeLimit } = history;

  const [search, setSearch] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [sort, setSort] = useState<SortMode>('recent');
  const [limitDraft, setLimitDraft] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = Date.now() - DATE_WINDOWS[dateFilter];
    const list = entries.filter((e) => {
      if (pinnedOnly && !e.pinned) return false;
      if (errorsOnly && e.status !== 'error') return false;
      if (e.lastRunAt < cutoff) return false;
      if (q && !e.code.toLowerCase().includes(q)) return false;
      return true;
    });
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return sort === 'runs' ? b.count - a.count || b.lastRunAt - a.lastRunAt : b.lastRunAt - a.lastRunAt;
    });
    return list;
  }, [entries, search, pinnedOnly, errorsOnly, dateFilter, sort]);

  const pinnedCount = entries.filter((e) => e.pinned).length;

  const load = (e: HistoryEntry) => updateActiveCode(e.code);
  const runNow = (e: HistoryEntry) => {
    updateActiveCode(e.code);
    setResultTab('results');
    void executeCode(e.code);
  };
  const openInNewTab = (e: HistoryEntry) => openNewTab(e.code, 'History');

  const commitLimit = () => {
    if (limitDraft === null) return;
    const n = Number(limitDraft);
    setLimitDraft(null);
    if (Number.isFinite(n) && n !== limit) void changeLimit(n);
  };

  const onClear = () => {
    if (entries.length === 0) return;
    const removable = entries.length - pinnedCount;
    if (!window.confirm(`Clear ${removable} history entr${removable === 1 ? 'y' : 'ies'} for "${dbKey}"?${pinnedCount ? ` (${pinnedCount} pinned will be kept)` : ''}`)) {
      return;
    }
    let includePinned = false;
    if (pinnedCount > 0) {
      includePinned = window.confirm(`Also clear the ${pinnedCount} pinned entr${pinnedCount === 1 ? 'y' : 'ies'}?`);
    }
    void clear(includePinned);
  };

  return (
    <div className="history-view">
      <div className="history-toolbar">
        <input
          className="history-search"
          type="search"
          placeholder="Search history…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className={`history-chip ${pinnedOnly ? 'active' : ''}`}
          onClick={() => setPinnedOnly((v) => !v)}
          title="Show pinned entries only"
        >
          <Star size={11} /> Pinned
        </button>
        <button
          type="button"
          className={`history-chip ${errorsOnly ? 'active' : ''}`}
          onClick={() => setErrorsOnly((v) => !v)}
          title="Show failed runs only"
        >
          Errors
        </button>
        <select
          className="history-select"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value as DateFilter)}
          title="Last run date"
        >
          <option value="all">Any time</option>
          <option value="1d">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <select
          className="history-select"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          title="Sort order (pinned entries stay on top)"
        >
          <option value="recent">Most recent</option>
          <option value="runs">Most run</option>
        </select>
        <span className="history-spacer" />
        <label className="history-limit" title="Maximum entries kept per database (pinned entries don't count)">
          Limit
          <input
            type="number"
            min={MIN_HISTORY_LIMIT}
            max={MAX_HISTORY_LIMIT}
            value={limitDraft ?? limit}
            onChange={(e) => setLimitDraft(e.target.value)}
            onBlur={commitLimit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setLimitDraft(null);
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onClear}
          disabled={entries.length === 0}
          title="Clear this database's history"
        >
          <Trash2 size={12} /> Clear
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="history-empty">
          No history yet for <code>{dbKey}</code>. Queries you run will appear here.
        </div>
      ) : visible.length === 0 ? (
        <div className="history-empty">No entries match the current filters.</div>
      ) : (
        <div className="history-list">
          {visible.map((e) => (
            <div
              key={e.id}
              className={`history-row ${e.status === 'error' ? 'is-error' : ''}`}
              onClick={(ev) => (ev.altKey ? openInNewTab(e) : load(e))}
              onDoubleClick={() => runNow(e)}
              title="Click to load · double-click to run · Alt-click to open in a new tab"
            >
              <button
                type="button"
                className={`history-icon-btn ${e.pinned ? 'pinned' : ''}`}
                title={e.pinned ? 'Unpin' : 'Pin (never evicted)'}
                onClick={(ev) => {
                  ev.stopPropagation();
                  void togglePin(e.id, !e.pinned);
                }}
              >
                <Star size={13} fill={e.pinned ? 'currentColor' : 'none'} />
              </button>
              <pre className="history-code">{preview(e.code)}</pre>
              <span className="history-count" title={`Run ${e.count} time${e.count === 1 ? '' : 's'}`}>
                ×{e.count}
              </span>
              <span className="history-meta" title={new Date(e.lastRunAt).toLocaleString()}>
                <span className={`history-dot ${e.status === 'error' ? 'err' : 'ok'}`} title={e.error ?? 'Success'} />
                {relativeTime(e.lastRunAt)}
                <span className="history-meta-sub">
                  {e.durationMs.toFixed(1)} ms
                  {e.status === 'success' ? ` · ${e.rowCount} row${e.rowCount === 1 ? '' : 's'}` : ''}
                </span>
              </span>
              <span className="history-actions">
                <button
                  type="button"
                  className="history-icon-btn"
                  title="Load and run"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    runNow(e);
                  }}
                >
                  <Play size={13} />
                </button>
                <button
                  type="button"
                  className="history-icon-btn"
                  title="Open in new tab"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    openInNewTab(e);
                  }}
                >
                  <Plus size={13} />
                </button>
                <button
                  type="button"
                  className="history-icon-btn"
                  title="Delete entry"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void remove(e.id);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

