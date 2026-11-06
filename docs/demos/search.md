# Demo: Typo-Tolerant Search with UDFs

WebDB has no built-in full-text engine, on purpose. Instead you write the search logic in plain JavaScript and
register it as a **user-defined function (UDF)**, then call it from `SELECT`, `WHERE` and `ORDER BY` like any
built-in function. This demo builds a small search engine that way: **ranking, typo tolerance, accent-insensitive
matching, highlighted snippets**, all re-run by a [live query](/guides/live-queries-and-frameworks) as you type.

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

## How it works

### 1. Write the search logic as plain functions

Each UDF is an ordinary synchronous function. This is the heart of it: a relevance score where every query word
must match, with exact words beating prefixes, and prefixes beating typos:

```ts
export function relevance(title, body, tags, query, fuzzy) {
  const tokens = words(query);                    // lower-cased, accents stripped
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    const inTitle = best(words(title), token, fuzzy);   // 0 none, 1 typo, 2 prefix, 3 exact
    const inTags  = best(words(tags),  token, fuzzy);
    const inBody  = best(words(body),  token, fuzzy);
    if (!inTitle && !inTags && !inBody) return 0;       // every word must match somewhere
    total += TITLE_WEIGHT[inTitle] + TAG_WEIGHT[inTags] + BODY_WEIGHT[inBody];
  }
  return total;
}
```

Accent-insensitivity is one line of built-in browser API, no library needed:

```ts
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
```

Typo tolerance is a small bounded Levenshtein function ([`withinEdits`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/search/udfs.ts)),
and `highlight()` / `snippet()` wrap matches in `<mark>` after HTML-escaping the text, so the result is safe to render.

### 2. Register them once

```ts
const db = await WebDB.open({ name: 'demo_search', storage: 'idb' });

db.registerFunction('relevance', relevance);
db.registerFunction('highlight', highlight);
db.registerFunction('snippet', snippet);
db.registerFunction('word_count', wordCount);
```

::: warning UDFs live in memory
Registered functions are not stored in the database. Register them on every page load, before you query.
:::

### 3. Call them from a query

UDFs work in `SELECT`, `WHERE` and `ORDER BY`, and mix freely with normal filters. Pass the user's text as a
**literal** (so quotes and symbols are harmless), not by building SQL strings:

```ts
const lit = (value) => new ExpressionBuilder({ type: 'literal', value });
const score = fn('relevance', col('title'), col('body'), col('tags'), lit(q), lit(1));

db.from('articles')
  .select(['id', 'title', 'category',
           fn('highlight', col('title'), lit(q), lit(1)).as('title_html'),   // UDF in SELECT
           fn('snippet',   col('body'),  lit(q), lit(1)).as('snippet_html'),
           score.as('score')])
  .where(score.gt(0))                                                         // UDF in WHERE
  .where('category', '=', category)                                           // normal filter
  .orderBy('score', 'desc');                                                  // sort by the UDF result
```

### 4. Make it live

Wrap the query in `useLiveQuery` and pass the inputs as dependencies. Typing, toggling an option, switching category,
or adding an article in another tab all re-run it:

```ts
const { data: results } = useLiveQuery(
  () => searchQuery(db, { q: debounced.value, fuzzy: fuzzy.value, category: category.value }),
  [debounced, fuzzy, category],
  { db },
);
```

::: tip When is this the right approach?
UDF search runs in your JavaScript for every candidate row, which is perfect for thousands of records, small
catalogues, notes, settings or command palettes. For millions of rows you would pre-filter with an indexed column
(like the `category` filter above) so the UDF only sees a small slice.
:::

## Source code

| File | What it does |
| :-- | :-- |
| [`search/udfs.ts`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/search/udfs.ts) | The UDFs: normalise, fuzzy match, `relevance`, `highlight`, `snippet`, `word_count` |
| [`search/db.ts`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/search/db.ts) | Schema, seed articles and the `searchQuery()` builder |
| [`search/SearchApp.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/search/SearchApp.vue) | The Vue component with the live query |
| [`DemoFrame.vue`](https://github.com/ahmad-moussawi/webdb/blob/main/docs/.vitepress/theme/demos/DemoFrame.vue) | Opens the IndexedDB database and renders the app |

👉 [**Browse the full source on GitHub**](https://github.com/ahmad-moussawi/webdb/tree/main/docs/.vitepress/theme/demos/search)

Learn more about UDFs in [Expressions, Functions & UDFs](/guides/expressions-and-functions).

**Next:** [Todo list](./todo) · [Kanban board](./kanban) · [Calendar](./calendar)
