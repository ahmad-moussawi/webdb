# Demo: Two Tabs, One Database

<DemoBanner demo="multi-tab" />

Two browser windows side by side, each running the same app. They share **one WebDB database**: change something in
**Tab A** and **Tab B** updates by itself, with no server, no polling and no refresh button. This is how
[live queries](/guides/live-queries-and-frameworks) behave when a user has your app open in two tabs.

<ClientOnly>
  <MultiTabDemo />
</ClientOnly>

::: tip Try this
1. Add a todo in **Tab A**: it appears in **Tab B** right away. Tick it in **Tab B**: **Tab A** follows.
2. Switch to the **Kanban board** and drag a card in one window.
3. Press **⟳** in a window to reload it: the data is still there, it lives in IndexedDB.
4. Look at the footer of each window: it shows which table changed and whether the change came from *this tab* or *another tab*.
:::

## How is this possible?

The two "browsers" are plain `<iframe>`s that load the same page. Each one is a separate browsing context, which is
exactly what a real tab is to the database. WebDB uses three platform features, with nothing extra to set up:

| Piece | What it does |
| :-- | :-- |
| **IndexedDB** | Stores the database pages once per origin. Every tab reads and writes the same data. |
| **Web Locks** (`navigator.locks`) | Makes sure only one tab writes at a time, so two tabs can never corrupt the file. |
| **`BroadcastChannel`** | After each commit the writer announces *which tables changed*. Other tabs re-run only the live queries that read those tables. |

Your component code has no sync logic at all. It is the same `useLiveQuery` you would write for a single tab:

```ts
const { data: todos } = useLiveQuery(
  () => db.from('todos').orderBy('id', 'desc'),
  { db },
);

// In any tab, anywhere:
await db.insert('todos', { title: 'Hello', done: 0, created_at: new Date().toISOString() });
// every open tab's `todos` ref updates
```

## What this is (and isn't)

::: warning Same browser only
Sync works between **tabs, windows and frames of one browser profile** on one device. Chrome and Firefox keep
separate storage, and so do two different devices, so they never see each other's data. Syncing across browsers or devices
needs a server in the middle; see [Reactivity & Offline Sync](/offline-sync) for how to build that on top of
WebDB's change events.
:::

- Each window is a real, independent page: it opens its own `WebDB` instance on the same IndexedDB database.
- On the first load, the two frames can start at the same instant on an empty database. The demo serialises "open + create tables + seed"
  with a Web Lock so the sample data is inserted exactly once. [See `DemoFrame.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/DemoFrame.vue).

## Source code

| File | What it does |
| :-- | :-- |
| [`MultiTabDemo.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/components/MultiTabDemo.vue) | Two windows side by side and the demo picker |
| [`BrowserWindow.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/components/BrowserWindow.vue) | The browser chrome (tab strip, address bar, reload) around an iframe |
| [`DemoFrame.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/DemoFrame.vue) | Opens the database, shows the live "change from another tab" activity |

👉 [**Browse the full source on GitHub**](https://github.com/ahmad-moussawi/webdb/tree/main/docs/.vitepress/theme/demos)

**Next:** [Todo list](./todo) · [Kanban board](./kanban) · [Calendar](./calendar) · [Typo-Tolerant Search with UDFs](./search)
