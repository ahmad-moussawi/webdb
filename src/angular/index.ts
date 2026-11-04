/// <reference path="./peer-types.d.ts" />
import {
  signal,
  computed,
  effect,
  inject,
  DestroyRef,
  InjectionToken,
  makeEnvironmentProviders,
  type Signal,
  type Injector,
  type EnvironmentProviders,
} from '@angular/core';
import { Observable } from 'rxjs';
import {
  createLiveQuery,
  type WebDB,
  type DbRow,
  type LiveQueryFn,
  type LiveQueryOptions,
  type LiveQueryState,
} from '@ahmadmoussawi/webdb';

/**
 * Angular InjectionToken for providing a WebDB instance via Dependency Injection.
 */
export const WEBDB_TOKEN = new InjectionToken<WebDB>('WEBDB_INSTANCE');

/**
 * Provides a WebDB instance (or factory) in an Angular application or route config.
 *
 * @example
 * ```ts
 * export const appConfig: ApplicationConfig = {
 *   providers: [provideWebDB(db)],
 * };
 * ```
 */
export function provideWebDB(
  dbOrFactory: WebDB | (() => WebDB),
): EnvironmentProviders {
  return makeEnvironmentProviders([
    typeof dbOrFactory === 'function'
      ? { provide: WEBDB_TOKEN, useFactory: dbOrFactory }
      : { provide: WEBDB_TOKEN, useValue: dbOrFactory },
  ]);
}

/**
 * Injects the configured WebDB instance inside an Angular injection context.
 */
export function injectWebDB(): WebDB {
  const db = inject(WEBDB_TOKEN, { optional: true });
  if (!db) {
    throw new Error(
      'No WebDB instance found in Angular injector. Register one using provideWebDB(db).',
    );
  }
  return db;
}

export interface AngularLiveQueryOptions<T> extends LiveQueryOptions<T> {
  /** Optional Angular DestroyRef for automatic cleanup outside an injection context */
  destroyRef?: DestroyRef;
  /** Optional Angular Injector for running signal effects and resolving DestroyRef */
  injector?: Injector;
}

export interface LiveQuerySignal<T> {
  /** Signal containing the latest query result (`initialData` or `undefined` while loading) */
  readonly data: Signal<T | undefined>;
  /** Signal indicating whether the initial query is currently loading */
  readonly isLoading: Signal<boolean>;
  /** Signal containing the latest query error, or `null` */
  readonly error: Signal<Error | null>;
  /** Signal containing the full `LiveQueryState<T>` snapshot */
  readonly state: Signal<LiveQueryState<T>>;
  /** Manually forces a re-execution of the query */
  refresh(): Promise<T | undefined>;
  /** Cleans up database subscriptions and stops the live query */
  destroy(): void;
}

/**
 * Creates an Angular Signal-based live query that automatically updates whenever:
 * 1. Any referenced WebDB tables (including JOINs & subqueries) are modified locally or across tabs, OR
 * 2. Any Angular Signals read synchronously inside `queryFn` change.
 *
 * Automatically cleans up subscriptions when the enclosing Angular component/service is destroyed.
 *
 * @example
 * ```ts
 * @Component({
 *   template: `
 *     @if (todos.isLoading()) { <p>Loading...</p> }
 *     @for (todo of todos.data(); track todo.id) {
 *       <li>{{ todo.title }}</li>
 *     }
 *   `
 * })
 * export class TodoListComponent {
 *   status = signal('active');
 *   todos = liveQuerySignal(
 *     () => db.from('todos').where('status', '=', this.status()).orderBy('id', 'desc'),
 *     { initialData: [] }
 *   );
 * }
 * ```
 */
export function liveQuerySignal<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  options: AngularLiveQueryOptions<T> = {},
): LiveQuerySignal<T> {
  let destroyRef = options.destroyRef ?? null;
  let injectedDb: WebDB | null = null;

  if (!destroyRef) {
    try {
      destroyRef = options.injector
        ? options.injector.get(DestroyRef, undefined) ?? null
        : inject(DestroyRef, { optional: true });
    } catch {}
  }

  if (!options.db) {
    try {
      injectedDb = options.injector
        ? options.injector.get(WEBDB_TOKEN, undefined) ?? null
        : inject(WEBDB_TOKEN, { optional: true });
    } catch {}
  }

  const stateSignal = signal<LiveQueryState<T>>({
    data: options.initialData,
    isLoading: true,
    error: null,
    lastUpdated: null,
    lastEvent: null,
  });

  const controller = createLiveQuery<T>(queryFn, {
    ...options,
    db: options.db ?? injectedDb,
    autoStart: false,
  });

  const unsubscribe = controller.subscribe((nextState) => {
    stateSignal.set(nextState);
  });

  let effectRef: { destroy(): void } | null = null;
  try {
    effectRef = effect(
      () => {
        void controller.refresh();
      },
      {
        injector: options.injector,
        allowSignalWrites: true,
      },
    );
  } catch {
    // Outside an Angular injection context without an injector: start immediately
    void controller.refresh();
  }

  const destroy = () => {
    if (effectRef) {
      try {
        effectRef.destroy();
      } catch {}
      effectRef = null;
    }
    unsubscribe();
    controller.destroy();
  };

  if (destroyRef) {
    destroyRef.onDestroy(destroy);
  }

  return {
    data: computed(() => stateSignal().data),
    isLoading: computed(() => stateSignal().isLoading),
    error: computed(() => stateSignal().error),
    state: stateSignal.asReadonly(),
    refresh: () => controller.refresh(),
    destroy,
  };
}

/**
 * Returns a cold RxJS `Observable<T>` that executes `queryFn` upon subscription
 * and emits fresh results whenever any referenced WebDB tables change locally or across tabs.
 * Automatically unsubscribes from WebDB when the RxJS subscription is closed.
 *
 * Compatible with Angular's `| async` pipe, `toSignal()`, `switchMap()`, and `combineLatest()`.
 *
 * @example
 * ```ts
 * todos$ = this.filter$.pipe(
 *   switchMap((status) =>
 *     liveQuery$(() => db.from('todos').where('status', '=', status))
 *   )
 * );
 * ```
 */
export function liveQuery$<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  options: LiveQueryOptions<T> = {},
): Observable<T> {
  return new Observable<T>((subscriber) => {
    const controller = createLiveQuery<T>(queryFn, options);
    const unsubscribe = controller.subscribe((state) => {
      if (state.error) {
        subscriber.error(state.error);
        return;
      }
      if (!state.isLoading || state.data !== undefined) {
        subscriber.next(state.data as T);
      }
    });

    return () => {
      unsubscribe();
      controller.destroy();
    };
  });
}

/**
 * Returns a cold RxJS `Observable<LiveQueryState<T>>` that emits the full state object
 * (`{ data, isLoading, error, lastUpdated, lastEvent }`) on every transition.
 */
export function liveQueryState$<T = DbRow[]>(
  queryFn: LiveQueryFn<T>,
  options: LiveQueryOptions<T> = {},
): Observable<LiveQueryState<T>> {
  return new Observable<LiveQueryState<T>>((subscriber) => {
    const controller = createLiveQuery<T>(queryFn, options);
    const unsubscribe = controller.subscribe((state) => {
      subscriber.next(state);
    });

    return () => {
      unsubscribe();
      controller.destroy();
    };
  });
}

