# Demo: Calendar & Appointments

A month calendar backed by a single `appointments` table. The grid only loads the **visible range**, and three
independent live queries (the grid, "upcoming" and a month counter) all stay current as you add, edit or delete
appointments.

<ClientOnly>
  <DemoFrame demo="calendar" />
</ClientOnly>

::: tip How to use it
Click a day to select it, **double-click** (or press **+ New**) to add an appointment, and click any appointment
to edit or delete it. Use the arrows to change month.
:::

## How it works

### 1. Query only what is on screen

Appointments store a sortable local timestamp (`'YYYY-MM-DD HH:mm'`) with an index, so a month view is a cheap
range scan. Changing the `month` ref re-runs the query:

```ts
const { data: appointments } = useLiveQuery(
  () => {
    const { from, to } = gridRange(month.value);       // the 6x7 visible grid
    return db.from('appointments')
             .where('start_at', '>=', from)
             .where('start_at', '<', to)
             .orderBy('start_at');
  },
  [month],
  { db },
);
```

### 2. More live queries on the same table

```ts
// "Upcoming", independent of the month on screen
useLiveQuery(() => db.from('appointments')
                     .where('start_at', '>=', now).orderBy('start_at').limit(5), { db });

// Aggregate for the "N this month" badge
useLiveQuery(() => db.from('appointments')
                     .whereStartsWith('start_at', '2026-11-').count('id', 'n'), [month], { db });
```

Adding an appointment on any day (even in a month you are not looking at) updates "upcoming" and the counter
without any extra code.

### 3. Schema

```ts
await db.createTable('appointments', [
  { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
  { name: 'title', type: 'TEXT', notNull: true },
  { name: 'start_at', type: 'TEXT', notNull: true, indexed: true },
  { name: 'end_at', type: 'TEXT', notNull: true },
  { name: 'color', type: 'TEXT', notNull: true },
  { name: 'notes', type: 'TEXT', notNull: true },
]);
```

## Source code

| File | What it does |
| :-- | :-- |
| [`calendar/CalendarApp.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/calendar/CalendarApp.vue) | Month grid, editor and live queries |
| [`calendar/db.ts`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/calendar/db.ts) | Schema, seed data, range queries and writes |
| [`calendar/dates.ts`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/calendar/dates.ts) | Small date helpers for the month grid |
| [`DemoFrame.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/DemoFrame.vue) | Opens the IndexedDB database and renders the app |

👉 [**Browse the full source on GitHub**](https://github.com/ahmad-moussawi/webdb/tree/main/docs/.vitepress/theme/demos/calendar)

**Next:** [Typo-Tolerant Search with UDFs](./search) · [Todo list](./todo) · [Kanban board](./kanban)
