# Expressions, Built-in Functions & Custom UDFs

WebDB lets you write computed columns, arithmetic expressions, string transformations, and custom JavaScript functions across `.select()`, `.where()`, `.groupBy()`, `.having()`, and `.orderBy()`.

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

Instead of bundling bloated C libraries for regexes, locale formatting, or dates, WebDB lets you register synchronous JavaScript functions directly via [`db.registerFunction()`](./src/host/api/webdb.ts#L3137-L3180) and invoke them anywhere in your queries.

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
