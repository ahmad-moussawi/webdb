/// <reference path="./peer-types.d.ts" />
import {
  ref,
  shallowRef,
  readonly,
  watch,
  getCurrentScope,
  onScopeDispose,
  provide,
  inject,
  type Ref,
  type ShallowRef,
  type WatchSource,
  type InjectionKey,
} from 'vue';
import {
  createLiveQuery,
  type WebDB,
  type DbRow,
  type TableChangeEvent,
  type LiveQueryFn,
  type LiveQueryOptions,
} from '@ahmadmoussawi/webdb';

/**
 * Vue InjectionKey for providing and injecting a WebDB instance across a Vue component tree.
 */
export const WEBDB_INJECTION_KEY: InjectionKey<WebDB> = Symbol('WEBDB_INSTANCE') as InjectionKey<WebDB>;

/**
 * Provides a WebDB instance either inside a Vue component's `setup()` or on a Vue `App` instance.
 *
 * @example
 * ```ts
 * // In main.ts:
 * const app = createApp(App);
 * provideWebDB(db, app);
 *
 * // Or inside a root component <script setup>:
 * provideWebDB(db);
 * ```
 */
export function provideWebDB(
  db: WebDB,
  app?: { provide: (key: any, value: any) => any },
): WebDB {
  if (app && typeof app.provide === 'function') {
    app.provide(WEBDB_INJECTION_KEY, db);
  } else {
    provide(WEBDB_INJECTION_KEY, db);
  }
  return db;
}

/**
 * Injects the nearest provided WebDB instance in a Vue component or composable.
 * Throws if no WebDB instance was provided via `provideWebDB(db)`.
 */
export function useWebDB(): WebDB {
  const db = useOptionalWebDB();
  if (!db) {
    throw new Error(
      'useWebDB() found no provided WebDB instance. Call provideWebDB(db) in a parent component or on your Vue app.',
    );
  }
  return db;
}

/**
 * Injects the nearest provided WebDB instance, or returns `null` if none is provided.
 */
export function useOptionalWebDB(): WebDB | null {
  try {
    return inject(WEBDB_INJECTION_KEY, null as unknown as WebDB) ?? null;
  } catch {
    return null;
  }
}

export interface VueLiveQueryOptions<T> extends LiveQueryOptions<T> {
  /**
   * Optional Vue reactive watch source(s) (`Ref`, `ComputedRef`, getter, or array of sources)
   * that should trigger a query re-execution when mutated.
   */
  watch?: WatchSource | WatchSource[];
  /**
   * Whether to enable deep watching on `watch` sources (default: false).
   */
  deep?: boolean;
}

export interface UseVueLiveQueryReturn<T> {
  /** Reactive ref containing the latest query result (`initialData` or `undefined` while loading) */
  readonly data: Readonly<ShallowRef<T | undefined>>;
  /** Reactive ref indicating whether the initial query is currently loading */
  readonly isLoading: Readonly<Ref<boolean>>;
  /** Reactive ref containing the latest query error, or `null` */
  readonly error: Readonly<ShallowRef<Error | null>>;
  /** Reactive ref containing the timestamp of the last successful query execution */
  readonly lastUpdated: Readonly<Ref<number | null>>;
  /** Reactive ref containing the last table change event that triggered a refresh */
  readonly lastEvent: Readonly<ShallowRef<TableChangeEvent | null>>;
  /** Manually forces a re-execution of the query */
  refresh: () => Promise<T | undefined>;
  /** Stops all database and reactive watchers for this live query */
  stop: () => void;
}

function isLiveQueryOptionsObject<T>(
  val: unknown,
): val is VueLiveQueryOptions<T> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  // Vue Ref / ComputedRef have `.value` or `__v_isRef`
  if ('__v_isRef' in val || 'value' in val || 'effect' in val) return false;
  return true;
}

/**
 * Vue 3 composable that executes a WebDB query and automatically updates reactive `Ref`s whenever:
 * 1. Any referenced WebDB tables (including JOINs & subqueries) are modified locally or across tabs, OR
 * 2. Any watched Vue `Ref` / `ComputedRef` / getter passed in `deps` or `options.watch` changes.
 *
 * Automatically cleans up subscriptions when the enclosing Vue component or `effectScope` is disposed.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { ref } from 'vue';
 * import { useLiveQuery } from '@ahmadmoussawi/webdb/vue';
 *
 * const filterStatus = ref('active');
 * const { data: todos, isLoading, error } = useLiveQuery(
 *   () => db.from('todos').where('status', '=', filterStatus.value).orderBy('id', 'desc'),
 *   [filterStatus],
 *   { initialData: [] }
 * );
 * </script>
 * ```
 */
export function useLiveQuery<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  depsOrOptions?: WatchSource | WatchSource[] | VueLiveQueryOptions<T>,
  maybeOptions?: VueLiveQueryOptions<T>,
): UseVueLiveQueryReturn<T> {
  let watchSources: WatchSource | WatchSource[] | undefined;
  let options: VueLiveQueryOptions<T>;

  if (isLiveQueryOptionsObject<T>(depsOrOptions)) {
    options = depsOrOptions;
    watchSources = options.watch;
  } else {
    watchSources = depsOrOptions as WatchSource | WatchSource[] | undefined;
    options = maybeOptions ?? {};
    if (!watchSources && options.watch) {
      watchSources = options.watch;
    }
  }

  const injectedDb = options.db ? null : useOptionalWebDB();
  const resolvedDb = options.db ?? injectedDb;

  const data = shallowRef<T | undefined>(options.initialData);
  const isLoading = ref<boolean>(true);
  const error = shallowRef<Error | null>(null);
  const lastUpdated = ref<number | null>(null);
  const lastEvent = shallowRef<TableChangeEvent | null>(null);

  const controller = createLiveQuery<T>(queryFn, {
    ...options,
    db: resolvedDb,
  });

  const unsubController = controller.subscribe((state) => {
    data.value = state.data;
    isLoading.value = state.isLoading;
    error.value = state.error;
    lastUpdated.value = state.lastUpdated;
    lastEvent.value = state.lastEvent;
  });

  let stopWatch: (() => void) | null = null;
  if (watchSources) {
    stopWatch = watch(
      watchSources,
      () => {
        void controller.refresh();
      },
      { deep: options.deep },
    );
  }

  let isStopped = false;
  const stop = () => {
    if (isStopped) return;
    isStopped = true;
    if (stopWatch) {
      try {
        stopWatch();
      } catch {}
      stopWatch = null;
    }
    unsubController();
    controller.destroy();
  };

  if (getCurrentScope()) {
    onScopeDispose(stop);
  }

  return {
    data: readonly(data) as Readonly<ShallowRef<T | undefined>>,
    isLoading: readonly(isLoading) as Readonly<Ref<boolean>>,
    error: readonly(error) as Readonly<ShallowRef<Error | null>>,
    lastUpdated: readonly(lastUpdated) as Readonly<Ref<number | null>>,
    lastEvent: readonly(lastEvent) as Readonly<ShallowRef<TableChangeEvent | null>>,
    refresh: () => controller.refresh(),
    stop,
  };
}

/**
 * Concise Vue 3 composable that returns a single readonly `Ref<T | undefined>` containing
 * the live query result directly (or `defaultValue` while loading).
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useLiveQueryData } from '@ahmadmoussawi/webdb/vue';
 *
 * const todos = useLiveQueryData(
 *   () => db.from('todos').orderBy('id', 'desc'),
 *   [],
 *   []
 * );
 * </script>
 * ```
 */
export function useLiveQueryData<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  deps?: WatchSource | WatchSource[],
  defaultValue?: T,
  options: VueLiveQueryOptions<T> = {},
): Readonly<ShallowRef<T | undefined>> {
  const { data } = useLiveQuery<T>(queryFn, deps, {
    ...options,
    initialData: options.initialData ?? defaultValue,
  });
  return data;
}

