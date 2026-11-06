# Demo: Kanban Board

<DemoBanner demo="kanban" />

A Trello-style board with drag &amp; drop. Three live queries (lists, cards, per-list counts) keep the board in
sync; every drop is saved as **one atomic transaction** that renumbers the source and target lists.

<ClientOnly>
  <DemoFrame demo="kanban" />
</ClientOnly>

::: tip Touch devices
Drag &amp; drop uses the browser's native HTML5 API. On touch screens use the **move-to** dropdown on each card.
:::

## How it works

### 1. Live queries drive the whole board

```ts
const { data: lists }  = useLiveQuery(() => db.from('lists').orderBy('position'), { db });
const { data: cards }  = useLiveQuery(
  () => db.from('cards').orderBy('list_id').orderBy('position'), { db });
const { data: counts } = useLiveQuery(
  () => db.from('cards').groupBy('list_id').count('id', 'n'), { db });
```

The board is just `cards` grouped by `list_id` in a `computed`. There is no local copy of the data to keep in sync.

### 2. A drop is one transaction

Moving a card means renumbering `position` in up to two lists. Wrapping it in `db.transaction()` makes it
atomic, so every live query (and every other open tab) sees **one** consistent change, never a half-moved card:

```ts
await db.transaction(async (tx) => {
  const card = await tx.from('cards').where('id', '=', cardId).first();
  const target = (await tx.from('cards').where('list_id', '=', toListId)
                          .orderBy('position').toArray()).filter((c) => c.id !== cardId);
  target.splice(toIndex, 0, { ...card, list_id: toListId });

  for (const [i, c] of target.entries()) {
    await tx.update('cards', c.id, { list_id: toListId, position: i });
  }
  // ...then close the gap in the source list
});
```

### 3. Schema

```ts
await db.createTable('lists', [
  { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
  { name: 'title', type: 'TEXT', notNull: true },
  { name: 'position', type: 'INT32', notNull: true },
]);
await db.createTable('cards', [
  { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
  { name: 'list_id', type: 'INT32', notNull: true, indexed: true },
  { name: 'title', type: 'TEXT', notNull: true },
  { name: 'position', type: 'INT32', notNull: true },
]);
```

## Source code

| File | What it does |
| :-- | :-- |
| [`kanban/KanbanApp.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/kanban/KanbanApp.vue) | The board, drag &amp; drop and live queries |
| [`kanban/db.ts`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/kanban/db.ts) | Schema, seed data, queries and `moveCard()` |
| [`DemoFrame.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/DemoFrame.vue) | Opens the IndexedDB database and renders the app |

👉 [**Browse the full source on GitHub**](https://github.com/ahmad-moussawi/webdb/tree/main/docs/.vitepress/theme/demos/kanban)

**Next:** [Calendar](./calendar) · [Typo-Tolerant Search with UDFs](./search) · [Todo list](./todo)
