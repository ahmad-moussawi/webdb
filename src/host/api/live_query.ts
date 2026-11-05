import type { DbRow, TableChangeEvent } from '../../types/index.js';
import { isQueryBuilder, type QueryBuilder } from './query_builder.js';

export interface SubscribableDatabase {
  subscribe(
    tables: string | string[] | '*',
    callback: (event: TableChangeEvent) => void,
  ): () => void;
}

export interface LiveQueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  lastUpdated: number | null;
  lastEvent: TableChangeEvent | null;
}

export interface LiveQueryOptions<T> {
  /** Initial value for `data` before the first query execution finishes */
  initialData?: T;
  /** Optional explicit database instance (automatically inferred from QueryBuilder / db.from() calls when omitted) */
  db?: SubscribableDatabase | null;
  /** Optional explicit table names to watch (automatically inferred from QueryBuilder / db.from() calls when omitted) */
  tables?: string | string[] | '*';
  /** Optional debounce time in milliseconds before re-running query after a table change */
  debounceMs?: number;
  /** Optional callback invoked if the query throws an error */
  onError?: (error: Error) => void;
  /** Whether to start the initial query execution immediately upon creation (default: true) */
  autoStart?: boolean;
}

export interface LiveQueryController<T> extends AsyncIterable<T> {
  /** Returns the current snapshot of the live query state */
  getState(): LiveQueryState<T>;
  /** Subscribes to state changes; invokes listener immediately with current state and returns an unsubscribe function */
  subscribe(listener: (state: LiveQueryState<T>) => void): () => void;
  /** Subscribes only to resolved data updates (`!isLoading && !error`); returns an unsubscribe function */
  onData(listener: (data: T, state: LiveQueryState<T>) => void): () => void;
  /** Manually forces a re-execution of the query */
  refresh(): Promise<T | undefined>;
  /** Cleans up all database subscriptions and timers */
  destroy(): void;
  /** Allows consuming live query results via `for await (const data of query)` */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

export type LiveQueryFn<T> = () => Promise<T> | T | QueryBuilder;

export interface ActiveReadTracker {
  record(db: any, tables: string[]): void;
}

const dbInstanceIds = new WeakMap<SubscribableDatabase, number>();
let nextDbInstanceId = 1;

function getDbInstanceKey(db: SubscribableDatabase): string {
  const explicitId = (db as any)?.instanceId;
  if (typeof explicitId === 'string' && explicitId.length > 0) {
    return explicitId;
  }
  let id = dbInstanceIds.get(db);
  if (id === undefined) {
    id = nextDbInstanceId++;
    dbInstanceIds.set(db, id);
  }
  return `db_${id}`;
}

let currentTracker: ActiveReadTracker | null = null;
const trackerStack: Array<ActiveReadTracker | null> = [];

export function pushLiveQueryTracker(tracker: ActiveReadTracker | null): void {
  trackerStack.push(currentTracker);
  currentTracker = tracker;
}

export function popLiveQueryTracker(): void {
  currentTracker = trackerStack.length > 0 ? trackerStack.pop()! : null;
}

export function getActiveLiveQueryTracker(): ActiveReadTracker | null {
  return currentTracker;
}

/**
 * Wraps an async query execution promise so that `callerTracker` is NOT active
 * while awaiting I/O or the lease queue (preventing cross-contamination from
 * concurrent queries), and is atomically restored only for the synchronous
 * continuation microtask of the `await` caller.
 */
export function trackLiveQueryPromise<R>(
  promise: Promise<R>,
  callerTracker: ActiveReadTracker | null,
): Promise<R> {
  if (!callerTracker) {
    return promise;
  }
  return new Promise<R>((resolve, reject) => {
    promise.then(
      (val) => {
        queueMicrotask(() => pushLiveQueryTracker(callerTracker));
        resolve(val);
        queueMicrotask(() => popLiveQueryTracker());
      },
      (err) => {
        queueMicrotask(() => pushLiveQueryTracker(callerTracker));
        reject(err);
        queueMicrotask(() => popLiveQueryTracker());
      },
    );
  });
}

/**
 * Internal hook called by QueryBuilder and WebDB read methods to record
 * which database instance and table names were accessed during a live query run.
 */
export function notifyLiveQueryTableRead(db: any, tables: string | string[]): void {
  if (!currentTracker || !db) return;
  const list = Array.isArray(tables) ? tables : [tables];
  currentTracker.record(db, list);
}

/**
 * Creates a framework-agnostic reactive live query controller that automatically
 * tracks accessed WebDB tables (including JOINs and subqueries) and re-executes
 * whenever those tables are modified locally or from another browser tab / Web Worker.
 */
export function createLiveQuery<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  options: LiveQueryOptions<T> = {},
): LiveQueryController<T> {
  let state: LiveQueryState<T> = {
    data: options.initialData,
    isLoading: true,
    error: null,
    lastUpdated: null,
    lastEvent: null,
  };

  const listeners = new Set<(state: LiveQueryState<T>) => void>();
  let dbUnsubscribes: Array<() => void> = [];
  let currentSubSignature = '';
  let currentRunId = 0;
  let latestRunPromise: Promise<T | undefined> | null = null;
  let isDestroyed = false;
  let pendingMicrotask = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEvent: TableChangeEvent | undefined = undefined;

  const hasExplicitTables = options.tables !== undefined;
  const normalizeExplicitTables = (): string[] => {
    if (!options.tables || options.tables === '*') {
      return ['*'];
    }
    const list = Array.isArray(options.tables) ? options.tables : [options.tables];
    return list.map((t) => t.toLowerCase());
  };

  const emit = () => {
    if (isDestroyed) return;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {}
    }
  };

  const clearDbSubscriptions = () => {
    for (const unsub of dbUnsubscribes) {
      try {
        unsub();
      } catch {}
    }
    dbUnsubscribes = [];
    currentSubSignature = '';
  };

  const scheduleReExecution = (event?: TableChangeEvent) => {
    if (isDestroyed) return;
    pendingEvent = event;

    if (options.debounceMs && options.debounceMs > 0) {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const ev = pendingEvent;
        pendingEvent = undefined;
        void execute(ev);
      }, options.debounceMs);
      return;
    }

    if (!pendingMicrotask) {
      pendingMicrotask = true;
      queueMicrotask(() => {
        if (!pendingMicrotask || isDestroyed) return;
        pendingMicrotask = false;
        const ev = pendingEvent;
        pendingEvent = undefined;
        void execute(ev);
      });
    }
  };

  const updateDbSubscriptions = (trackedMap: Map<SubscribableDatabase, Set<string>>) => {
    if (isDestroyed) return;

    // Only fall back to `options.db` when no database instance was dynamically tracked in `queryFn`
    if (trackedMap.size === 0 && options.db && typeof options.db.subscribe === 'function') {
      trackedMap.set(options.db, new Set());
    }

    // If `options.tables` is explicitly provided, treat it as authoritative
    if (hasExplicitTables) {
      const authoritativeTables = normalizeExplicitTables();
      for (const [dbInst] of trackedMap) {
        trackedMap.set(dbInst, new Set(authoritativeTables));
      }
    }

    // Build a deterministic signature that includes each database's unique instance identity
    const sigParts: string[] = [];
    for (const [dbInst, tableSet] of trackedMap) {
      const dbKey = getDbInstanceKey(dbInst);
      const sorted = tableSet.has('*') ? ['*'] : Array.from(tableSet).sort();
      sigParts.push(`${dbKey}:${sorted.join(',')}`);
    }
    sigParts.sort();
    const nextSignature = sigParts.join('|');

    if (nextSignature === currentSubSignature && dbUnsubscribes.length > 0) {
      return;
    }

    clearDbSubscriptions();
    currentSubSignature = nextSignature;

    for (const [dbInst, tableSet] of trackedMap) {
      if (!dbInst || typeof dbInst.subscribe !== 'function') continue;
      const tablesArg =
        tableSet.has('*') || tableSet.size === 0
          ? '*'
          : Array.from(tableSet);
      const unsub = dbInst.subscribe(tablesArg, (ev) => {
        scheduleReExecution(ev);
      });
      dbUnsubscribes.push(unsub);
    }
  };

  const execute = (triggerEvent?: TableChangeEvent): Promise<T | undefined> => {
    if (isDestroyed) return Promise.resolve(state.data);

    // Clear any pending microtask or debounce timer that hasn't fired yet
    if (pendingMicrotask) {
      pendingMicrotask = false;
    }
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (triggerEvent === undefined && pendingEvent !== undefined) {
      triggerEvent = pendingEvent;
      pendingEvent = undefined;
    }

    const runId = ++currentRunId;

    const runPromise = (async (): Promise<T | undefined> => {
      const trackedMap = new Map<SubscribableDatabase, Set<string>>();
      const tracker: ActiveReadTracker = {
        record(db: any, tables: string[]) {
          if (!db || typeof db.subscribe !== 'function') return;
          let set = trackedMap.get(db);
          if (!set) {
            set = new Set<string>();
            trackedMap.set(db, set);
          }
          // When explicit `options.tables` is provided, ignore auto-tracked table names
          if (hasExplicitTables) return;
          for (const t of tables) {
            if (t && t !== '__subquery__') {
              set.add(t.toLowerCase());
            }
          }
        },
      };

      const skipAutoTrack =
        hasExplicitTables &&
        Boolean(options.db && typeof options.db.subscribe === 'function');

      try {
        let rawResult: Promise<T> | T | QueryBuilder;
        if (skipAutoTrack) {
          rawResult = queryFn();
        } else {
          pushLiveQueryTracker(tracker);
          try {
            rawResult = queryFn();
          } finally {
            popLiveQueryTracker();
          }
        }

        let resolved: T;
        if (isQueryBuilder(rawResult)) {
          const qb = rawResult as QueryBuilder;
          if (!skipAutoTrack) {
            tracker.record(qb.getDb(), qb.getReferencedTables());
          }
          resolved = (await qb.toArray()) as unknown as T;
        } else {
          const awaited = await rawResult;
          if (isQueryBuilder(awaited)) {
            const qb = awaited as QueryBuilder;
            if (!skipAutoTrack) {
              tracker.record(qb.getDb(), qb.getReferencedTables());
            }
            resolved = (await qb.toArray()) as unknown as T;
          } else {
            resolved = awaited;
          }
        }

        if (isDestroyed) {
          return state.data;
        }
        if (runId !== currentRunId) {
          return latestRunPromise ? await latestRunPromise : state.data;
        }

        updateDbSubscriptions(trackedMap);

        state = {
          data: resolved,
          isLoading: false,
          error: null,
          lastUpdated: Date.now(),
          lastEvent: triggerEvent ?? state.lastEvent,
        };
        emit();
        return resolved;
      } catch (err: any) {
        if (isDestroyed) {
          return state.data;
        }
        if (runId !== currentRunId) {
          return latestRunPromise ? await latestRunPromise : state.data;
        }

        // Still register any subscriptions discovered before the error so recovery mutations can re-trigger
        if (trackedMap.size > 0 || options.db) {
          updateDbSubscriptions(trackedMap);
        }

        const errorObj = err instanceof Error ? err : new Error(String(err));
        state = {
          ...state,
          isLoading: false,
          error: errorObj,
        };
        if (options.onError) {
          try {
            options.onError(errorObj);
          } catch {}
        }
        emit();
        return state.data;
      }
    })();

    latestRunPromise = runPromise;
    return runPromise;
  };

  // Start initial execution immediately unless autoStart is false
  if (options.autoStart !== false) {
    void execute();
  }

  const controller: LiveQueryController<T> = {
    getState() {
      return state;
    },
    subscribe(listener: (state: LiveQueryState<T>) => void): () => void {
      if (isDestroyed) return () => {};
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    onData(listener: (data: T, state: LiveQueryState<T>) => void): () => void {
      return controller.subscribe((s) => {
        if (!s.isLoading && !s.error && s.data !== undefined) {
          listener(s.data, s);
        }
      });
    },
    refresh(): Promise<T | undefined> {
      return execute();
    },
    destroy() {
      if (isDestroyed) return;
      isDestroyed = true;
      currentRunId++;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearDbSubscriptions();
      listeners.clear();
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      const queue: Array<{ value?: T; error?: Error; done?: boolean }> = [];
      let pendingResolve: ((res: IteratorResult<T>) => void) | null = null;
      let pendingReject: ((err: Error) => void) | null = null;
      let unsub: (() => void) | null = null;
      let iterClosed = false;

      const pushValue = (val: T) => {
        if (iterClosed) return;
        if (pendingResolve) {
          const resolve = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          resolve({ value: val, done: false });
        } else {
          queue.push({ value: val });
        }
      };

      const pushError = (err: Error) => {
        if (iterClosed) return;
        if (pendingReject) {
          const reject = pendingReject;
          pendingResolve = null;
          pendingReject = null;
          reject(err);
        } else {
          queue.push({ error: err });
        }
      };

      unsub = controller.subscribe((s) => {
        if (s.isLoading) return;
        if (s.error) {
          pushError(s.error);
        } else if (s.data !== undefined) {
          pushValue(s.data);
        }
      });

      const cleanupIter = () => {
        if (iterClosed) return;
        iterClosed = true;
        if (unsub) {
          unsub();
          unsub = null;
        }
        controller.destroy();
        if (pendingResolve) {
          const resolve = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          resolve({ value: undefined as unknown as T, done: true });
        }
      };

      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            const item = queue.shift()!;
            if (item.error) return Promise.reject(item.error);
            if (item.done) {
              return Promise.resolve({ value: undefined as unknown as T, done: true });
            }
            return Promise.resolve({ value: item.value as T, done: false });
          }
          if (iterClosed || isDestroyed) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
          });
        },
        return(): Promise<IteratorResult<T>> {
          cleanupIter();
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        },
        throw(err?: any): Promise<IteratorResult<T>> {
          cleanupIter();
          return Promise.reject(err);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };

  return controller;
}

/**
 * Plain JavaScript helper to create and optionally subscribe to a reactive live query.
 *
 * @example
 * ```ts
 * // 1. With callback:
 * const query = liveQuery(
 *   () => db.from('todos').where('completed', '=', false).orderBy('id', 'desc'),
 *   (todos) => renderTodoList(todos),
 * );
 *
 * // 2. With AsyncIterator (`for await ... of`):
 * for await (const todos of liveQuery(() => db.from('todos'))) {
 *   renderTodoList(todos);
 * }
 * ```
 */
export function liveQuery<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  callbackOrOptions?: ((data: T, state: LiveQueryState<T>) => void) | LiveQueryOptions<T>,
  options?: LiveQueryOptions<T>,
): LiveQueryController<T> {
  const isCallback = typeof callbackOrOptions === 'function';
  const resolvedOptions = isCallback ? options : callbackOrOptions;
  const controller = createLiveQuery<T>(queryFn, resolvedOptions);
  if (isCallback) {
    controller.onData(callbackOrOptions);
  }
  return controller;
}
