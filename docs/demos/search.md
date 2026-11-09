# Demo: Instant Typo-Tolerant Search

<DemoBanner demo="search" />

WebDB features an official, browser-native search extension via **`@ahmadmoussawi/webdb/search`**. Instead of bundling megabytes of heavy C search libraries or creating complex shadow tables, it leverages modern web platform primitives (`Intl.Segmenter` for word segmentation, Unicode normalization for accent stripping, and bounded Damerau-Levenshtein distance) paired with WebDB's query builder and vectorized execution.

This demo demonstrates **multi-field relevance ranking, typo tolerance, accent-insensitive matching, and highlighted snippets**, all driven in real time by a **[live query](/guides/live-queries-and-frameworks)** as you type.

<ClientOnly>
  <DemoFrame demo="search" />
</ClientOnly>

::: tip Things to try
- **`reactve`** finds *"reactive"* (typo tolerance). Untick the box and it finds nothing.
- **`cafe`** finds *"Café-style caching"* (accents are ignored, in both directions).
- **`index perf`**: every word must match; titles outrank tags, tags outrank body text.
- **`persist`** matches *persistent*, *persistence*… (prefix match).
- Open **Add an article**, add "Quantum notes", then search `quantum`: the result appears as soon as it is saved.
:::

---

## How It Works

### 1. Initialize `SearchIndex` on Your Table

Define a `SearchIndex` coordinator pointing to your existing table:

```ts
import { WebDB } from '@ahmadmoussawi/webdb';
import { createSearchIndex } from '@ahmadmoussawi/webdb/search';

const db = await WebDB.open({ name: 'demo_search', storage: 'idb' });

// Create a search index over the articles table
export const articleSearch = createSearchIndex(db, {
  table: 'articles',
  fields: [
    { name: 'title', weight: 10, highlight: true },
    { name: 'tags', weight: 5 },
    { name: 'body', weight: 1, snippet: true },
  ],
  idField: 'id',
});
```

Key features configured here:
- **Zero Storage Overhead**: No separate shadow tables or index tables are created. It queries your existing `articles` table directly.
- **Field Weights**: Matches in `title` (weight 10) outrank matches in `tags` (weight 5), which outrank `body` (weight 1).
- **Automated Highlighting & Snippets**: Setting `highlight: true` generates safe `<mark>` tags around matches, while `snippet: true` extracts a bounded contextual excerpt (~140 characters).
- **Always 100% in Sync**: Because it operates directly over table rows, new inserts or edits are searchable immediately without background re-indexing.

---

### 2. Build Search Queries with Filters

`articleSearch.buildQuery()` returns WebDB's standard `QueryBuilder`, making it easy to compose search with regular SQL-like filters:

```ts
// Returns a QueryBuilder ready for execution or live query binding:
const query = articleSearch.buildQuery(searchQueryText, {
  fuzzy: true,   // enables typo tolerance (e.g. "reactve" -> "reactive")
  prefix: true,  // enables prefix matching (e.g. "persist" -> "persistent")
  filter: (qb) => category ? qb.where('category', '=', category) : qb,
  limit: 20,
});
```

WebDB's query planner uses any existing B+Tree index (such as an index on `category`) to narrow down candidate rows first, running fuzzy scoring only on the matching subset.

---

### 3. Make It Reactive with Live Queries

Pass `buildQuery()` directly to `useLiveQuery`. The UI updates automatically as the user types or toggles search options:

```ts
import { useLiveQuery } from '@ahmadmoussawi/webdb/vue'; // or /react, /angular

const { data: results } = useLiveQuery(
  () =>
    articleSearch.buildQuery(debouncedQuery.value, {
      fuzzy: fuzzy.value,
      filter: (qb) => (category.value ? qb.where('category', '=', category.value) : qb),
    }),
  [debouncedQuery, fuzzy, category],
  { db }
);
```

Every returned row automatically includes:
- `row._search_score`: The computed relevance score (used for `ORDER BY _search_score DESC`).
- `row._search_hl_title`: The highlighted title HTML with `<mark>` tags around matches.
- `row._search_snip_body`: The truncated body snippet centered around the matched keywords.

---

### 4. Under the Hood: Vectorized UDFs & Native Opcodes

Under the hood, `SearchIndex` compiles to WebDB's search extension helpers (`multiFuzzyScore`, `highlightExpr`, `snippetExpr`). 

- **Vectorized UDF Batching**: Scoring is dispatched across rows in power-of-two batches (128 rows per chunk) to eliminate per-row JavaScript call frame overhead.
- **Native VDBE Opcodes**: Core filters can also leverage WebDB's native bytecode opcodes (`OP_STR_FUZZY_MATCH` `0x44` and `OP_STR_LEVENSHTEIN` `0x45`) to run typo-matching inside C/Wasm linear memory.
- **Low-Level Custom Queries**: If you prefer building custom expressions manually instead of using `SearchIndex`, you can call `registerFuzzySearch(db)` and write custom queries with `fuzzy()`, `fuzzy_score()`, `bm25_score()`, or `ngram_similarity()`.

---

## Source Code

| File | What it does |
| :-- | :-- |
| [`search/db.ts`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/search/db.ts) | Schema, seed articles, and search query integration with `@ahmadmoussawi/webdb/search` |
| [`search/SearchApp.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/search/SearchApp.vue) | The Vue component with live query reactivity, filters, and snippet rendering |
| [`DemoFrame.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/DemoFrame.vue) | Opens the IndexedDB database and mounts the demo |

👉 [**Browse the full demo source on GitHub**](https://github.com/ahmad-moussawi/webdb/tree/main/docs/.vitepress/theme/demos/search)

Learn more in the [Fuzzy & Typo-Tolerant Search Guide](/guides/fuzzy-search) and [Expressions, Functions & UDFs](/guides/expressions-and-functions).

**Next:** [Todo list](./todo) · [Kanban board](./kanban) · [Calendar](./calendar)
