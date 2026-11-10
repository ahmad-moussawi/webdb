# Expressions, Built-in Functions & Custom UDFs

WebDB lets you write computed columns, arithmetic expressions, string transformations, and custom JavaScript functions across `.select()`, `.where()`, `.groupBy()`, `.having()`, and `.orderBy()`.

**Built for the browser, not against it.** WebDB deliberately ships **no date library, no locale tables, no collation rules and no text tokenizer** in its core runtime. The browser already has excellent ones, so your queries call them directly: `Date`, `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.RelativeTimeFormat`, `Intl.PluralRules`, `Intl.Segmenter` (word and sentence tokenizing), `URL`, `RegExp`, `String.prototype.normalize` and more.

::: tip 📦 Pre-Packaged UDF Extensions
Looking for ready-to-use, optimized browser UDFs with vectorized batching and LRU caching?
- **[Internationalization & Formatting UDFs (`@ahmadmoussawi/webdb/intl`)](/guides/intl-formatting)**: Ready-to-use `format_date`, `format_currency`, `time_ago`, `format_bytes`, `date_add`, and more.
- **[Fuzzy & Typo-Tolerant Search (`@ahmadmoussawi/webdb/search`)](/guides/fuzzy-search)**: Typo tolerance, Damerau-Levenshtein, BM25 scoring, and snippet highlighting.
:::

::: tip 🔎 See it running
**[Typo-Tolerant Search with UDFs →](/demos/search)** is a live demo of custom functions in action: typo-tolerant, accent-insensitive search with relevance ranking and highlighted snippets. UDFs are used in `SELECT`, `WHERE` and `ORDER BY`, running on IndexedDB in your browser. [View the source on GitHub](https://github.com/ahmad-moussawi/webdb/tree/main/docs/.vitepress/theme/demos/search).
:::

---

## 1. Writing Expressions: SQL Strings vs. TypeScript Helpers

You can write expressions in two equivalent ways:

### A. Concise SQL Expression Strings

Write arithmetic or function calls directly as strings:

```typescript
const items = await db
  .from("order_items")
  .select(
    "product_name",
    "upper(sku) as normalized_sku",
    "price * quantity as line_total",
    "round(price * quantity * 1.08) as total_with_tax",
  )
  .where("price * quantity > 100")
  .orderBy("price * quantity", "desc")
  .toArray();
```

### B. Fluent Expression Builders (`col`, `fn`, `exp` / `sql`)

For programmatic query construction, import [`col`](./src/host/compiler/expr_parser.ts#L623-L625), [`fn`](./src/host/compiler/expr_parser.ts#L704), and [`exp`](./src/host/compiler/expr_parser.ts#L627-L629) (or its alias `sql`):

```typescript
import { WebDB, col, fn, exp } from "@ahmadmoussawi/webdb";

const lineTotal = col("price").mul(col("quantity"));

const items = await db
  .from("order_items")
  .select(
    "product_name",
    fn.upper(col("sku")).as("normalized_sku"),
    lineTotal.as("line_total"),
    fn.round(lineTotal.mul(1.08)).as("total_with_tax"),
  )
  .where(lineTotal.gt(100))
  .orderBy(lineTotal, "desc")
  .toArray();
```

#### `ExpressionBuilder` Methods (`col(...)`)

| Category       | Methods                                                      | SQL Equivalent                  |
| :------------- | :----------------------------------------------------------- | :------------------------------ |
| **Arithmetic** | `.add(x)`, `.sub(x)`, `.mul(x)`, `.div(x)`, `.mod(x)`        | `+`, `-`, `*`, `/`, `%`         |
| **Comparison** | `.eq(x)`, `.ne(x)`, `.lt(x)`, `.lte(x)`, `.gt(x)`, `.gte(x)` | `=`, `!=`, `<`, `<=`, `>`, `>=` |
| **Aliasing**   | `.as('aliasName')`                                           | `AS aliasName`                  |

---

## 2. Built-In Scalar & Math Functions

WebDB includes built-in string, math, and utility functions that execute natively inside the engine:

### String Functions

| Function                       | Helper               | Description                          | Example                                            |
| :----------------------------- | :------------------- | :----------------------------------- | :------------------------------------------------- |
| **`upper(str)`**               | `fn.upper(x)`        | Converts text to uppercase           | `'upper(name) as upperName'`                       |
| **`lower(str)`**               | `fn.lower(x)`        | Converts text to lowercase           | `'lower(email) as email'`                          |
| **`length(str)`**              | `fn.length(x)`       | Character length of string           | `'length(bio) as bioLen'`                          |
| **`trim(str)`**                | `fn.trim(x)`         | Strips leading & trailing whitespace | `'trim(code) as cleanCode'`                        |
| **`substr(str, start, len?)`** | `fn.substr(x, s, l)` | 1-indexed substring extraction       | `'substr(sku, 1, 3) as prefix'`                    |
| **`concat(a, b, ...)`**        | `fn.concat(a, b)`    | Concatenates multiple strings        | `"concat(first_name, ' ', last_name) as fullName"` |

### Math & Utility Functions

| Function                  | Helper              | Description                         | Example                                              |
| :------------------------ | :------------------ | :---------------------------------- | :--------------------------------------------------- |
| **`abs(n)`**              | `fn.abs(x)`         | Absolute value                      | `'abs(delta) as magnitude'`                          |
| **`round(n)`**            | `fn.round(x)`       | Rounds to nearest integer           | `'round(score) as rounded'`                          |
| **`floor(n)`**            | `fn.floor(x)`       | Rounds down to nearest integer      | `'floor(price) as dollars'`                          |
| **`ceil(n)`**             | `fn.ceil(x)`        | Rounds up to nearest integer        | `'ceil(weight) as billedWeight'`                     |
| **`coalesce(a, b, ...)`** | `fn.coalesce(a, b)` | Returns the first non-null argument | `"coalesce(nickname, name, 'Anonymous') as display"` |

---

## 3. Custom User-Defined Functions (`db.registerFunction`)

Instead of bundling bloated C libraries for regexes, locale formatting, or dates, WebDB lets you register synchronous JavaScript functions (which can use any [web platform API](#_4-embrace-the-browser-web-apis-as-query-functions)) directly via [`db.registerFunction()`](./src/host/api/webdb.ts#L3137-L3180) and invoke them anywhere in your queries.

### Registering a Simple Function

```typescript
// Register a custom slugify function
db.registerFunction("slugify", (text: string | null) => {
  if (!text) return null;
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
});

// Use it in .select() or .where() just like a built-in function!
const posts = await db
  .from("posts")
  .select("id", "title", "slugify(title) as slug")
  .where("slugify(title)", "=", "getting-started-with-webdb")
  .toArray();
```

### Specifying Return Type & Determinism

For best performance when using a custom function inside `WHERE` or `ORDER BY`, you can pass a `UdfDefinition` object specifying `returnType`:

```typescript
import { DataType } from "@ahmadmoussawi/webdb";

db.registerFunction("days_since", {
  deterministic: true,
  returnType: DataType.INT32,
  call: (timestampMs: bigint | number | null) => {
    if (timestampMs === null) return null;
    const diffMs = Date.now() - Number(timestampMs);
    return Math.floor(diffMs / 86_400_000);
  },
});

// Find inactive users who haven't logged in for over 30 days
const inactiveUsers = await db
  .from("users")
  .select("id", "email", "days_since(last_login_at) as daysOffline")
  .where("days_since(last_login_at) > 30")
  .toArray();
```

> [!TIP]
> **Using `fn('custom_name', ...)` with AST Helpers:** You can also call custom UDFs via the `fn` helper:
>
> ```typescript
> fn("slugify", col("title")).as("slug");
> ```

### Vectorized UDF Batching (`db.registerBatchedFunction`)

When evaluating queries over hundreds or thousands of rows, executing an individual JavaScript function call per row introduces noticeable function call overhead (call frame construction and V8 execution boundaries).

To maximize throughput across row sets, WebDB supports **Vectorized UDF Batching**. Instead of calling your function one row at a time, WebDB dispatches arguments in chunks (default **128 rows**, power-of-two aligned for CPU cache lines and V8 memory allocation buckets):

```typescript
import { DataType } from "@ahmadmoussawi/webdb";

// Register a batched function:
db.registerBatchedFunction(
  "fast_tax",
  (argsBatch) => {
    // argsBatch is an array of row argument tuples:
    // e.g. [[amount1, rate1], [amount2, rate2], ...] (up to 128 rows per batch)
    return argsBatch.map(([amount, rate]) => {
      if (amount === null || rate === null) return null;
      return Number(amount) * (1 + Number(rate));
    });
  },
  { returnType: DataType.FLOAT64, deterministic: true }
);

// Use it seamlessly in .select() or .where()
const orders = await db
  .from("orders")
  .select("id", "amount", "fast_tax(amount, 0.15) as total_with_tax")
  .where("fast_tax(amount, 0.15) > 100")
  .toArray();
```

#### How `db.registerBatchedFunction` Works

1. **Automatic Scalar Fallback**: `registerBatchedFunction` automatically defines a scalar fallback `call: (...args) => batchFn([args])[0]`, so the function also works seamlessly for single-row evaluations or constant expressions.
2. **Signature**:
   ```typescript
   db.registerBatchedFunction(
     name: string,
     batchFn: (argsBatch: any[][]) => any[],
     options?: { deterministic?: boolean; returnType?: DataType }
   ): this
   ```
   - `argsBatch`: An array of argument arrays for the current chunk (up to 128 rows).
   - Return Value: An array containing the computed result for each row in the batch (`out.length === argsBatch.length`).

#### Registering via `UdfDefinition.batchCall`

You can also specify `batchCall` directly inside the standard `db.registerFunction`:

```typescript
db.registerFunction("slugify", {
  deterministic: true,
  returnType: DataType.TEXT,
  // Scalar fallback for single-row evaluations
  call: (text: string | null) =>
    text ? text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-") : null,
  // Vectorized batch implementation for multi-row queries
  batchCall: (argsBatch: any[][]) => {
    return argsBatch.map(([text]) =>
      text ? String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-") : null
    );
  },
});
```

> [!TIP]
> **Built-in Search UDFs Use Batching**:
> All text and search functions registered via `registerFuzzySearch(db)` from `@ahmadmoussawi/webdb/search` (such as `fuzzy`, `fuzzy_score`, `highlight`, `snippet`, `ngram_similarity`, `bm25_score`) automatically provide `batchCall` implementations for vectorized query performance.

---

## 4. Embrace the Browser: Web APIs as Query Functions

A UDF is just a JavaScript function, so **everything the browser gives you is available inside a query**. This is the
design on purpose: rather than re-implementing dates, locales and Unicode in the engine (and shipping megabytes to do
it), WebDB lets the platform do what it already does best.

| Web API | What you get for free | Typical UDF |
| :-- | :-- | :-- |
| **`Date`** | Parsing, ISO strings, UTC math | `month_key(ts)`, `days_since(ts)` |
| **`Intl.DateTimeFormat`** | Locale- and time-zone-aware dates, weekday and month names | `format_date(ts, 'de-DE', 'Asia/Tokyo')` |
| **`Intl.RelativeTimeFormat`** | "3 days ago", "yesterday", in any language | `time_ago(ts)` |
| **`Intl.NumberFormat`** | Currency, units, compact numbers, per-locale separators | `money(total, 'EUR', 'de-DE')` |
| **`Intl.PluralRules`** | Correct plural forms in every language | `items_label(n)` |
| **`Intl.Segmenter`** | A real **tokenizer**: words, sentences and graphemes, even without spaces (Japanese, Thai…) | `word_count(text)` |
| **`Intl.Collator`** | Locale-aware string ordering | `locale_cmp(a, b)` |
| **`URL`** | Robust URL parsing | `url_host(link)` |
| **`String.prototype.normalize`** | Accent-insensitive matching | `unaccent(text)` |
| **`RegExp`** | Full-featured pattern matching (lookbehind, Unicode classes…) | `regex_match(text, pattern)` |
| **`crypto.randomUUID()`** | Secure random ids, synchronously | `new_id()` |

### Date functions

Store timestamps as **epoch milliseconds** (`INT64`) or ISO strings (`TEXT`): both sort correctly and convert
trivially. Then add the date helpers you need as UDFs:

```typescript
// Table: orders(id, customer, total FLOAT64, created_at INT64 /* epoch ms */)
const ms = (v: unknown) => Number(v); // INT64 values may arrive as bigint

// 'YYYY-MM' bucket using the Date API, perfect for GROUP BY
db.registerFunction("month_key", (ts) =>
  ts == null ? null : new Date(ms(ts)).toISOString().slice(0, 7),
);

// Locale- and time-zone-aware formatting with Intl.DateTimeFormat
db.registerFunction("format_date", (ts, locale: string, timeZone: string) =>
  ts == null
    ? null
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(new Date(ms(ts))),
);

// The weekday name in any language
db.registerFunction("weekday", (ts, locale: string) =>
  ts == null
    ? null
    : new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(ms(ts))),
);

// "3 days ago" with Intl.RelativeTimeFormat (create the formatter once, reuse it)
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
db.registerFunction("time_ago", (ts) =>
  ts == null ? null : rtf.format(Math.round((ms(ts) - Date.now()) / 86_400_000), "day"),
);
```

Use them in `SELECT`, `WHERE`, `GROUP BY` and `ORDER BY`, just like built-in functions.

**Monthly revenue report**: group by a UDF expression:

```typescript
const monthly = await db
  .from("orders")
  .select("month_key(created_at) as month", "sum(total) as revenue", "count(id) as orders")
  .groupBy("month_key(created_at)")
  .orderBy("month")
  .toArray();
// [
//   { month: "2026-09", revenue: 1250.5, orders: 1 },
//   { month: "2026-10", revenue: 409.25, orders: 2 },
//   { month: "2026-11", revenue: 42,     orders: 1 },
// ]
```

**Filter by month**, and **format dates for display in the user's locale and time zone**:

```typescript
const october = await db
  .from("orders")
  .select("id", "customer", "format_date(created_at, 'en-US', 'UTC') as day")
  .where("month_key(created_at) = '2026-10'")
  .toArray();
// [{ id: 2, customer: "Ben", day: "Oct 14, 2026" }, { id: 3, customer: "Cy", day: "Oct 30, 2026" }]

const localized = await db
  .from("orders")
  .select("weekday(created_at, 'fr-FR') as jour", "time_ago(created_at) as quand")
  .where("id", "=", 3)
  .toArray();
// [{ jour: "vendredi", quand: "7 days ago" }]   (quand depends on today's date)
```

::: tip Pass the locale from the app
Because the locale and time zone are ordinary arguments, you can pass `navigator.language` and
`Intl.DateTimeFormat().resolvedOptions().timeZone` straight from the UI, so every user sees dates their own way.
:::

### Numbers and currency with `Intl.NumberFormat`

```typescript
db.registerFunction("money", (amount, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency }).format(Number(amount)),
);

await db
  .from("orders")
  .select("money(total, 'USD', 'en-US') as usd", "money(total, 'EUR', 'de-DE') as eur")
  .where("id", "=", 1)
  .toArray();
// [{ usd: "$1,250.50", eur: "1.250,50 €" }]
```

### Tokenizing text with `Intl.Segmenter`

Splitting on spaces breaks for many languages. `Intl.Segmenter` is the browser's own Unicode-aware tokenizer:

```typescript
const segmenter = new Intl.Segmenter("und", { granularity: "word" });

db.registerFunction("word_count", (text) => {
  let n = 0;
  for (const part of segmenter.segment(String(text ?? ""))) if (part.isWordLike) n++;
  return n;
});

await db.from("notes").select("id", "word_count(body) as words").orderBy("words", "desc").toArray();
// "two words" -> 2     "日本語のメモです" -> 4 (splitting on spaces would say 1)
```

The same building blocks (a tokenizer, `normalize()` for accents, a few lines of edit distance) power the
[Typo-Tolerant Search with UDFs](/demos/search) demo.

### URLs and accent-insensitive matching

```typescript
db.registerFunction("url_host", (link) => {
  try {
    return new URL(String(link)).hostname; // handles ports, paths, query strings, IDNs…
  } catch {
    return null; // not a valid URL
  }
});

db.registerFunction("unaccent", (s) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(),
);

// Visits per host
await db
  .from("orders")
  .select("url_host(site) as host", "count(id) as n")
  .groupBy("url_host(site)")
  .orderBy("host")
  .toArray();

// "cafe" finds "Café order"
await db.from("orders").select("id").where("unaccent(note) = 'cafe order'").toArray();
```

### Good to know

- **UDFs are synchronous.** That rules out `fetch()` and `crypto.subtle` (both async). Use sync equivalents such as
  `crypto.randomUUID()`, `TextEncoder` or a small pure-JS hash. Do async work in your app, then store the result.
- **Create `Intl` formatters once**, outside the function (as `rtf` and `segmenter` above). They are comparatively
  expensive to construct and cheap to call, and a UDF runs once per row.
- **Results follow the user's browser.** Time zone, locale and Unicode versions come from the platform, so the
  same query can legitimately format differently on two devices. Store UTC timestamps and format at query time.
- **UDFs are not persisted.** Register them on every page load, right after `WebDB.open()`, before you query.
- **Mark pure functions `deterministic: true`** (see above) so the engine knows it can reuse their results.
