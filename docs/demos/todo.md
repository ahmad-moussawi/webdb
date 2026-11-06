# Demo: Todo List

<DemoBanner demo="todo" />

A todo app where **the database is the only state**. The list and the counters are two independent
[live queries](/guides/live-queries-and-frameworks); add, tick, rename or delete an item (here or in another tab)
and both update on their own.

<ClientOnly>
  <DemoFrame demo="todo" />
</ClientOnly>

## How it works

### 1. A live query for the list

`useLiveQuery` runs the query, subscribes to every table it reads, and re-runs it when one changes. Passing
`[filter, search]` also re-runs it when those refs change:

```ts
const { data: todos } = useLiveQuery(
  () => db.from('todos')
        .where('done', '=', 0)                 // when filter === 'active'
        .whereContains('title', search.value)
        .orderBy('id', 'desc'),
  [filter, search],
  { db },
);
```

### 2. A second live query for the counters

```ts
const { data: stats } = useLiveQuery(
  () => db.from('todos').groupBy('done').count('id', 'n'),
  { db },
);
// -> [{ done: 0, n: 3 }, { done: 1, n: 1 }]
```

### 3. Plain writes, no manual refresh

```ts
await db.insert('todos', { title, done: 0, created_at: new Date().toISOString() });
await db.update('todos', id, { done: 1 });
await db.delete('todos', id);
await db.from('todos').where('done', '=', 1).delete();   // "Clear completed"
```

Nothing re-fetches after a write. The live queries above see the change and update the UI.

### 4. Schema and storage

```ts
const db = await WebDB.open({ name: 'demo_todo', storage: 'idb' });

await db.createTable('todos', [
  { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
  { name: 'title', type: 'TEXT', notNull: true },
  { name: 'done', type: 'INT32', notNull: true },   // 0 | 1
  { name: 'created_at', type: 'TEXT', notNull: true },
]);
```

## Source code

| File | What it does |
| :-- | :-- |
| [`todo/TodoApp.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/todo/TodoApp.vue) | The Vue component with the live queries |
| [`todo/db.ts`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/todo/db.ts) | Schema, seed data, queries and writes |
| [`DemoFrame.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/DemoFrame.vue) | Opens the IndexedDB database and renders the app |

👉 [**Browse the full source on GitHub**](https://github.com/ahmad-moussawi/webdb/tree/main/docs/.vitepress/theme/demos/todo)

**Next:** [Kanban board](./kanban) · [Calendar](./calendar) · [Typo-Tolerant Search with UDFs](./search)
