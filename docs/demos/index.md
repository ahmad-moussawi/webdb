# Live Demos

Real apps running **right now, in your browser**, on WebDB with **IndexedDB** storage. Every list, board and
calendar below is driven by [live queries](/guides/live-queries-and-frameworks): nobody calls `refresh()`, the UI
just re-renders whenever the data it queries changes.

<div class="demo-cards">

<a class="demo-card" href="./todo">
  <h3>✅ Todo list</h3>
  <p>The classic. Filters, search, inline editing and live counters from a <code>GROUP BY</code> query.</p>
</a>

<a class="demo-card" href="./kanban">
  <h3>🗂️ Kanban board</h3>
  <p>A Trello-style board with drag &amp; drop. Each drop is one atomic transaction.</p>
</a>

<a class="demo-card" href="./calendar">
  <h3>📅 Calendar &amp; appointments</h3>
  <p>A month view that only loads the visible range, plus "upcoming" and per-month counters.</p>
</a>

<a class="demo-card" href="./search">
  <h3>🔎 Typo-Tolerant Search with UDFs</h3>
  <p>Ranking, typo tolerance, accent-insensitive matching and highlights, written as plain JavaScript functions.</p>
</a>

</div>

## Try this

1. Open any demo, change something, then **reload the page**: your data is still there (IndexedDB).
2. Open the same demo in **two tabs side by side** and edit in one: the other updates instantly, because live
   queries listen to changes across tabs.
3. Click **Reset data** at the top of a demo to restore the sample data.

## What they demonstrate

| Capability | Where |
| :-- | :-- |
| `useLiveQuery()` from `@ahmadmoussawi/webdb/vue` | all demos |
| Reactive inputs (filter, search, month) re-running a query | Todo, Calendar |
| Several independent live queries on the same tables | all demos |
| `GROUP BY` / `COUNT` aggregates kept up to date | Todo, Kanban, Calendar |
| Atomic multi-row writes with `db.transaction()` | Kanban, resets |
| Indexed range queries (`start_at >= … AND < …`) | Calendar |
| JavaScript UDFs in `SELECT`, `WHERE` and `ORDER BY` | Search |
| Cross-tab sync over `BroadcastChannel` | all demos |

The demos are plain Vue 3 components with no state library: the database *is* the state. Each page links to
the full source on GitHub.

::: tip No API, no server: your data lives in your browser
Every demo stores its data in your browser's IndexedDB (`webdb_demo_todo`, `webdb_demo_kanban`,
`webdb_demo_calendar`, `webdb_demo_search`). There is no backend and nothing is ever sent anywhere.
Change something, **refresh the page**, and it is still there.
:::

<style>
.demo-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  margin: 1.5rem 0;
}
.demo-card {
  display: block;
  padding: 1rem 1.2rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  text-decoration: none !important;
  color: var(--vp-c-text-1) !important;
  transition: border-color 0.2s, transform 0.2s;
}
.demo-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}
.demo-card h3 {
  margin: 0 0 0.4rem;
  padding: 0;
  border: none;
  font-size: 1.05rem;
}
.demo-card p {
  margin: 0;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}
</style>
