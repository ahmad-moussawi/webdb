import {
  useState,
  useEffect,
  useCallback,
  useRef,
  createContext,
  useContext,
  createElement,
  type DependencyList,
  type ReactNode,
} from 'react';
import {
  createLiveQuery,
  type WebDB,
  type DbRow,
  type LiveQueryFn,
  type LiveQueryOptions,
  type LiveQueryState,
  type LiveQueryController,
} from '@ahmadmoussawi/webdb';

export interface UseLiveQueryResult<T> extends LiveQueryState<T> {
  /** Manually re-runs the live query */
  refresh: () => Promise<T | undefined>;
}

const WebDBContext = createContext<WebDB | null>(null);

export interface WebDBProviderProps {
  db: WebDB | null;
  children?: ReactNode;
}

/**
 * Optional React Context Provider for sharing a WebDB instance across components.
 */
export function WebDBProvider({ db, children }: WebDBProviderProps) {
  return createElement(WebDBContext.Provider, { value: db }, children);
}

/**
 * Returns the WebDB instance from the nearest `<WebDBProvider>`.
 * Throws if used outside a `<WebDBProvider>` without an active instance.
 */
export function useWebDB(): WebDB {
  const db = useContext(WebDBContext);
  if (!db) {
    throw new Error(
      'useWebDB() must be used within a <WebDBProvider db={...}> with an initialized WebDB instance.',
    );
  }
  return db;
}

/**
 * Returns the WebDB instance from the nearest `<WebDBProvider>`, or `null` if none is present.
 */
export function useOptionalWebDB(): WebDB | null {
  return useContext(WebDBContext);
}

/**
 * React hook that executes a WebDB query and automatically re-runs whenever any
 * referenced tables (including JOINs and subqueries) are modified locally or across tabs.
 *
 * @example
 * ```tsx
 * const { data: todos, isLoading, error } = useLiveQuery(
 *   () => db.from('todos').where('completed', '=', 0).orderBy('id', 'desc'),
 *   [filter],
 *   { initialData: [] }
 * );
 * ```
 */
export function useLiveQuery<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  deps: DependencyList = [],
  options: LiveQueryOptions<T> = {},
): UseLiveQueryResult<T> {
  const contextDb = useContext(WebDBContext);
  const resolvedDb = options.db ?? contextDb;

  const queryFnRef = useRef<LiveQueryFn<T>>(queryFn);
  queryFnRef.current = queryFn;

  const optionsRef = useRef<LiveQueryOptions<T>>(options);
  optionsRef.current = options;

  const controllerRef = useRef<LiveQueryController<T> | null>(null);

  const [state, setState] = useState<LiveQueryState<T>>(() => ({
    data: options.initialData,
    isLoading: true,
    error: null,
    lastUpdated: null,
    lastEvent: null,
  }));

  useEffect(() => {
    const controller = createLiveQuery<T>(() => queryFnRef.current(), {
      ...optionsRef.current,
      db: resolvedDb,
    });
    controllerRef.current = controller;

    const unsubscribe = controller.subscribe((nextState) => {
      setState(nextState);
    });

    return () => {
      unsubscribe();
      controller.destroy();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDb, ...deps]);

  const refresh = useCallback(async (): Promise<T | undefined> => {
    if (controllerRef.current) {
      return controllerRef.current.refresh();
    }
    return undefined;
  }, []);

  return {
    ...state,
    refresh,
  };
}

/**
 * Concise React hook (similar to Dexie's `useLiveQuery`) that returns the live query
 * result directly (or `defaultValue` while loading).
 *
 * @example
 * ```tsx
 * const todos = useLiveQueryData(
 *   () => db.from('todos').orderBy('id', 'desc'),
 *   [],
 *   []
 * );
 * ```
 */
export function useLiveQueryData<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  deps: DependencyList = [],
  defaultValue?: T,
  options: LiveQueryOptions<T> = {},
): T | undefined {
  const { data } = useLiveQuery<T>(queryFn, deps, {
    ...options,
    initialData: options.initialData ?? defaultValue,
  });
  return data ?? defaultValue;
}

