import React from 'react';
import { describe, it, expect } from 'vitest';
import { WebDB, createLiveQuery, liveQuery, MemoryVfsAdapter } from '../src/index.js';
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

  it('8. Bug 1 regression: createLiveQuery & liveQuerySignal re-subscribe when switching WebDB instances with identical schemas', async () => {
    const db1 = await WebDB.open({ name: 'multi_company_1', storage: 'memory' });
    const db2 = await WebDB.open({ name: 'multi_company_2', storage: 'memory' });

    for (const db of [db1, db2]) {
      await db.createTable('categories', [
        { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
        { name: 'name', type: 'TEXT' },
      ]);
      await db.createTable('items', [
        { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
        { name: 'category_id', type: 'INT32' },
        { name: 'title', type: 'TEXT' },
      ]);
    }

    await db1.insert('categories', { name: 'Beverages (Company 1)' });
    await db1.insert('items', { category_id: 1, title: 'Coffee' });

    await db2.insert('categories', { name: 'Hardware (Company 2)' });
    await db2.insert('items', { category_id: 1, title: 'Wrench' });

    const destroyRef = new DestroyRef();
    const activeDb = signal<WebDB>(db1);
    let executionCount = 0;

    // Provide db1 in DI as well to verify switching to db2 overrides the fallback DI instance
    const liveSig = runWithAngularProviders(
      [provideWebDB(db1) as any],
      destroyRef,
      () =>
        liveQuerySignal(
          async () => {
            const db = activeDb();
            executionCount++;
            const categories = await db.from('categories').orderBy('id', 'asc').toArray();
            const items = await db.from('items').orderBy('id', 'asc').toArray();
            return { categories, items };
          },
          { initialData: { categories: [], items: [] } },
        ),
    );

    await waitForCondition(() => !liveSig.isLoading() && liveSig.data()?.categories.length === 1);
    expect(liveSig.data()).toEqual({
      categories: [{ id: 1, name: 'Beverages (Company 1)' }],
      items: [{ id: 1, category_id: 1, title: 'Coffee' }],
    });

    // Mutate db1 -> liveSig updates
    await db1.insert('items', { category_id: 1, title: 'Tea' });
    await waitForCondition(() => liveSig.data()?.items.length === 2);
    expect(liveSig.data()?.items.map((i: any) => i.title)).toEqual(['Coffee', 'Tea']);

    // Switch activeDb signal from db1 -> db2
    activeDb.set(db2);
    await waitForCondition(
      () =>
        liveSig.data()?.categories[0]?.name === 'Hardware (Company 2)' &&
        liveSig.data()?.items.length === 1,
    );
    expect(liveSig.data()).toEqual({
      categories: [{ id: 1, name: 'Hardware (Company 2)' }],
      items: [{ id: 1, category_id: 1, title: 'Wrench' }],
    });

    const countAfterSwitch = executionCount;

    // Mutating db1 (old instance) must NOT trigger re-execution now that we are subscribed to db2
    await db1.insert('items', { category_id: 1, title: 'Juice' });
    await new Promise((r) => setTimeout(r, 30));
    expect(executionCount).toBe(countAfterSwitch);

    // Mutating db2 (new instance) MUST trigger live query update!
    await db2.insert('items', { category_id: 1, title: 'Hammer' });
    await waitForCondition(() => liveSig.data()?.items.length === 2);
    expect(liveSig.data()?.items.map((i: any) => i.title)).toEqual(['Wrench', 'Hammer']);

    await db2.insert('categories', { name: 'Power Tools (Company 2)' });
    await waitForCondition(() => liveSig.data()?.categories.length === 2);

    // Switch back from db2 -> db1 and verify re-subscription to db1
    activeDb.set(db1);
    await waitForCondition(
      () => liveSig.data()?.categories[0]?.name === 'Beverages (Company 1)',
    );
    expect(liveSig.data()?.items.map((i: any) => i.title)).toEqual([
      'Coffee',
      'Tea',
      'Juice',
    ]);

    await db1.insert('categories', { name: 'Bakery (Company 1)' });
    await waitForCondition(() => liveSig.data()?.categories.length === 2);

    destroyRef.destroy();
    await db1.close();
    await db2.close();
  });

  it('9. Bug 2a regression: concurrent liveQuerySignals and background queries do NOT cross-contaminate table subscriptions', async () => {
    const db = await WebDB.open({ name: 'concurrent_trackers_test', storage: 'memory' });
    await db.createTable('categories', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'name', type: 'TEXT' },
    ]);
    await db.createTable('items', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'name', type: 'TEXT' },
    ]);
    await db.createTable('orders', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'total', type: 'FLOAT64' },
    ]);
    await db.createTable('audit_logs', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'action', type: 'TEXT' },
    ]);
    await db.createTable('inventory_transactions', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'delta', type: 'INT32' },
    ]);

    await db.insert('categories', { name: 'Cat 1' });
    await db.insert('items', { name: 'Item 1' });
    await db.insert('orders', { total: 50 });
    await db.insert('audit_logs', { action: 'init' });
    await db.insert('inventory_transactions', { delta: 10 });

    let categoriesRuns = 0;
    let itemsRuns = 0;
    let multiStepOrdersRuns = 0;

    // Launch 3 concurrent live queries AND background non-live queries on audit_logs / inventory_transactions simultaneously
    const categoriesLive = createLiveQuery(async () => {
      categoriesRuns++;
      return db.from('categories').orderBy('id', 'asc').toArray();
    });

    const itemsLive = createLiveQuery(async () => {
      itemsRuns++;
      return db.from('items').orderBy('id', 'asc').toArray();
    });

    const multiStepOrdersLive = createLiveQuery(async () => {
      multiStepOrdersRuns++;
      const orders = await db.from('orders').orderBy('id', 'asc').toArray();
      const firstItem = await db.from('items').orderBy('id', 'asc').first();
      return { orders, firstItem };
    });

    // Interleave background reads while the live queries above are in flight awaiting the lease queue
    const bgAuditPromise = db.from('audit_logs').toArray();
    const bgInvPromise = db.from('inventory_transactions').toArray();

    await Promise.all([bgAuditPromise, bgInvPromise]);
    await waitForCondition(
      () =>
        !categoriesLive.getState().isLoading &&
        !itemsLive.getState().isLoading &&
        !multiStepOrdersLive.getState().isLoading,
    );

    expect(categoriesRuns).toBe(1);
    expect(itemsRuns).toBe(1);
    expect(multiStepOrdersRuns).toBe(1);

    // 1. Mutating `audit_logs` or `inventory_transactions` must NOT trigger ANY of the live queries
    await db.insert('audit_logs', { action: 'user_login' });
    await db.insert('inventory_transactions', { delta: -2 });
    await new Promise((r) => setTimeout(r, 30));

    expect(categoriesRuns).toBe(1);
    expect(itemsRuns).toBe(1);
    expect(multiStepOrdersRuns).toBe(1);

    // 2. Mutating `orders` must ONLY trigger `multiStepOrdersLive`, NOT `categoriesLive` or `itemsLive`
    await db.insert('orders', { total: 75 });
    await waitForCondition(() => multiStepOrdersRuns === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(categoriesRuns).toBe(1);
    expect(itemsRuns).toBe(1);
    expect(multiStepOrdersRuns).toBe(2);

    // 3. Mutating `items` must trigger `itemsLive` and `multiStepOrdersLive` (which read `items` after its first await), NOT `categoriesLive`
    await db.insert('items', { name: 'Item 2' });
    await waitForCondition(() => itemsRuns === 2 && multiStepOrdersRuns === 3);
    await new Promise((r) => setTimeout(r, 20));
    expect(categoriesRuns).toBe(1);

    // 4. Mutating `categories` must ONLY trigger `categoriesLive`
    await db.insert('categories', { name: 'Cat 2' });
    await waitForCondition(() => categoriesRuns === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(itemsRuns).toBe(2);
    expect(multiStepOrdersRuns).toBe(3);

    categoriesLive.destroy();
    itemsLive.destroy();
    multiStepOrdersLive.destroy();
    await db.close();
  });

  it('10. Bug 2b & 2c regression: explicit options.tables is authoritative, and explicit refresh() after mutation never resolves early with stale data', async () => {
    const db = await WebDB.open({ name: 'authoritative_tables_and_refresh', storage: 'memory' });
    await db.createTable('categories', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'name', type: 'TEXT' },
    ]);
    await db.createTable('audit_logs', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'msg', type: 'TEXT' },
    ]);

    await db.insert('categories', { name: 'Initial Category' });
    await db.insert('audit_logs', { msg: 'boot' });

    let runCount = 0;
    const destroyRef = new DestroyRef();
    const liveSig = runWithAngularProviders(
      [provideWebDB(db) as any],
      destroyRef,
      () =>
        liveQuerySignal(
          async () => {
            runCount++;
            const cats = await db.from('categories').orderBy('id', 'asc').toArray();
            // Even though queryFn reads `audit_logs`, explicit `{ tables: ['categories'] }` must be authoritative!
            const logs = await db.from('audit_logs').toArray();
            return cats.map((c) => ({ ...c, logCount: logs.length }));
          },
          { tables: ['categories'], initialData: [] },
        ),
    );

    await waitForCondition(() => !liveSig.isLoading());
    expect(liveSig.data()).toEqual([
      { id: 1, name: 'Initial Category', logCount: 1 },
    ]);
    expect(runCount).toBe(1);

    // 1. Mutating `audit_logs` must NOT re-trigger `liveSig` because `options.tables: ['categories']` is authoritative
    await db.insert('audit_logs', { msg: 'should be ignored' });
    await new Promise((r) => setTimeout(r, 30));
    expect(runCount).toBe(1);

    // 2. Immediately calling `await liveSig.refresh()` right after a mutation on `categories`
    // must resolve with the fresh post-mutation data (never early with stale `state.data`).
    await db.insert('categories', { name: 'Second Category' });
    const refreshedData = await liveSig.refresh();

    expect(refreshedData).toEqual([
      { id: 1, name: 'Initial Category', logCount: 2 },
      { id: 2, name: 'Second Category', logCount: 2 },
    ]);
    expect(liveSig.data()).toEqual(refreshedData);

    // 3. If a first refresh() is superseded mid-flight by a newer run (while state.data is still stale with 2 items),
    // awaiting the first refresh() waits for the superseding run and returns the latest 3 items instead of stale state.data.
    await db.insert('categories', { name: 'Third Category' });
    const p1 = liveSig.refresh();
    const p2 = liveSig.refresh();
    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1).toHaveLength(3);
    expect(res2).toHaveLength(3);
    expect(res1?.[2]?.name).toBe('Third Category');
    expect(liveSig.data()).toHaveLength(3);

    destroyRef.destroy();
    await db.close();
  });

  it('11. Ticket 2 regression: trackLiveQueryPromise preserves active tracker across Promise.all, .then() chains, and direct WebDB read methods', async () => {
    const db = await WebDB.open({ name: 'promise_all_continuation_test', storage: 'memory' });
    await db.createTable('table_a', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'val', type: 'TEXT' },
    ]);
    await db.createTable('table_b', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'val', type: 'TEXT' },
    ]);
    await db.createTable('table_c', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'val', type: 'TEXT' },
    ]);
    await db.createTable('table_d', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'val', type: 'TEXT' },
    ]);
    await db.createTable('unrelated_noise', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'val', type: 'TEXT' },
    ]);

    await db.insert('table_a', { val: 'A1' });
    await db.insert('table_b', { val: 'B1' });
    await db.insert('table_c', { val: 'C1' });
    await db.insert('table_d', { val: 'D1' });
    await db.insert('unrelated_noise', { val: 'N1' });

    let runCount = 0;
    const destroyRef = new DestroyRef();
    const liveSig = runWithAngularProviders(
      [provideWebDB(db) as any],
      destroyRef,
      () =>
        liveQuerySignal(
          async () => {
            runCount++;
            // Step 1: Parallel reads via Promise.all
            const [rowsA, rowsB] = await Promise.all([
              db.from('table_a').orderBy('id', 'asc').toArray(),
              db.from('table_b').orderBy('id', 'asc').toArray(),
            ]);

            // Step 2: Sequential read AFTER Promise.all via QueryBuilder + .then()
            const rowsC = await db
              .from('table_c')
              .orderBy('id', 'asc')
              .toArray()
              .then((r) => r.map((x) => x.val));

            // Step 3: Direct WebDB read method (executeQuery) AFTER the .then() chain
            const rowsD = await db.executeQuery('table_d', [], {
              limit: null,
              offset: null,
              sortCol: 'id',
              sortDir: 'asc',
            });

            return {
              a: rowsA.map((r) => r.val),
              b: rowsB.map((r) => r.val),
              c: rowsC,
              d: rowsD.map((r) => r.val),
            };
          },
          { initialData: { a: [], b: [], c: [], d: [] } },
        ),
    );

    // Interleave an unrelated background query while the initial run is in flight
    await db.from('unrelated_noise').toArray();

    await waitForCondition(() => !liveSig.isLoading());
    expect(liveSig.data()).toEqual({
      a: ['A1'],
      b: ['B1'],
      c: ['C1'],
      d: ['D1'],
    });
    expect(runCount).toBe(1);

    // 1. Mutating unrelated_noise must NOT trigger re-execution
    await db.insert('unrelated_noise', { val: 'N2' });
    await new Promise((r) => setTimeout(r, 30));
    expect(runCount).toBe(1);

    // 2. Mutating table_c (queried AFTER await Promise.all) MUST trigger re-execution
    await db.insert('table_c', { val: 'C2' });
    await waitForCondition(() => liveSig.data()?.c.length === 2);
    expect(liveSig.data()?.c).toEqual(['C1', 'C2']);
    expect(runCount).toBe(2);

    // 3. Mutating table_d (queried via direct db.executeQuery AFTER .then()) MUST trigger re-execution
    await db.insert('table_d', { val: 'D2' });
    await waitForCondition(() => liveSig.data()?.d.length === 2);
    expect(liveSig.data()?.d).toEqual(['D1', 'D2']);
    expect(runCount).toBe(3);

    // 4. Mutating table_a and table_b (inside Promise.all) also triggers re-execution
    await db.insert('table_a', { val: 'A2' });
    await waitForCondition(() => liveSig.data()?.a.length === 2);
    expect(liveSig.data()?.a).toEqual(['A1', 'A2']);

    destroyRef.destroy();
    await db.close();
  });

  it('12. Ticket 3 regression: WebDB.importBinary() notifies active local & cross-tab subscriptions (including empty DB reset)', async () => {
    const sharedVfs = new MemoryVfsAdapter();
    Object.defineProperty(sharedVfs, 'name', { value: 'idb_shared_sim' });

    const dbA = await WebDB.open({ name: 'import_live_db', vfs: sharedVfs });
    const dbB = await WebDB.open({ name: 'import_live_db', vfs: sharedVfs });

    await dbA.createTable('users', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'name', type: 'TEXT' },
    ]);
    await dbA.insert('users', { name: 'Initial Alice' });

    // Prepare a second database snapshot to import (with updated users + a new table)
    const stagingDb = await WebDB.open({ name: 'staging_import', storage: 'memory' });
    await stagingDb.createTable('users', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'name', type: 'TEXT' },
    ]);
    await stagingDb.insertMany('users', [
      { name: 'Imported Bob' },
      { name: 'Imported Charlie' },
    ]);
    const populatedBinary = await stagingDb.exportBinary();
    await stagingDb.close();

    // Also prepare a completely empty database binary snapshot (0 tables)
    const emptyStagingDb = await WebDB.open({ name: 'empty_staging', storage: 'memory' });
    const emptyBinary = await emptyStagingDb.exportBinary();
    await emptyStagingDb.close();

    // 1. Subscribe liveQuerySignal on dbA (local instance) and createLiveQuery on dbB (cross-tab instance)
    const destroyRef = new DestroyRef();
    const localSig = runWithAngularProviders(
      [provideWebDB(dbA) as any],
      destroyRef,
      () =>
        liveQuerySignal(
          () => dbA.from('users').orderBy('id', 'asc'),
          { initialData: [] },
        ),
    );

    const crossTabUsersLive = createLiveQuery(
      () => dbB.from('users').orderBy('id', 'asc'),
      { initialData: [] },
    );

    const schemaTablesLive = createLiveQuery(
      async () => {
        const tables = await dbA.listTables();
        return tables.map((t) => t.name);
      },
      { initialData: [] },
    );

    await waitForCondition(
      () =>
        !localSig.isLoading() &&
        !crossTabUsersLive.getState().isLoading &&
        !schemaTablesLive.getState().isLoading,
    );
    expect(localSig.data()).toEqual([{ id: 1, name: 'Initial Alice' }]);
    expect(crossTabUsersLive.getState().data).toEqual([{ id: 1, name: 'Initial Alice' }]);
    expect(schemaTablesLive.getState().data).toEqual(['users']);

    // 2. Call dbA.importBinary(populatedBinary) -> both localSig (dbA) and crossTabUsersLive (dbB) must update!
    await dbA.importBinary(populatedBinary);

    await waitForCondition(
      () =>
        localSig.data()?.length === 2 &&
        crossTabUsersLive.getState().data?.length === 2,
    );
    expect(localSig.data()).toEqual([
      { id: 1, name: 'Imported Bob' },
      { id: 2, name: 'Imported Charlie' },
    ]);
    expect(localSig.state().lastEvent?.origin).toBe('import');
    expect(localSig.state().lastEvent?.crossTab).toBe(false);

    expect(crossTabUsersLive.getState().data).toEqual([
      { id: 1, name: 'Imported Bob' },
      { id: 2, name: 'Imported Charlie' },
    ]);
    expect(crossTabUsersLive.getState().lastEvent?.origin).toBe('import');
    expect(crossTabUsersLive.getState().lastEvent?.crossTab).toBe(true);

    // 3. Import the empty binary snapshot (0 tables) into a fresh DB watched by schemaTablesLive
    // and verify even when post-import tables is empty, subscribers are notified!
    await dbA.importBinary(emptyBinary);
    await waitForCondition(() => schemaTablesLive.getState().data?.length === 0);
    expect(schemaTablesLive.getState().data).toEqual([]);

    // Even importing emptyBinary AGAIN (when both oldTables and newTables are empty: tables.length === 0)
    // must still notify active subscribers on importBinary!
    let emptyToEmptyEvents = 0;
    const unsubWildcard = dbA.subscribe('*', (ev) => {
      if (ev.origin === 'import') {
        emptyToEmptyEvents++;
      }
    });
    await dbA.importBinary(emptyBinary);
    expect(emptyToEmptyEvents).toBe(1);
    unsubWildcard();

    destroyRef.destroy();
    crossTabUsersLive.destroy();
    schemaTablesLive.destroy();
    await dbA.close();
    await dbB.close();
  });
});
