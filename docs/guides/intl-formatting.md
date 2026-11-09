# Internationalization & Formatting UDFs

WebDB ships an official subpath package, `@ahmadmoussawi/webdb/intl`, providing zero-dependency, browser-native formatting and date/number user-defined functions (UDFs) powered by standard web platform APIs (`Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.RelativeTimeFormat`, and `Intl.PluralRules`).

Like `@ahmadmoussawi/webdb/search`, this package is completely decoupled from the core runtime so it does not add any bytes to your initial bundle if you don't use it.

---

## Why Browser-Native Formatting in Queries?

Formatting dates, currencies, and numbers directly inside your database queries delivers major advantages:
1. **Computed columns for UI grids**: Format timestamps into localized dates or relative strings (`"2 days ago"`) directly in your `SELECT` projections.
2. **Filtering and grouping**: Group records by formatted period (e.g. `YYYY-MM` or date parts like `year` or `month`) or filter by localized day intervals.
3. **Zero external dependencies**: Leverages standard browser `Intl` APIs—no massive Moment.js or date-fns dependencies bundled.
4. **Vectorized performance**: UDFs are registered with chunked `batchCall` (128 rows per vector) and internal LRU caches for instantiated `Intl` formatters to eliminate per-row allocation overhead.

---

## Quick Start

### 1. Register All Formatting Functions

Call `registerIntlFunctions(db)` after opening your database:

```typescript
import { WebDB } from '@ahmadmoussawi/webdb';
import { registerIntlFunctions } from '@ahmadmoussawi/webdb/intl';

const db = await WebDB.open({ name: 'store.db' });

// Registers date, number, currency, and string UDFs on the database
registerIntlFunctions(db);
```

### 2. Query with Formatted Columns

Use registered UDF names via `fn()` or use the type-safe expression helpers:

```typescript
import { col, fn } from '@ahmadmoussawi/webdb';
import { formatDateExpr, formatCurrencyExpr, timeAgoExpr } from '@ahmadmoussawi/webdb/intl';

const orders = await db
  .from('orders')
  .select([
    'id',
    'customer_name',
    // Using type-safe expression helper with an expression (.div(100)) or column name:
    formatCurrencyExpr(col('total_cents').div(100), 'USD', 'en-US').as('formatted_total'),
    formatDateExpr('created_at', 'medium', 'en-US').as('formatted_date'),
    timeAgoExpr('created_at').as('relative_time'),
    // Or via bare fn() call:
    fn('format_currency', col('discount_amount'), 'USD', 'en-US').as('discount_formatted'),
  ])
  .orderBy('created_at', 'desc')
  .limit(20)
  .toArray();
```

---

## Modular Registration

If you only need a specific subset of functions, you can register individual modules to keep memory usage minimal:

```typescript
import {
  registerDateFunctions,
  registerNumberFunctions,
  registerStringFunctions,
} from '@ahmadmoussawi/webdb/intl';

// Only register date & time functions (format_date, time_ago, date_add, etc.)
registerDateFunctions(db);

// Only register number & currency functions (format_currency, format_bytes, etc.)
registerNumberFunctions(db);

// Only register text & regex functions (slugify, unaccent, regexp_replace, etc.)
registerStringFunctions(db);
```

---

## Available SQL Functions

### Date & Time Functions

| Function Signature | Description | Example Output |
| :--- | :--- | :--- |
| `format_date(val, [style='medium'], [locale], [tz])` | Formats ISO string or millisecond timestamp (`'short'`, `'medium'`, `'long'`, `'full'`) | `'Oct 25, 2026'` |
| `format_time(val, [style='short'], [locale], [tz])` | Formats time component (`'short'`, `'medium'`, `'long'`, `'full'`) | `'2:30 PM'` |
| `time_ago(val, [baseTime], [locale])` | Relative human-readable duration | `'3 hours ago'`, `'in 2 days'` |
| `date_part(part, val)` | Extracts component: `'year'`, `'month'`, `'day'`, `'hour'`, `'minute'`, `'second'`, `'weekday'` | `2026`, `10` |
| `days_since(val, [baseTime])` | Number of whole elapsed days | `4` |
| `date_add(val, amount, [unit='day'])` | Adds interval (`'day'`, `'week'`, `'month'`, `'year'`, `'hour'`, `'minute'`) returning epoch ms | `1793577600000` |
| `date_diff(valA, valB, [unit='day'])` | Difference `(A - B)` in units (`'day'`, `'hour'`, `'minute'`, `'second'`, `'millisecond'`) | `7` |
| `iso_date(val)` | Normalizes to `YYYY-MM-DD` | `'2026-10-25'` |
| `to_timestamp(val)` | Converts to numeric Unix millisecond timestamp | `1792972800000` |

### Number & Currency Functions

| Function Signature | Description | Example Output |
| :--- | :--- | :--- |
| `format_currency(val, [currency='USD'], [locale])` | Formats currency amount | `'$1,234.56'`, `'1 234,56 €'` |
| `format_number(val, [decimals], [locale])` | Formats decimal number with thousand separators | `'1,234,567.89'` |
| `format_compact(val, [locale])` | Compact notation for large metrics | `'1.2M'`, `'45K'` |
| `format_percent(val, [decimals=1], [locale])` | Formats decimal ratio as percentage | `'85.0%'`, `'12.5%'` |
| `format_bytes(bytes, [decimals=1])` | Formats byte sizes with binary units (KiB, MiB, GiB, etc.) | `'14.2 MB'`, `'1.5 GB'` |
| `plural(val, singular, [pluralText], [zeroText])` | String pluralization helper | `'1 item'`, `'5 items'` |

### String & Regex Functions

| Function Signature | Description | Example Output |
| :--- | :--- | :--- |
| `regexp_match(val, pattern, [flags])` | Returns `1` if regular expression matches, `0` otherwise | `1` |
| `regexp_replace(val, pattern, replacement, [flags])` | Replaces regex pattern matches with replacement string | `'user-name'` |
| `slugify(val)` | Strips accents, punctuation, and returns URL-safe slug | `'hello-world-2026'` |
| `unaccent(val)` | Strips Unicode diacritics (`Café` $\to$ `Cafe`) | `'Cafe'` |
| `pad_left(val, targetLen, [padChar])` | Pads string on the left to target length | `'00042'` |
| `pad_right(val, targetLen, [padChar])` | Pads string on the right to target length | `'Title.....'` |

---

## Type-Safe Query Expression Builders

For clean, readable queries without bare string literals, `@ahmadmoussawi/webdb/intl` exports ready-to-use expression helpers:

```typescript
import { col } from '@ahmadmoussawi/webdb';
import {
  formatDateExpr,
  formatCurrencyExpr,
  formatCompactExpr,
  formatBytesExpr,
  timeAgoExpr,
  slugifyExpr,
} from '@ahmadmoussawi/webdb/intl';

const rows = await db
  .from('files')
  .select([
    'name',
    formatBytesExpr(col('size_bytes')).as('formatted_size'),
    formatCompactExpr(col('download_count')).as('downloads_compact'),
    formatDateExpr(col('updated_at'), 'en-US', { dateStyle: 'short' }).as('date'),
    timeAgoExpr(col('updated_at')).as('last_modified'),
    slugifyExpr(col('name')).as('slug'),
  ])
  .where(col('size_bytes').gt(1024 * 1024))
  .toArray();
```

---

## Standalone JavaScript Helpers

All formatting utilities can also be imported and used as standalone pure functions in your frontend components without touching the database:

```typescript
import {
  formatDate,
  formatCurrency,
  formatBytes,
  timeAgo,
  slugify,
  unaccent,
} from '@ahmadmoussawi/webdb/intl';

// Pure JavaScript execution:
const price = formatCurrency(49.99, 'EUR', 'de-DE'); // "49,99 €"
const size = formatBytes(10485760);                   // "10.0 MB"
const ago = timeAgo(Date.now() - 3600000);            // "1 hour ago"
const slug = slugify('L’événement de l’été !');       // "l-evenement-de-l-ete"
```

---

## Performance & Caching

Constructing `new Intl.DateTimeFormat()` or `new RegExp()` in a tight loop across tens of thousands of database rows can cause severe GC pauses and CPU overhead.

`@ahmadmoussawi/webdb/intl` addresses this with built-in optimizations:
- **Least-Recently-Used (LRU) Cache**: Formatter instances are cached by their composite key (`locale:options`). Repeated rows reuse the pre-compiled formatter instance.
- **128-Row Vectorized Batching**: Registrars supply `batchCall` implementations. WebDB's query compiler processes chunks of rows in single batch calls rather than context-switching per row.
- **Deterministic**: Declared as `deterministic: true` to enable execution optimizations in the query engine.
