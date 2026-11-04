declare module '@angular/core' {
  export type Signal<T> = () => T;

  export interface WritableSignal<T> extends Signal<T> {
    set(value: T): void;
    update(updateFn: (value: T) => T): void;
    asReadonly(): Signal<T>;
  }

  export function signal<T>(initialValue: T): WritableSignal<T>;
  export function computed<T>(computation: () => T): Signal<T>;

  export interface DestroyRef {
    onDestroy(callback: () => void): () => void;
  }

  export const DestroyRef: ProviderToken<DestroyRef>;

  export interface EffectRef {
    destroy(): void;
  }

  export interface CreateEffectOptions {
    injector?: Injector;
    manualCleanup?: boolean;
    allowSignalWrites?: boolean;
  }

  export function effect(
    effectFn: (onCleanup: (cleanupFn: () => void) => void) => void,
    options?: CreateEffectOptions,
  ): EffectRef;

  export interface Injector {
    get<T>(token: ProviderToken<T>, notFoundValue?: T): T;
  }

  export class InjectionToken<T> {
    constructor(desc: string, options?: { providedIn?: 'root' | null; factory: () => T });
  }

  export type ProviderToken<T> = InjectionToken<T> | (abstract new (...args: any[]) => T);

  export interface InjectOptions {
    optional?: boolean;
    skipSelf?: boolean;
    self?: boolean;
    host?: boolean;
  }

  export function inject<T>(token: ProviderToken<T>): T;
  export function inject<T>(token: ProviderToken<T>, options: InjectOptions & { optional: true }): T | null;
  export function inject<T>(token: ProviderToken<T>, options: InjectOptions): T | null;

  export type Provider = any;
  export type EnvironmentProviders = { __brand?: 'EnvironmentProviders' };
  export function makeEnvironmentProviders(providers: Provider[]): EnvironmentProviders;
}

declare module 'rxjs' {
  export interface NextObserver<T> {
    next?: (value: T) => void;
    error?: (err: any) => void;
    complete?: () => void;
  }

  export interface Unsubscribable {
    unsubscribe(): void;
  }

  export interface Subscription extends Unsubscribable {
    readonly closed: boolean;
  }

  export interface Subscriber<T> extends Subscription {
    next(value: T): void;
    error(err?: any): void;
    complete(): void;
  }

  export type TeardownLogic = Subscription | Unsubscribable | (() => void) | void;

  export class Observable<T> {
    constructor(subscribe?: (this: Observable<T>, subscriber: Subscriber<T>) => TeardownLogic);
    subscribe(observer?: NextObserver<T>): Subscription;
    subscribe(
      next?: ((value: T) => void) | null,
      error?: ((error: any) => void) | null,
      complete?: (() => void) | null,
    ): Subscription;
    pipe(...operations: any[]): Observable<any>;
  }
}

