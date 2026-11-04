declare module 'vue' {
  export interface Ref<T = any> {
    value: T;
  }

  export type ShallowRef<T = any> = Ref<T>;

  export interface ComputedRef<T = any> extends Readonly<Ref<T>> {
    readonly value: T;
  }

  export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T);
  export type WatchStopHandle = () => void;

  export interface InjectionKey<T> extends Symbol {}

  export function ref<T>(value: T): Ref<T>;
  export function ref<T = any>(): Ref<T | undefined>;
  export function shallowRef<T>(value: T): ShallowRef<T>;
  export function shallowRef<T = any>(): ShallowRef<T | undefined>;
  export function readonly<T extends object>(target: T): Readonly<T>;
  export function watch(
    source: WatchSource | WatchSource[] | object,
    cb: (newValue: any, oldValue: any) => void,
    options?: { immediate?: boolean; deep?: boolean; flush?: 'pre' | 'post' | 'sync' },
  ): WatchStopHandle;
  export function getCurrentScope(): { cleanups?: Array<() => void> } | undefined;
  export function onScopeDispose(fn: () => void, failSilently?: boolean): void;
  export function provide<T>(key: InjectionKey<T> | string | symbol, value: T): void;
  export function inject<T>(key: InjectionKey<T> | string | symbol): T | undefined;
  export function inject<T>(
    key: InjectionKey<T> | string | symbol,
    defaultValue: T,
    treatDefaultAsFactory?: false,
  ): T;
}

