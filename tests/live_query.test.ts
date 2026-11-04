import React from 'react';
import { describe, it, expect } from 'vitest';
import { WebDB, createLiveQuery, liveQuery } from '../src/index.js';
import {
  WebDBProvider,
  useWebDB,
  useOptionalWebDB,
  useLiveQuery,
  useLiveQueryData,
} from '../src/react/index.js';
import {
  provideWebDB,
  injectWebDB,
  liveQuerySignal,
  liveQuery$,
  liveQueryState$,
} from '../src/angular/index.js';
import {
  provideWebDB as provideVueWebDB,
  useWebDB as useVueWebDB,
  useOptionalWebDB as useVueOptionalWebDB,
  useLiveQuery as useVueLiveQuery,
  useLiveQueryData as useVueLiveQueryData,
} from '../src/vue/index.js';
import {
  renderReactHook,
  signal,
  DestroyRef,
  runWithAngularProviders,
  ref,
  runInVueScope,
} from './helpers/framework_test_harness.js';

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('Timed out waiting for live query update'));
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

describe('Reactive Live Queries, React Hooks & Angular Signals/RxJS (tests/live_query.test.ts)', () => {
  it('1. QueryBuilder.getReferencedTables() extracts base tables, joins, and nested subqueries', async () => {
    const db = await WebDB.open({ name: 'ref_tables_test', storage: 'memory' });

    const q = db
      .from('orders')
      .join('customers', 'orders.customer_id', '=', 'customers.id')
      .select({
        'orders.id': 'id',
        badgeCount: db
          .from('badges')
          .where('badges.user_id', '=', 1)
          .select('count(*)'),
      })
      .whereIn(
        'orders.region_id',
        db.from('active_regions').select('id'),
      );

    expect(q.getReferencedTables().sort()).toEqual([
      'active_regions',
      'badges',
      'customers',
      'orders',
    ]);

    await db.close();
  });

  it('2. createLiveQuery automatically tracks tables from QueryBuilder and updates only when watched tables change', async () => {
    const db = await WebDB.open({ name: 'live_query_basic', storage: 'memory' });
    await db.createTable('todos', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'title', type: 'TEXT' },
      { name: 'done', type: 'INT32' },
    ]);
    await db.createTable('unrelated_logs', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'msg', type: 'TEXT' },
    ]);

    await db.insert('todos', { title: 'Write live query', done: 0 });

    let emissionCount = 0;
    const live = createLiveQuery(
      () => db.from('todos').where('done', '=', 0).orderBy('id', 'asc'),
      { initialData: [] },
    );

    live.subscribe((state) => {
      if (!state.isLoading) {
        emissionCount++;
      }
    });

    await waitForCondition(() => !live.getState().isLoading);
    expect(live.getState().data).toEqual([
      { id: 1, title: 'Write live query', done: 0 },
    ]);
    const initialEmissions = emissionCount;

    // 1. Mutating an unrelated table does NOT re-run the live query
    await db.insert('unrelated_logs', { msg: 'ignored event' });
    await new Promise((r) => setTimeout(r, 30));
    expect(emissionCount).toBe(initialEmissions);

    // 2. Inserting into 'todos' automatically re-runs the live query
    await db.insert('todos', { title: 'Ship React & Angular exports', done: 0 });
    await waitForCondition(() => live.getState().data?.length === 2);
    expect(live.getState().data).toEqual([
      { id: 1, title: 'Write live query', done: 0 },
      { id: 2, title: 'Ship React & Angular exports', done: 0 },
    ]);

    // 3. Updating a todo to done=1 removes it from the filtered live query
    await db.update('todos', 1, { done: 1 });
    await waitForCondition(() => live.getState().data?.length === 1);
    expect(live.getState().data).toEqual([
      { id: 2, title: 'Ship React & Angular exports', done: 0 },
    ]);

    // 4. After destroy(), mutations no longer trigger updates
    live.destroy();
    await db.insert('todos', { title: 'After destroy', done: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(live.getState().data).toHaveLength(1);

    await db.close();
  });

  it('3. createLiveQuery tracks joined tables and custom async multi-query functions', async () => {
    const db = await WebDB.open({ name: 'live_query_joins', storage: 'memory' });
    await db.createTable('authors', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'name', type: 'TEXT' },
    ]);
    await db.createTable('posts', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'author_id', type: 'INT32' },
      { name: 'title', type: 'TEXT' },
    ]);

    await db.insert('authors', { id: 1, name: 'Alice' });
    await db.insert('posts', { id: 10, author_id: 1, title: 'Hello WebDB' });

    const live = createLiveQuery(async () => {
      const rows = await db
        .from('posts')
        .join('authors', 'posts.author_id', '=', 'authors.id')
        .select('posts.title as title', 'authors.name as author')
        .toArray();
      const countRow = await db.from('authors').count('*', 'total').first();
      return { rows, authorCount: Number(countRow?.total ?? 0) };
    });

    await waitForCondition(() => !live.getState().isLoading);
    expect(live.getState().data).toEqual({
      rows: [{ title: 'Hello WebDB', author: 'Alice' }],
      authorCount: 1,
    });

    // Mutating the joined 'authors' table triggers a live re-query
    await db.update('authors', 1, { name: 'Alice Smith' });
    await waitForCondition(
      () => live.getState().data?.rows[0]?.author === 'Alice Smith',
    );
    expect(live.getState().data).toEqual({
      rows: [{ title: 'Hello WebDB', author: 'Alice Smith' }],
      authorCount: 1,
    });

    live.destroy();
    await db.close();
  });

  it('4. React adapter (@ahmadmoussawi/webdb/react): useLiveQuery, useLiveQueryData, WebDBProvider & useWebDB', async () => {
    const db = await WebDB.open({ name: 'react_live_test', storage: 'memory' });
    await db.createTable('tasks', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'title', type: 'TEXT' },
      { name: 'status', type: 'TEXT' },
    ]);
    await db.insertMany('tasks', [
      { title: 'Task A', status: 'open' },
      { title: 'Task B', status: 'done' },
    ]);

    // 1. Verify WebDBProvider, useWebDB, and useOptionalWebDB
    const outsideHook = renderReactHook(() => useOptionalWebDB());
    expect(outsideHook.result.current).toBeNull();
    expect(() => renderReactHook(() => useWebDB())).toThrow(/useWebDB\(\) must be used within/);

    const providerWrapper = React.createElement(WebDBProvider, { db });
    const insideHook = renderReactHook(() => useWebDB(), undefined, {
      wrapper: providerWrapper,
    });
    expect(insideHook.result.current).toBe(db);

    // 2. Verify useLiveQuery with dependency array and live table mutations
    const hook = renderReactHook(
      (props: { status: string }) =>
        useLiveQuery(
          () =>
            db
              .from('tasks')
              .where('status', '=', props.status)
              .orderBy('id', 'asc'),
          [props.status],
          { initialData: [] },
        ),
      { status: 'open' },
      { wrapper: providerWrapper },
    );

    // Initially loading with initialData = []
    expect(hook.result.current.data).toEqual([]);
    await waitForCondition(() => !hook.result.current.isLoading);
    expect(hook.result.current.data).toEqual([
      { id: 1, title: 'Task A', status: 'open' },
    ]);

    // Mutate table -> hook updates automatically
    await db.insert('tasks', { title: 'Task C', status: 'open' });
    await waitForCondition(() => hook.result.current.data?.length === 2);
    expect(hook.result.current.data).toEqual([
      { id: 1, title: 'Task A', status: 'open' },
      { id: 3, title: 'Task C', status: 'open' },
    ]);

    // Change React dependency prop (`status: 'done'`) -> re-runs query with new filter
    hook.rerender({ status: 'done' });
    await waitForCondition(
      () =>
        !hook.result.current.isLoading &&
        hook.result.current.data?.[0]?.title === 'Task B',
    );
    expect(hook.result.current.data).toEqual([
      { id: 2, title: 'Task B', status: 'done' },
    ]);

    // 3. Verify useLiveQueryData concise hook
    const dataHook = renderReactHook(
      () =>
        useLiveQueryData(
          () => db.from('tasks').orderBy('id', 'asc'),
          [],
          [],
        ),
      undefined,
      { wrapper: providerWrapper },
    );
    await waitForCondition(() => (dataHook.result.current?.length ?? 0) === 3);
    expect(dataHook.result.current).toHaveLength(3);

    // Unmount cleans up subscriptions
    hook.unmount();
    dataHook.unmount();
    await db.insert('tasks', { title: 'Task D', status: 'done' });
    await new Promise((r) => setTimeout(r, 30));
    expect(hook.result.current.data).toHaveLength(1);
    expect(dataHook.result.current).toHaveLength(3);

    await db.close();
  });

  it('5. Angular adapter (@ahmadmoussawi/webdb/angular): liveQuerySignal, liveQuery$, liveQueryState$, provideWebDB & injectWebDB', async () => {
    const db = await WebDB.open({ name: 'angular_live_test', storage: 'memory' });
    await db.createTable('items', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'name', type: 'TEXT' },
      { name: 'category', type: 'TEXT' },
    ]);
    await db.insertMany('items', [
      { name: 'Laptop', category: 'tech' },
      { name: 'Desk', category: 'office' },
    ]);

    const destroyRef = new DestroyRef();
    const envProviders = provideWebDB(db);

    // 1. Test provideWebDB, injectWebDB, and liveQuerySignal with Angular Signal reactivity
    const categorySignal = signal('tech');
    const liveSig = runWithAngularProviders(
      [envProviders as any],
      destroyRef,
      () => {
        const injected = injectWebDB();
        expect(injected).toBe(db);
        return liveQuerySignal(
          () =>
            injected
              .from('items')
              .where('category', '=', categorySignal())
              .orderBy('id', 'asc'),
          { initialData: [] },
        );
      },
    );

    await waitForCondition(() => !liveSig.isLoading());
    expect(liveSig.error()).toBeNull();
    expect(liveSig.data()).toEqual([
      { id: 1, name: 'Laptop', category: 'tech' },
    ]);

    // Mutate WebDB table -> Angular Signal updates automatically
    await db.insert('items', { name: 'Monitor', category: 'tech' });
    await waitForCondition(() => liveSig.data()?.length === 2);
    expect(liveSig.data()).toEqual([
      { id: 1, name: 'Laptop', category: 'tech' },
      { id: 3, name: 'Monitor', category: 'tech' },
    ]);

    // Update Angular Signal (`categorySignal.set('office')`) -> liveQuerySignal automatically re-evaluates!
    categorySignal.set('office');
    await waitForCondition(
      () => liveSig.data()?.length === 1 && liveSig.data()?.[0]?.name === 'Desk',
    );
    expect(liveSig.data()).toEqual([
      { id: 2, name: 'Desk', category: 'office' },
    ]);

    // 2. Test RxJS liveQuery$ and liveQueryState$
    const receivedLists: any[][] = [];
    const obs$ = liveQuery$(() => db.from('items').orderBy('id', 'asc'));
    const sub = obs$.subscribe((rows) => {
      receivedLists.push(rows);
    });

    await waitForCondition(() => receivedLists.length >= 1);
    expect(receivedLists[receivedLists.length - 1]).toHaveLength(3);

    await db.insert('items', { name: 'Chair', category: 'office' });
    await waitForCondition(() => receivedLists.length >= 2);
    expect(receivedLists[receivedLists.length - 1]).toHaveLength(4);

    // Unsubscribe RxJS stream and trigger Angular DestroyRef
    sub.unsubscribe();
    destroyRef.destroy();

    const countBefore = receivedLists.length;
    await db.insert('items', { name: 'Lamp', category: 'office' });
    await new Promise((r) => setTimeout(r, 30));
    expect(receivedLists.length).toBe(countBefore);
    expect(liveSig.data()).toEqual([
      { id: 2, name: 'Desk', category: 'office' },
      { id: 4, name: 'Chair', category: 'office' },
    ]);

    // Also verify liveQueryState$
    const states: any[] = [];
    const stateSub = liveQueryState$(() => db.from('items').count('*', 'cnt').first()).subscribe(
      (s) => states.push(s),
    );
    await waitForCondition(() => states.some((s) => !s.isLoading));
    expect(states[states.length - 1].data).toEqual({ cnt: 5 });
    stateSub.unsubscribe();

    await db.close();
  });

  it('6. Plain JavaScript helpers: QueryBuilder.live(), db.liveQuery(), liveQuery() & AsyncIterable (for await...of)', async () => {
    const db = await WebDB.open({ name: 'plain_js_live_test', storage: 'memory' });
    await db.createTable('notes', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'text', type: 'TEXT' },
      { name: 'pinned', type: 'INT32' },
    ]);
    await db.insert('notes', { text: 'First note', pinned: 1 });

    // 1. Chainable QueryBuilder.live(callback)
    const snapshots: any[][] = [];
    const qbLive = db
      .from('notes')
      .where('pinned', '=', 1)
      .orderBy('id', 'asc')
      .live((rows) => {
        snapshots.push(rows);
      });

    await waitForCondition(() => snapshots.length >= 1);
    expect(snapshots[0]).toEqual([{ id: 1, text: 'First note', pinned: 1 }]);

    await db.insert('notes', { text: 'Second pinned', pinned: 1 });
    await waitForCondition(() => snapshots.length >= 2);
    expect(snapshots[snapshots.length - 1]).toEqual([
      { id: 1, text: 'First note', pinned: 1 },
      { id: 2, text: 'Second pinned', pinned: 1 },
    ]);
    qbLive.destroy();

    // 2. db.liveQuery() & AsyncIterable (`for await (const rows of query)`)
    const iterSnapshots: any[][] = [];
    const asyncQuery = db.liveQuery(() =>
      db.from('notes').orderBy('id', 'asc'),
    );

    const consumerPromise = (async () => {
      for await (const rows of asyncQuery) {
        iterSnapshots.push(rows);
        if (rows.length >= 3) {
          break; // breaking out of `for await` automatically cleans up and destroys the live query
        }
      }
    })();

    await waitForCondition(() => iterSnapshots.length >= 1);
    expect(iterSnapshots[0]).toHaveLength(2);

    await db.insert('notes', { text: 'Third note triggers break', pinned: 0 });
    await consumerPromise;
    expect(iterSnapshots[iterSnapshots.length - 1]).toHaveLength(3);

    // Verify breaking from `for await` cleaned up the subscription
    await db.insert('notes', { text: 'Fourth note after break', pinned: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(iterSnapshots).toHaveLength(2);

    // 3. Standalone liveQuery(queryFn, callback)
    const standaloneResults: any[] = [];
    const standalone = liveQuery(
      () => db.from('notes').count('*', 'total').first(),
      (row) => standaloneResults.push(row),
    );
    await waitForCondition(() => standaloneResults.length >= 1);
    expect(standaloneResults[0]).toEqual({ total: 4 });
    standalone.destroy();

    await db.close();
  });

  it('7. Vue.js adapter (@ahmadmoussawi/webdb/vue): useLiveQuery, useLiveQueryData, provideWebDB & useWebDB', async () => {
    const db = await WebDB.open({ name: 'vue_live_test', storage: 'memory' });
    await db.createTable('products', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'title', type: 'TEXT' },
      { name: 'inStock', type: 'INT32' },
    ]);
    await db.insertMany('products', [
      { title: 'Keyboard', inStock: 1 },
      { title: 'Mouse', inStock: 0 },
    ]);

    // 1. Outside scope without provider
    expect(useVueOptionalWebDB()).toBeNull();
    expect(() => useVueWebDB()).toThrow(/useWebDB\(\) found no provided WebDB/);

    const stockFilter = ref(1);

    // 2. Inside Vue effectScope / component setup with provideWebDB
    const scope = runInVueScope(() => {
      provideVueWebDB(db);
      const injected = useVueWebDB();
      expect(injected).toBe(db);

      const query = useVueLiveQuery(
        () =>
          injected
            .from('products')
            .where('inStock', '=', stockFilter.value)
            .orderBy('id', 'asc'),
        [stockFilter],
        { initialData: [] },
      );

      const allData = useVueLiveQueryData(
        () => injected.from('products').orderBy('id', 'asc'),
        [],
        [],
      );

      return { query, allData };
    });

    const { query, allData } = scope.result;
    expect(query.data.value).toEqual([]);

    await waitForCondition(() => !query.isLoading.value && (allData.value?.length ?? 0) === 2);
    expect(query.error.value).toBeNull();
    expect(query.data.value).toEqual([
      { id: 1, title: 'Keyboard', inStock: 1 },
    ]);
    expect(allData.value).toHaveLength(2);

    // 3. Mutate WebDB table -> Vue refs update automatically
    await db.insert('products', { title: 'Headset', inStock: 1 });
    await waitForCondition(() => query.data.value?.length === 2);
    expect(query.data.value).toEqual([
      { id: 1, title: 'Keyboard', inStock: 1 },
      { id: 3, title: 'Headset', inStock: 1 },
    ]);
    await waitForCondition(() => allData.value?.length === 3);

    // 4. Mutate Vue reactive `ref` (`stockFilter.value = 0`) -> re-runs query automatically
    stockFilter.value = 0;
    await waitForCondition(
      () =>
        query.data.value?.length === 1 &&
        query.data.value?.[0]?.title === 'Mouse',
    );
    expect(query.data.value).toEqual([
      { id: 2, title: 'Mouse', inStock: 0 },
    ]);

    // 5. Disposing the Vue scope automatically stops live queries
    scope.stopScope();
    await db.insert('products', { title: 'Webcam', inStock: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(query.data.value).toHaveLength(1);
    expect(allData.value).toHaveLength(3);

    await db.close();
  });
});
