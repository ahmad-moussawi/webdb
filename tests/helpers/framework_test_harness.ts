import React from 'react';

// ============================================================================
// 1. Minimal React 18 Hook Test Harness (Zero-DOM, runs against real `react`)
// ============================================================================

interface HookCell {
  state?: any;
  deps?: readonly any[];
  cleanup?: (() => void) | void;
  effect?: () => (() => void) | void;
  pendingRun?: boolean;
}

export interface RenderHookOptions {
  wrapper?: React.ReactElement;
}

export function renderReactHook<TProps, TResult>(
  callback: (props: TProps) => TResult,
  initialProps?: TProps,
  options?: RenderHookOptions,
) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const hooks: HookCell[] = [];
  let hookIndex = 0;
  let currentProps = initialProps as TProps;
  let isUnmounted = false;
  const contextMap = new Map<any, any>();

  // Extract context values from optional <WebDBProvider db={...}> wrapper
  const updateContextFromWrapper = (el: any) => {
    contextMap.clear();
    let cur = el;
    while (cur && typeof cur === 'object') {
      if (typeof cur.type === 'function') {
        const rendered = cur.type(cur.props);
        cur = rendered;
      } else if (cur.type && cur.type._context) {
        contextMap.set(cur.type._context, cur.props?.value);
        cur = cur.props?.children;
      } else {
        break;
      }
    }
  };

  if (options?.wrapper) {
    updateContextFromWrapper(options.wrapper);
  }

  let resultObj: { current: TResult } = { current: undefined as unknown as TResult };

  const areDepsEqual = (nextDeps?: readonly any[], prevDeps?: readonly any[]) => {
    if (!nextDeps || !prevDeps || nextDeps.length !== prevDeps.length) return false;
    for (let i = 0; i < nextDeps.length; i++) {
      if (!Object.is(nextDeps[i], prevDeps[i])) return false;
    }
    return true;
  };

  const flushEffects = () => {
    for (const cell of hooks) {
      if (cell.pendingRun && cell.effect) {
        cell.pendingRun = false;
        if (typeof cell.cleanup === 'function') {
          cell.cleanup();
        }
        cell.cleanup = cell.effect();
      }
    }
  };

  const dispatcher = {
    useContext(ctx: any) {
      return contextMap.has(ctx) ? contextMap.get(ctx) : ctx._currentValue;
    },
    useRef(initialValue: any) {
      const idx = hookIndex++;
      if (!hooks[idx]) {
        hooks[idx] = { state: { current: initialValue } };
      }
      return hooks[idx].state;
    },
    useState(initialState: any) {
      const idx = hookIndex++;
      if (!hooks[idx]) {
        const val = typeof initialState === 'function' ? initialState() : initialState;
        hooks[idx] = { state: val };
      }
      const setState = (updater: any) => {
        if (isUnmounted) return;
        const nextVal =
          typeof updater === 'function' ? updater(hooks[idx].state) : updater;
        if (!Object.is(nextVal, hooks[idx].state)) {
          hooks[idx].state = nextVal;
          render();
        }
      };
      return [hooks[idx].state, setState];
    },
    useCallback(fn: any, deps?: readonly any[]) {
      const idx = hookIndex++;
      if (!hooks[idx] || !areDepsEqual(deps, hooks[idx].deps)) {
        hooks[idx] = { state: fn, deps };
      }
      return hooks[idx].state;
    },
    useEffect(create: () => (() => void) | void, deps?: readonly any[]) {
      const idx = hookIndex++;
      if (!hooks[idx]) {
        hooks[idx] = { effect: create, deps, pendingRun: true };
      } else if (!areDepsEqual(deps, hooks[idx].deps)) {
        hooks[idx].effect = create;
        hooks[idx].deps = deps;
        hooks[idx].pendingRun = true;
      }
    },
  };

  const render = () => {
    if (isUnmounted) return;
    const prevDispatcher = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    hookIndex = 0;
    try {
      resultObj.current = callback(currentProps);
    } finally {
      internals.ReactCurrentDispatcher.current = prevDispatcher;
    }
    flushEffects();
  };

  render();

  return {
    result: resultObj,
    rerender(newProps?: TProps) {
      if (newProps !== undefined) {
        currentProps = newProps;
      }
      render();
    },
    unmount() {
      if (isUnmounted) return;
      isUnmounted = true;
      for (const cell of hooks) {
        if (typeof cell.cleanup === 'function') {
          cell.cleanup();
          cell.cleanup = undefined;
        }
      }
    },
  };
}

// ============================================================================
// 2. Angular Signals, DI & RxJS Reactive Runtime for Unit Tests
// ============================================================================

let activeSignalConsumer: (() => void) | null = null;
let currentInjectorMap: Map<any, any> | null = null;

export function signal<T>(initialValue: T) {
  let value = initialValue;
  const subscribers = new Set<() => void>();

  const getter: any = () => {
    if (activeSignalConsumer) {
      subscribers.add(activeSignalConsumer);
    }
    return value;
  };

  getter.set = (nextValue: T) => {
    if (!Object.is(value, nextValue)) {
      value = nextValue;
      for (const sub of Array.from(subscribers)) {
        sub();
      }
    }
  };

  getter.update = (updater: (v: T) => T) => {
    getter.set(updater(value));
  };

  getter.asReadonly = () => () => getter();

  return getter;
}

export function computed<T>(computation: () => T) {
  return () => computation();
}

export function effect(effectFn: () => void, _options?: any) {
  let destroyed = false;
  const runner = () => {
    if (destroyed) return;
    const prev = activeSignalConsumer;
    activeSignalConsumer = runner;
    try {
      effectFn();
    } finally {
      activeSignalConsumer = prev;
    }
  };
  runner();
  return {
    destroy() {
      destroyed = true;
    },
  };
}

export class InjectionToken<T> {
  readonly desc: string;
  constructor(desc: string) {
    this.desc = desc;
  }
}

export class DestroyRef {
  private callbacks: Array<() => void> = [];
  onDestroy(cb: () => void): () => void {
    this.callbacks.push(cb);
    return () => {
      const idx = this.callbacks.indexOf(cb);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }
  destroy(): void {
    for (const cb of this.callbacks.splice(0)) {
      cb();
    }
  }
}

export function makeEnvironmentProviders(providers: any[]) {
  return { providers };
}

export function inject<T>(token: any, optionsOrDefault?: any): T | null {
  if (currentVueScope && currentVueScope.provides.has(token)) {
    return currentVueScope.provides.get(token);
  }
  const isAngularOptions =
    optionsOrDefault &&
    typeof optionsOrDefault === 'object' &&
    'optional' in optionsOrDefault;

  if (!currentInjectorMap) {
    if (isAngularOptions && optionsOrDefault.optional) return null;
    if (arguments.length >= 2 && !isAngularOptions) return optionsOrDefault;
    throw new Error('inject() must be called from an injection context');
  }
  if (currentInjectorMap.has(token)) {
    const entry = currentInjectorMap.get(token);
    return typeof entry === 'function' ? entry() : entry;
  }
  if (isAngularOptions && optionsOrDefault.optional) return null;
  if (arguments.length >= 2 && !isAngularOptions) return optionsOrDefault;
  throw new Error(`No provider for ${token?.desc || token?.name || String(token)}`);
}

export function runWithAngularProviders<T>(
  envProvidersList: Array<{ providers: any[] }>,
  destroyRef: DestroyRef | null,
  fn: () => T,
): T {
  const map = new Map<any, any>();
  if (destroyRef) {
    map.set(DestroyRef, destroyRef);
  }
  for (const env of envProvidersList) {
    for (const p of env.providers || []) {
      if ('useFactory' in p) {
        map.set(p.provide, p.useFactory);
      } else if ('useValue' in p) {
        map.set(p.provide, () => p.useValue);
      }
    }
  }
  const prev = currentInjectorMap;
  currentInjectorMap = map;
  try {
    return fn();
  } finally {
    currentInjectorMap = prev;
  }
}

export class Observable<T> {
  private _subscribe: (subscriber: any) => (() => void) | void;

  constructor(subscribe?: (subscriber: any) => (() => void) | void) {
    this._subscribe = subscribe || (() => {});
  }

  subscribe(
    nextOrObserver?: ((value: T) => void) | { next?: (v: T) => void; error?: (e: any) => void; complete?: () => void } | null,
    error?: ((e: any) => void) | null,
    complete?: (() => void) | null,
  ) {
    let closed = false;
    let teardown: (() => void) | void;

    const observer =
      typeof nextOrObserver === 'object' && nextOrObserver !== null
        ? nextOrObserver
        : {
            next: nextOrObserver ?? undefined,
            error: error ?? undefined,
            complete: complete ?? undefined,
          };

    const subscriber = {
      get closed() {
        return closed;
      },
      next(val: T) {
        if (!closed && observer.next) observer.next(val);
      },
      error(err: any) {
        if (!closed) {
          closed = true;
          if (observer.error) observer.error(err);
          if (typeof teardown === 'function') teardown();
        }
      },
      complete() {
        if (!closed) {
          closed = true;
          if (observer.complete) observer.complete();
          if (typeof teardown === 'function') teardown();
        }
      },
      unsubscribe() {
        if (!closed) {
          closed = true;
          if (typeof teardown === 'function') teardown();
        }
      },
    };

    teardown = this._subscribe(subscriber);
    return {
      get closed() {
        return closed;
      },
      unsubscribe() {
        subscriber.unsubscribe();
      },
    };
  }
}

// ============================================================================
// 3. Vue 3 Composition API & EffectScope Runtime for Unit Tests
// ============================================================================

interface VueScope {
  cleanups: Array<() => void>;
  provides: Map<any, any>;
}

let currentVueScope: VueScope | null = null;
let activeVueWatcher: (() => void) | null = null;

export function ref<T>(initialValue?: T) {
  let val = initialValue as T;
  const subs = new Set<() => void>();
  const r = {
    __v_isRef: true,
    get value(): T {
      if (activeVueWatcher) {
        subs.add(activeVueWatcher);
      }
      return val;
    },
    set value(next: T) {
      if (!Object.is(val, next)) {
        val = next;
        for (const sub of Array.from(subs)) {
          sub();
        }
      }
    },
  };
  return r;
}

export function shallowRef<T>(initialValue?: T) {
  return ref<T>(initialValue);
}

export function readonly<T extends object>(target: T): Readonly<T> {
  return target;
}

export function watch(
  source: any,
  cb: (newVal: any, oldVal: any) => void,
  _options?: { immediate?: boolean; deep?: boolean },
): () => void {
  const sources = Array.isArray(source) ? source : [source];
  let stopped = false;

  const readSources = () =>
    sources.map((s) => {
      if (typeof s === 'function') return s();
      if (s && typeof s === 'object' && 'value' in s) return s.value;
      return s;
    });

  let oldValues: any[];
  const runner = () => {
    if (stopped) return;
    const prev = activeVueWatcher;
    activeVueWatcher = runner;
    let nextValues: any[];
    try {
      nextValues = readSources();
    } finally {
      activeVueWatcher = prev;
    }
    const prevValues = oldValues;
    oldValues = nextValues;
    cb(
      Array.isArray(source) ? nextValues : nextValues[0],
      Array.isArray(source) ? prevValues : prevValues?.[0],
    );
  };

  // Initial dependency tracking pass
  const prev = activeVueWatcher;
  activeVueWatcher = runner;
  try {
    oldValues = readSources();
  } finally {
    activeVueWatcher = prev;
  }

  return () => {
    stopped = true;
  };
}

export function getCurrentScope() {
  return currentVueScope ?? undefined;
}

export function onScopeDispose(fn: () => void) {
  if (currentVueScope) {
    currentVueScope.cleanups.push(fn);
  }
}

export function provide<T>(key: any, value: T): void {
  if (currentVueScope) {
    currentVueScope.provides.set(key, value);
  }
}

export function runInVueScope<T>(fn: () => T): { result: T; stopScope: () => void } {
  const scope: VueScope = {
    cleanups: [],
    provides: new Map(currentVueScope?.provides),
  };
  const prev = currentVueScope;
  currentVueScope = scope;
  let result: T;
  try {
    result = fn();
  } finally {
    currentVueScope = prev;
  }
  return {
    result,
    stopScope() {
      for (const cleanup of scope.cleanups.splice(0)) {
        cleanup();
      }
    },
  };
}


