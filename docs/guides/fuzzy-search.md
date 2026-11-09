# Fuzzy & Typo-Tolerant Search

WebDB includes an optional **browser-native fuzzy search extension** available via the `@ahmadmoussawi/webdb/search` subpath export.

- **Zero Bundle Impact**: Zero bytes added to core WebDB unless explicitly imported.
- **Zero External Dependencies**: Powered entirely by modern browser primitives (`Intl.Segmenter` for word segmentation, Unicode normalization for accent stripping, and bounded Damerau-Levenshtein distance).
- **Two Flexible Layers**:
  - **High-Level `SearchIndex`**: Automated multi-field weighting, typo-tolerance thresholds, prefix matching, snippets, and highlights.
  - **Low-Level UDFs & Expressions**: Pure functions, VDBE opcodes, and query builder helpers (`fuzzyMatch`, `multiFuzzyScore`, `highlightExpr`, `snippetExpr`) for custom SQL-like pipelines.

---

## Choosing the Right Search Method

WebDB gives you multiple search strategies depending on your performance requirements, data volume, and UI needs. Use this decision matrix to pick the right one:

| Method | Best For | Typical Use Case | Typo Tolerant? | Performance |
| :--- | :--- | :--- | :--- | :--- |
| **`createSearchIndex(db, ...)`** | Full-featured UI search | Multi-field search bars, instant search with auto-highlighting and snippets | ✅ Yes (edit distance + prefixes) | ⚡⚡ High (vectorized) |
| **Native Opcode (`.where('col', 'fuzzy', q)`)** | Ultra-fast boolean filter | Filtering large tables (10,000+ rows) directly in C/Wasm bytecode without scoring | ✅ Yes (1–2 edits) | ⚡⚡⚡ Maximum (native C/Wasm) |
| **Search UDFs (`fuzzy_score`, `search_score`)** | Custom SQL queries | Integrating fuzzy ranking with complex joins, groupings, or custom math | ✅ Yes | ⚡⚡ High (vectorized) |
| **BM25 Search (`algorithm: 'bm25'`)** | Long-form documents | Blog posts, documentation, articles where term frequency (TF-IDF) matters | ❌ Exact tokens (TF-IDF) | ⚡⚡ High (vectorized) |
| **N-Gram Similarity (`ngram_similarity`)** | Substrings & unspaced text | SKUs, serial numbers, partial codes, or CJK text (Chinese, Japanese) | ✅ Yes (n-gram overlap) | ⚡⚡ High (vectorized) |
| **`searchInMemory(items, ...)`** | Non-database arrays | Client-side dropdowns, command palettes (`Cmd+K`), navigation menus | ✅ Yes | ⚡⚡ High (in-memory) |

---

## Quickstart: High-Level `SearchIndex`

The `SearchIndex` class provides an out-of-the-box search engine that coordinates field weighting, ranking, and highlighting across multiple columns.

```ts
import { WebDB } from '@ahmadmoussawi/webdb';
import { createSearchIndex } from '@ahmadmoussawi/webdb/search';

const db = await WebDB.open({ name: 'docs_app', storage: 'idb' });

// 1. Create a search index for your table
const searchIndex = createSearchIndex(db, {
  table: 'articles',
  fields: [
    { name: 'title', weight: 10, highlight: true },
    { name: 'tags', weight: 5 },
    { name: 'body', weight: 1, snippet: true },
  ],
  idField: 'id',
});

// 2. Search with typo tolerance & prefix matching
const result = await searchIndex.search('relatinal databaes', {
  limit: 10,
  filter: (qb) => qb.where('category', '=', 'Guides'),
});

console.log(`Found ${result.total} results in ${result.durationMs.toFixed(1)}ms:`);

for (const hit of result.hits) {
  console.log(`[Score: ${hit.score}] #${hit.id}`);
  console.log('Title (Highlighted):', hit.highlights.title);
  console.log('Body (Snippet):', hit.snippets.body);
  console.log('Original Row:', hit.row);
}
```

### Reactive Search with Live Queries

`SearchIndex.buildQuery()` returns WebDB's standard `QueryBuilder`, allowing you to bind live queries that update automatically as the user types:

```ts
import { useLiveQuery } from '@ahmadmoussawi/webdb/react'; // or /vue, /angular

function SearchComponent({ query, category }) {
  const { data: results } = useLiveQuery(
    () =>
      searchIndex.buildQuery(query, {
        limit: 20,
        filter: (qb) => (category ? qb.where('category', '=', category) : qb),
      }),
    [query, category],
    { db }
  );

  return (
    <ul>
      {results?.map((row) => (
        <li key={row.id}>
          <span dangerouslySetInnerHTML={{ __html: row._search_hl_title || row.title }} />
          <p dangerouslySetInnerHTML={{ __html: row._search_snip_body || row.body }} />
        </li>
      ))}
    </ul>
  );
}
```

### Storage Architecture: Zero Storage Overhead (No Shadow Tables)

A common question when implementing search is whether `SearchIndex` requires auxiliary index tables:

> **`SearchIndex` does not require or create any separate storage tables or shadow tables.**

Unlike traditional full-text search extensions (such as SQLite's FTS5, which automatically generates 3 to 5 hidden shadow tables like `table_content` and `table_segdir`), WebDB's `SearchIndex` functions as a **virtual query coordinator**:

| Property | Traditional FTS (e.g. SQLite FTS5) | WebDB `SearchIndex` |
| :--- | :--- | :--- |
| **Storage Footprint** | Duplicates all indexed text (2x–3x database size) | **0 bytes extra storage** (queries existing table directly) |
| **Data Sync & Consistency** | Requires triggers or sync hooks; risk of drift | **Always 100% in sync** with every `INSERT`, `UPDATE`, `DELETE` |
| **Write Performance** | Writing to the table updates multiple shadow tables | **Zero write overhead** on normal transactions and WAL commits |
| **Reactivity** | Requires custom triggers or pollers | **Native reactivity** with `useLiveQuery` |
| **B+Tree Index Synergy** | Struggles to combine text search with normal indexes | **Full compatibility**; pre-filters rows using existing B+Tree indexes |

When you call `searchIndex.search(query)` or `searchIndex.buildQuery(query)`:
1. It queries your **existing table directly** (`table: 'articles'`).
2. It dynamically compiles vectorized relevance scoring (`multiFuzzyScore`), hit highlighting (`highlightExpr`), and contextual snippets (`snippetExpr`) into the query's projection and `WHERE` filter.
3. If your query includes standard filters (e.g. `.where('user_id', '=', currentUserId)` or `.where('published', '=', true)`), WebDB uses your table's existing B+Tree index to prune candidate rows first, executing search scoring only on the matching slice.

---

## Low-Level Search UDFs & Custom Queries

If you prefer building your own queries using WebDB's expression builder, you can register and invoke the search UDFs directly in `.select()`, `.where()`, and `.orderBy()`.

### 1. Register Search UDFs

Call `registerFuzzySearch(db)` once after opening your database:

```ts
import { WebDB } from '@ahmadmoussawi/webdb';
import { registerFuzzySearch } from '@ahmadmoussawi/webdb/search';

const db = await WebDB.open({ name: 'my_app', storage: 'idb' });
registerFuzzySearch(db);
```

### 2. Available Functions Reference

Calling `registerFuzzySearch(db)` registers the following UDFs into WebDB's query engine. All functions are vectorized with power-of-two batching (128 rows per chunk) for fast multi-row evaluation.

#### Matching & Relevance Scoring Functions

| Function & Signature | Return Type | When to Use | Example Expression |
| :--- | :--- | :--- | :--- |
| **`fuzzy(col, query, [fuzzy=1], [prefix=1])`** | `INT32` (1 or 0) | **Boolean Filtering**: Check whether a text column matches any token in the search query with optional typo tolerance and prefix matching. | `"fuzzy(title, 'databse') = 1"` |
| **`fuzzy_score(col, query, [weight=1], [fuzzy=1], [prefix=1])`** | `FLOAT64` | **Single-Field Ranking**: Compute a weighted relevance score for a single column. Exact matches score highest (3), followed by prefix matches (2) and typos (1). | `"fuzzy_score(name, 'alex', 10) as rank"` |
| **`search_score(query, configJson, ...cols)`** | `FLOAT64` | **Multi-Field Weighted Ranking**: Compute an aggregate relevance score across multiple columns using a JSON configuration specifying field weights. | `"search_score('engine', '{\"fields\":[{\"name\":\"title\",\"weight\":10}]}', title, body)"` |
| **`bm25_score(query, configJson, ...cols)`** | `FLOAT64` | **Document Search**: Probabilistic BM25 ranking across multiple columns for long-form articles, documentation, or notes. | `"bm25_score('database', '{}', title, body)"` |
| **`ngram_similarity(col, query, [n=3])`** | `FLOAT64` (0.0–1.0) | **Substring & Code Matching**: Calculate character n-gram overlap (Sørensen-Dice) for fuzzy substring searches, SKUs, or CJK text. | `"ngram_similarity(sku, 'A1B2') > 0.6"` |

#### UI Presentation & Text Utilities

| Function & Signature | Return Type | When to Use | Example Expression |
| :--- | :--- | :--- | :--- |
| **`highlight(text, query, [fuzzy=1], [prefix=1], [tag='mark'], [class=''])`** | `TEXT` (HTML) | **Hit Highlighting**: Wraps matched or typo-matched words with `<mark>` tags (or custom HTML tags/classes) for UI display. | `"highlight(title, 'sql') as highlighted_title"` |
| **`snippet(text, query, [fuzzy=1], [prefix=1], [size=140], [tag='mark'], ...)`** | `TEXT` (HTML) | **Contextual Snippets**: Extracts a bounded character window (default 140 chars) around the first match with an ellipsis (`…`). | `"snippet(body, 'index', 1, 1, 120) as snippet_html"` |
| **`word_count(text)`** | `INT32` | **Text Metrics**: Counts the number of words in a text column (useful for article length or reading time). | `"word_count(content) as total_words"` |
| **`normalize_text(text)`** | `TEXT` | **Text Cleaning**: Strips diacritics/accents (`Café` $\rightarrow$ `cafe`) and lowercases text for uniform comparisons. | `"normalize_text(city) = 'munchen'"` |

---

### 3. Expression Helpers in Queries

Rather than writing raw SQL strings, you can use the type-safe expression helpers (`fuzzyMatch`, `multiFuzzyScore`, `highlightExpr`, `snippetExpr`) directly with `db.from(...)`:

```ts
import {
  fuzzyMatch,
  multiFuzzyScore,
  highlightExpr,
  snippetExpr,
} from '@ahmadmoussawi/webdb/search';

const q = 'storge engine';

const score = multiFuzzyScore(
  [
    { name: 'title', weight: 10 },
    { name: 'body', weight: 1 },
  ],
  q
);

const rows = await db
  .from('articles')
  .select([
    'id',
    'title',
    highlightExpr('title', q).as('title_html'),
    snippetExpr('body', q, { size: 120 }).as('snippet_html'),
    score.as('score'),
  ])
  .where(score.gt(0))
  .where('published', '=', true)
  .orderBy('score', 'desc')
  .limit(20)
  .toArray();
```

### 4. Simple Boolean Filtering

To check whether a single column matches a query with typo tolerance:

```ts
const results = await db
  .from('products')
  .where(fuzzyMatch('name', userSearchInput))
  .toArray();
```

---

## BM25 Probabilistic Ranking

WebDB includes full support for **BM25 (Best Matching 25)**, the industry standard probabilistic relevance ranking model featuring Robertson-Spärck Jones inverse document frequency (IDF) and document length normalization.

### When to Use BM25 vs. Fuzzy Scoring
- **Use Fuzzy Scoring (`fuzzy_score` / `SearchIndex`)** for short-to-medium text fields where user typos and prefix completions are common (e.g. names, product titles, addresses, tags).
- **Use BM25 (`BM25Index` / `bm25_score`)** for long-form text (articles, documentation, support tickets, comments) where term frequency matters and rare words should score higher than common stop words.

### 1. In-Memory BM25 Search
```ts
import { searchInMemory, BM25Index } from '@ahmadmoussawi/webdb/search';

// Using searchInMemory with algorithm: 'bm25'
const results = searchInMemory(articles, 'relational engine', {
  fields: [
    { name: 'title', weight: 10, highlight: true },
    { name: 'body', weight: 1, snippet: true },
  ],
  algorithm: 'bm25',
  bm25: { k1: 1.2, b: 0.75 },
});

// Or using BM25Index directly:
const index = new BM25Index({
  fields: [{ name: 'title', weight: 10 }, { name: 'body', weight: 1 }],
  idField: 'id',
});
index.addDocuments(articles);
const hits = index.search('high performance storage');
```

### 2. Table-level BM25 with `SearchIndex`
```ts
const searchIndex = createSearchIndex(db, {
  table: 'articles',
  fields: ['title', 'body'],
  algorithm: 'bm25',
});

const results = await searchIndex.search('database storage');
```

---

## N-Grams & N-Gram Similarity

Extract character and word n-grams (bigrams, trigrams) and compute the Sørensen-Dice similarity coefficient (0.0 to 1.0):

### When to Use N-Grams
- **Partial / Substring matching**: Searching for substrings inside unsegmented strings or SKUs (e.g. `ABC-1234-XYZ`).
- **CJK Languages**: Chinese, Japanese, and Korean text where whitespace word boundaries don't exist.
- **DNA / Code / Identifiers**: Arbitrary tokens without standard language dictionaries.

```ts
import {
  ngrams,
  wordNgrams,
  ngramSimilarity,
  ngramSimilarityExpr,
} from '@ahmadmoussawi/webdb/search';

// Character n-grams (trigrams)
ngrams('webdb', 3); // ['web', 'ebd', 'bdb']
ngrams('cat', 3, { pad: true }); // ['^^c', '^ca', 'cat', 'at$', 't$$']

// Word n-grams (bigrams for phrase search)
wordNgrams('WebDB is a fast browser database', 2);
// ['webdb is', 'is a', 'a fast', 'fast browser', 'browser database']

// Sørensen-Dice similarity (0.0 to 1.0)
ngramSimilarity('relational', 'relatinal', 2); // 0.82
ngramSimilarity('database', 'database');       // 1.00
ngramSimilarity('apple', 'banana');           // 0.00

// In queries:
const rows = await db.from('articles')
  .select([
    'id',
    ngramSimilarityExpr('title', 'getting started').as('sim_score'),
  ])
  .where(ngramSimilarityExpr('title', 'getting started').gt(0.5))
  .toArray();
```

---

## In-Memory Searching

You can use `@ahmadmoussawi/webdb/search` to rank and highlight pre-loaded JavaScript arrays (such as dropdown items, command palettes, or local settings) without touching the database:

### When to Use In-Memory Search
- Searching client-state arrays (e.g., options in a `Select` component).
- Application command menus (`Cmd+K` palettes).
- Navigation hierarchies or local breadcrumbs.

```ts
import { searchInMemory } from '@ahmadmoussawi/webdb/search';

const items = [
  { id: 1, title: 'Open Settings', description: 'Configure preferences and themes' },
  { id: 2, title: 'Export Snapshot', description: 'Download binary backup of database' },
  { id: 3, title: 'Manage Users', description: 'Create and edit accounts' },
];

const results = searchInMemory(items, 'setings', {
  fields: [
    { name: 'title', weight: 10, highlight: true },
    { name: 'description', weight: 1, snippet: true },
  ],
  idField: 'id',
  limit: 5,
});

console.log(results.hits[0].highlights.title); // "Open <mark>Settings</mark>"
```

---

## Standalone Text Primitives

All underlying text and distance utilities are exported as pure functions:

```ts
import {
  normalizeText,
  tokenize,
  damerauLevenshtein,
  withinEdits,
  matchWord,
  highlight,
  snippet,
  wordCount,
} from '@ahmadmoussawi/webdb/search';

// Diacritic stripping & lowercasing
normalizeText('Café Münchën'); // "cafe munchen"

// Native Intl.Segmenter word tokenization
tokenize('WebDB: ultra-fast relational engine'); // ['webdb', 'ultra', 'fast', 'relational', 'engine']

// Damerau-Levenshtein distance (handles character transpositions)
damerauLevenshtein('tehs', 'thes'); // 1
damerauLevenshtein('wierd', 'weird'); // 1
withinEdits('indexeddb', 'indexddb', 1); // true

// Match evaluation: 3 = exact, 2 = prefix, 1 = typo, 0 = none
matchWord('database', 'database'); // 3
matchWord('database', 'data');     // 2 (prefix)
matchWord('database', 'databaes'); // 1 (typo)

// Safe HTML highlighting
highlight('WebDB is fast', 'fats'); // "WebDB is <mark>fast</mark>"

// Contextual snippets
snippet('Long text with keywords here...', 'keywords', { size: 40 });
// "…text with <mark>keywords</mark> here…"
```

---

## Native C/Wasm Opcodes & UDF Batching

For maximum performance, WebDB provides two acceleration mechanisms:

### 1. Native VDBE Search Opcodes (`OP_STR_FUZZY_MATCH` & `OP_STR_LEVENSHTEIN`)

WebDB core includes native bytecode opcodes in the VDBE engine (`OP_STR_FUZZY_MATCH` `0x44` and `OP_STR_LEVENSHTEIN` `0x45`). They run entirely in linear memory / C / WebAssembly without crossing the JS-WASM boundary for each row.

You can trigger them directly in query filters and expressions:

```ts
import { col, fn } from '@ahmadmoussawi/webdb';

// Native 'fuzzy' operator in where clause
const products = await db.from('products')
  .where('name', 'fuzzy', 'iphne') // Typo-tolerant match for "iPhone"
  .toArray();

// Or using expressions:
const matches = await db.from('products')
  .where("fuzzy(name, 'pixl')")
  .toArray();

// Computing Levenshtein distance in projection:
const scored = await db.from('products')
  .select([
    'id',
    'name',
    fn.levenshtein(col('name'), 'Apple iPhone').as('dist'),
  ])
  .toArray();
```

### 2. Vectorized UDF Batching (`db.registerBatchedFunction`)

To eliminate the overhead of per-row JS function calls when running complex user-defined functions or custom tokenizers, WebDB supports **UDF Batching**:

```ts
// Register a vectorized UDF that receives an entire batch of rows at once:
db.registerBatchedFunction('custom_ranker', (argsBatch) => {
  // argsBatch is an array of argument tuples, e.g. [[row1_val, ...], [row2_val, ...]]
  // Called once per chunk (up to 128 rows, aligned to power of 2) instead of 128 separate JS calls:
  return argsBatch.map(([text, query]) => computeScore(text, query));
}, { returnType: DataType.FLOAT64 });

const results = await db.from('articles')
  .select(['id', "custom_ranker(body, 'search term') as rank"])
  .where('custom_ranker(body, "search term") > 0')
  .toArray();
```

All search UDFs registered by `registerFuzzySearch(db)` automatically support vectorized `batchCall`.

---

## Performance & Optimization Tips

1. **Pre-filter with Indexed Columns**: Because fuzzy scoring runs on candidate rows, apply indexed equality or range filters first:
   ```ts
   db.from('messages')
     .where('channel_id', '=', activeChannelId) // Uses B+Tree index
     .where(score.gt(0))                        // Scans only this channel's messages
   ```
2. **Debounce User Input**: When binding search to user input in `<input>` elements, debounce queries by 100ms–200ms to avoid scoring on every keystroke.
3. **Control Snippet Size**: Keep snippet sizes around 100–160 characters for optimal rendering speed and clean UI presentation.
