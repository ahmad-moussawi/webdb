# Reactive Live Queries (Plain JS, React, Vue & Angular)

::: tip ⚡ See it running
Try live queries in the browser, with data kept in IndexedDB. Open a demo in two tabs and watch them sync:

- **[Todo list →](/demos/todo)**: filters, search and live counters from a `GROUP BY` query
- **[Kanban board →](/demos/kanban)**: drag & drop, each move saved as one transaction
- **[Calendar →](/demos/calendar)**: loads only the visible month, plus "upcoming" and counters
- **[Typo-Tolerant Search with UDFs →](/demos/search)**: a query that re-runs as you type

Each demo links to its full source on GitHub.
:::

WebDB includes first-class **reactive live queries** that automatically keep your UI in sync with your database. Whenever rows are inserted, updated, or deleted—whether in the current tab, a background Web Worker, or another open browser tab—active live queries automatically re-execute and push fresh results to your components.

---

## Why WebDB Live Queries?

- **Automatic Table Dependency Tracking:** You don't have to manually list table names. WebDB inspects your `QueryBuilder` (including `JOIN`s, `WHERE IN` subqueries, derived tables, and multi-query `async` functions) and subscribes only to the exact tables your query reads.
- **Zero Bundle Bloat via Subpath Exports:** Framework helpers are published as tiny, tree-shakeable subpath exports (`< 1 KB` gzipped each) with optional peer dependencies. Importing `@ahmadmoussawi/webdb` in a plain JS or React app never pulls in Angular or Vue code.
- **Cross-Tab & Worker Reactivity Built In:** Mutations committed in another browser tab or Web Worker automatically invalidate stale cached pages over `BroadcastChannel` and trigger live query refreshes.

| Environment | Package Import | Primary Helpers | Gzipped Size |
| :--- | :--- | :--- | :--- |
| **Plain JS / TS** | `@ahmadmoussawi/webdb` | `qb.live()`, `db.liveQuery()`, `liveQuery()`, `for await...of` | Built-in |
| **React 18+** | `@ahmadmoussawi/webdb/react` | `useLiveQuery()`, `useLiveQueryData()`, `<WebDBProvider>` | `~0.7 KB` |
| **Vue 3+** | `@ahmadmoussawi/webdb/vue` | `useLiveQuery()`, `useLiveQueryData()`, `provideWebDB()` | `~0.9 KB` |
| **Angular 16+** | `@ahmadmoussawi/webdb/angular` | `liveQuerySignal()`, `liveQuery$()`, `provideWebDB()` | `~0.9 KB` |

---

## 1. Plain JavaScript & TypeScript (`@ahmadmoussawi/webdb`)

No framework is required to use live queries. Every `QueryBuilder` chain supports `.live()`, and every `WebDB` instance provides `db.liveQuery()`.

### Chainable `QueryBuilder.live()`

```typescript
import { WebDB } from '@ahmadmoussawi/webdb';

const db = await WebDB.open({ name: 'tasks_db', storage: 'idb' });

// Automatically watches 'tasks' and re-runs whenever 'tasks' changes
const liveTasks = db
  .from('tasks')
  .where('done', '=', 0)
  .orderBy('priority', 'desc')
  .live((rows, state) => {
    console.log('Active tasks:', rows);
    console.log('Last updated at:', state.lastUpdated);
  });

// Manually force a refresh if needed:
await liveTasks.refresh();

// Clean up subscription when done:
liveTasks.destroy();
```

### Multi-Query Functions with `db.liveQuery()`

When you need to combine multiple queries (or transform rows in JavaScript), pass an `async` function to `db.liveQuery()` or the standalone `liveQuery()` helper. WebDB tracks every table read during execution:

```typescript
import { liveQuery } from '@ahmadmoussawi/webdb';

const dashboardQuery = liveQuery(
  async () => {
    const recentOrders = await db
      .from('orders')
      .join('customers', 'orders.customer_id', '=', 'customers.id')
      .select('orders.id as id', 'customers.name as customer', 'orders.total as total')
      .orderBy('orders.id', 'desc')
      .limit(10)
      .toArray();

    const stats = await db.from('orders').count('*', 'count').sum('total', 'revenue').first();

    return { recentOrders, stats };
  },
  ({ recentOrders, stats }) => {
    renderDashboard(recentOrders, stats);
  },
  { debounceMs: 16 }, // Optional debounce for high-frequency bulk writes
);
```

### Async Iteration (`for await ... of`)

Every `LiveQueryController` implements `AsyncIterable<T>`, allowing you to consume live database updates using standard `for await...of` loops. Breaking out of the loop automatically unsubscribes and destroys the live query:

```typescript
for await (const todos of db.from('todos').where('done', '=', 0).live()) {
  renderTodoList(todos);

  if (todos.length === 0) {
    break; // Automatically cleans up database listeners
  }
}
```

---

## 2. React Integration (`@ahmadmoussawi/webdb/react`)

Import React hooks from `@ahmadmoussawi/webdb/react`.

### `useLiveQuery` & `useLiveQueryData`

```tsx
import { useState } from 'react';
import { useLiveQuery, useLiveQueryData } from '@ahmadmoussawi/webdb/react';
import { db } from './db';

export function TodoList() {
  const [statusFilter, setStatusFilter] = useState<'open' | 'done'>('open');

  // Full state hook: { data, isLoading, error, lastUpdated, lastEvent, refresh }
  const { data: todos, isLoading, error, refresh } = useLiveQuery(
    () =>
      db
        .from('todos')
        .where('status', '=', statusFilter)
        .orderBy('id', 'desc'),
    [statusFilter], // Re-runs when statusFilter changes OR when 'todos' table is mutated
    { initialData: [] },
  );

  // Concise data-only hook: returns T | undefined directly
  const totalCount = useLiveQueryData(
    () => db.from('todos').count('*', 'total').first(),
    [],
    { total: 0 },
  );

  if (isLoading) return <p>Loading todos...</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <div>
      <h3>Total Todos: {totalCount?.total ?? 0}</h3>
      <button onClick={() => setStatusFilter(statusFilter === 'open' ? 'done' : 'open')}>
        Filter: {statusFilter}
      </button>
      <ul>
        {todos?.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
    </div>
  );
}
```

### Sharing `WebDB` via `<WebDBProvider>` and `useWebDB()`

```tsx
import { WebDBProvider, useWebDB } from '@ahmadmoussawi/webdb/react';

export function App({ db }) {
  return (
    <WebDBProvider db={db}>
      <TodoList />
    </WebDBProvider>
  );
}

function AddTodoButton() {
  const db = useWebDB();
  return (
    <button onClick={() => db.insert('todos', { title: 'New task', status: 'open' })}>
      Add Task
    </button>
  );
}
```

---

## 3. Vue 3 Integration (`@ahmadmoussawi/webdb/vue`)

Import Vue 3 composables from `@ahmadmoussawi/webdb/vue`. Subscriptions are automatically cleaned up via `onScopeDispose` when the component or `effectScope` unmounts.

### `useLiveQuery` & `useLiveQueryData`

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useLiveQuery, useLiveQueryData } from '@ahmadmoussawi/webdb/vue';
import { db } from './db';

const category = ref('work');

// Returns readonly Vue Refs: { data, isLoading, error, lastUpdated, lastEvent, refresh, stop }
const { data: notes, isLoading, error } = useLiveQuery(
  () =>
    db
      .from('notes')
      .where('category', '=', category.value)
      .orderBy('id', 'desc'),
  [category], // Watches Vue Refs/ComputedRefs automatically
  { initialData: [] },
);

// Concise Ref<T | undefined> helper
const allNotes = useLiveQueryData(
  () => db.from('notes').orderBy('id', 'desc'),
  [],
  [],
);
</script>

<template>
  <select v-model="category">
    <option value="work">Work</option>
    <option value="personal">Personal</option>
  </select>

  <p v-if="isLoading">Loading...</p>
  <p v-else-if="error">{{ error.message }}</p>
  <ul v-else>
    <li v-for="note in notes" :key="note.id">{{ note.title }}</li>
  </ul>
</template>
```

### Dependency Injection with `provideWebDB` & `useWebDB`

```typescript
// In main.ts (app-level) or a root component's <script setup>:
import { createApp } from 'vue';
import { provideWebDB } from '@ahmadmoussawi/webdb/vue';

const app = createApp(App);
provideWebDB(db, app);

// Inside any child component <script setup>:
import { useWebDB } from '@ahmadmoussawi/webdb/vue';
const db = useWebDB();
```

---

## 4. Angular Integration (`@ahmadmoussawi/webdb/angular`)

Import Angular Signals, RxJS Observables, and DI helpers from `@ahmadmoussawi/webdb/angular`.

### Angular Signals: `liveQuerySignal()`

`liveQuerySignal()` integrates natively with Angular Signals and `DestroyRef`. Any Angular `Signal` read synchronously inside `queryFn` is automatically tracked via `effect()`—so updating a filter signal or mutating a WebDB table both update `todos.data()` seamlessly!

```typescript
import { Component, signal } from '@angular/core';
import { provideWebDB, injectWebDB, liveQuerySignal } from '@ahmadmoussawi/webdb/angular';

@Component({
  selector: 'app-todo-list',
  standalone: true,
  template: `
    @if (todos.isLoading()) {
      <p>Loading...</p>
    } @else {
      <ul>
        @for (todo of todos.data(); track todo.id) {
          <li>{{ todo.title }}</li>
        }
      </ul>
    }
  `,
})
export class TodoListComponent {
  private db = injectWebDB();

  status = signal<'open' | 'done'>('open');

  // Re-runs automatically when this.status() changes OR when 'todos' table is modified
  todos = liveQuerySignal(
    () =>
      this.db
        .from('todos')
        .where('status', '=', this.status())
        .orderBy('id', 'desc'),
    { initialData: [] },
  );
}
```

### RxJS Streams: `liveQuery$()` & `liveQueryState$()`

Prefer RxJS streams with Angular's `| async` pipe, `switchMap`, or `combineLatest`? Use `liveQuery$()`:

```typescript
import { Component } from '@angular/core';
import { BehaviorSubject, switchMap } from 'rxjs';
import { injectWebDB, liveQuery$ } from '@ahmadmoussawi/webdb/angular';

@Component({
  selector: 'app-orders',
  template: `
    @for (order of orders$ | async; track order.id) {
      <div>{{ order.customer }} — ${{ order.total }}</div>
    }
  `,
})
export class OrdersComponent {
  private db = injectWebDB();
  minTotal$ = new BehaviorSubject<number>(50);

  orders$ = this.minTotal$.pipe(
    switchMap((minTotal) =>
      liveQuery$(() =>
        this.db.from('orders').where('total', '>=', minTotal).orderBy('total', 'desc'),
      ),
    ),
  );
}
```

---

## 5. `LiveQueryOptions` Reference

All live query helpers accept an optional `LiveQueryOptions<T>` configuration object:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`initialData`** | `T` | `undefined` | Initial value for `data` before the first query execution finishes. |
| **`debounceMs`** | `number` | `0` (microtask) | Coalesces rapid bursts of table mutations before re-executing the query. |
| **`tables`** | `string \| string[] \| '*'` | Auto-inferred | Explicit table names to watch in addition to automatically tracked tables. |
| **`db`** | `WebDB` | Auto-inferred | Explicit `WebDB` instance (inferred automatically from `QueryBuilder` or framework DI). |
| **`onError`** | `(err: Error) => void` | `undefined` | Callback invoked if `queryFn` throws or rejects. |
| **`autoStart`** | `boolean` | `true` | Whether to run the initial query immediately upon creation. |

