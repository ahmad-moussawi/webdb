# Query Builder API & Grammar Specification

This document defines the formal grammar, TypeScript API specification, expression evaluation model, and execution semantics for the WebDB **Query Builder**.

---

## 1. Overview & Architectural Principles

The WebDB Query Builder provides a fluent, type-safe, and deterministic query construction interface. It compiles declarative query chains into linear VDBE bytecode arrays for execution in the core engine.

### Key Architectural Principles
1. **Determinism**: Every method overload and specification has a single unambiguous meaning. No dynamic heuristics or guessing (e.g. strict `{[col]: alias}` dictionary mapping).
2. **Strict Typings**: Explicit properties (`col`, `as`, `fn`, `args`) prevent silent misspelling bugs.
3. **Unified Expression AST for Functions**: Functions (`upper`, `floor`, `count`, etc.) are authored exclusively as Expressions (via AST helpers `fn.upper(...)` or SQL string micro-syntax `'upper(...) as ...'`). Ad-hoc JavaScript closures `(val, row) => ...` in `select()` are completely removed, ensuring all queries can be compiled into native VDBE register opcodes, serialized across Wasm/Worker boundaries, and flattened across subqueries without opaque black-box closures. Custom host logic is supported strictly via registered deterministic UDFs (`db.registerFunction()`).
4. **Composability**: Queries can be nested as derived tables (`db.from(subquery)`) and flattened by the planner when safe.

---

## 2. Formal Grammar Specification (EBNF)

```ebnf
Query              ::= SelectQuery | MutationQuery ;

SelectQuery        ::= FromClause
                       ( SelectClause | SelectExceptClause )?
                       ( WhereClause )*
                       ( GroupByClause )?
                       ( HavingClause )?
                       ( OrderByClause )?
                       ( PaginationClause )* ;

/* --- SELECT CLAUSE --- */
SelectClause       ::= "select(" SelectArgList ")" ;
SelectExceptClause ::= "selectExcept(" ExcludeArgList ")" ;
ExcludeArgList     ::= ColumnIdentifier ( "," ColumnIdentifier )*
                     | "[" ColumnIdentifier ( "," ColumnIdentifier )* "]" ;
SelectArgList      ::= SelectItem ( "," SelectItem )* ;
SelectItem         ::= Wildcard
                     | ColumnIdentifier
                     | SqlExpressionString
                     | ExpressionNode
                     | SelectColumnSpec
                     | ColumnDictionary ;

Wildcard           ::= "*" ;
ColumnIdentifier   ::= Identifier ;
SqlExpressionString::= Expression " AS " AliasIdentifier
                     | FunctionCall ( " AS " AliasIdentifier )? ;

SelectColumnSpec   ::= "{" "col:" ColumnIdentifier ","? "as:" AliasIdentifier "}" ;

ColumnDictionary   ::= "{" ( KeyValuePair ( "," KeyValuePair )* ) "}" ;
KeyValuePair       ::= ColumnIdentifier ":" ( AliasIdentifier | ExpressionNode ) ;

/* --- FROM CLAUSE --- */
FromClause         ::= "from(" ( TableIdentifier | Subquery ) ")" ;
Subquery           ::= SelectQuery ;

/* --- WHERE CLAUSE --- */
WhereClause        ::= "where(" WhereArgList ")"
                     | "orWhere(" WhereArgList ")"
                     | "whereNot(" NestedConditionClosure ")"
                     | "whereNull(" ColumnIdentifier ")"
                     | "whereNotNull(" ColumnIdentifier ")"
                     | "whereIn(" ColumnIdentifier "," ValueList ")"
                     | "orWhereIn(" ColumnIdentifier "," ValueList ")"
                     | "whereNotIn(" ColumnIdentifier "," ValueList ")"
                     | "orWhereNotIn(" ColumnIdentifier "," ValueList ")" ;

ValueList          ::= "[" Literal ( "," Literal )* "]" | "[]" ;

WhereArgList       ::= BinaryPredicate
                     | PredicateDictionary
                     | NestedConditionClosure ;

BinaryPredicate    ::= ColumnIdentifier "," ComparisonOperator "," ( Literal | ColumnIdentifier | ValueList ) ;
ComparisonOperator ::= "=" | "!=" | "<" | "<=" | ">" | ">="
                     | "like" | "not like" | "contains" | "startsWith" | "endsWith"
                     | "in" | "not in" ;

PredicateDictionary::= "{" ( ColumnIdentifier ":" Literal ( "," ColumnIdentifier ":" Literal )* ) "}" ;
NestedConditionClosure ::= "(" "sub" "=>" "{" ( SubWhereMethod )* "}" ")" ;

/* --- GROUP BY & HAVING --- */
GroupByClause      ::= "groupBy(" ColumnIdentifier ( "," ColumnIdentifier )* ")" ;
HavingClause       ::= "having(" BinaryPredicate ")" ;

/* --- ORDER BY --- */
OrderByClause      ::= "orderBy(" ( SingleOrder | MultiOrderList ) ")" ;
SingleOrder        ::= ColumnIdentifier ( "," Direction )? ;
MultiOrderList     ::= "[" OrderSpec ( "," OrderSpec )* "]" ;
OrderSpec          ::= "{" "col:" ColumnIdentifier ( "," "dir:" Direction )? ( "," "nulls:" NullsOrder )? "}" ;
Direction          ::= "'asc'" | "'desc'" ;
NullsOrder         ::= "'first'" | "'last'" ;

/* --- PAGINATION --- */
PaginationClause   ::= "limit(" Integer ")" | "offset(" Integer ")" ;

/* --- EXPRESSIONS & FUNCTIONS --- */
Expression         ::= PrimaryExpr ( BinaryOp PrimaryExpr )* ;
PrimaryExpr        ::= ColumnIdentifier | Literal | FunctionCall | "(" Expression ")" ;
BinaryOp           ::= "+" | "-" | "*" | "/" | "%" ;

FunctionCall       ::= FunctionIdentifier "(" ( FunctionArgList )? ")" ;
FunctionIdentifier ::= Identifier ; (* Resolved implicitly via Function Catalog: Built-in Native -> Registered UDF *)
FunctionArgList    ::= Wildcard | ( Expression ( "," Expression )* ) ;
```

---

## 3. `select()` API Specification

The `select()` method defines projected columns and transformations. It can be called with strings, explicit specifications, dictionaries, or chained sequentially.

### 3.1 Method Signatures
```typescript
interface QueryBuilder {
  // 1. Varargs column strings
  select(...columns: (string | SelectColumnSpec | ExpressionNode)[]): this;

  // 2. Array of column strings, specs, expression strings, or ExpressionNodes
  select(columns: SelectItem[]): this;

  // 3. Strict dictionary mapping: {[col]: alias | ExpressionNode}
  select(columnsMap: Record<string, string | ExpressionNode>): this;

  // 4. Fluent chaining
  select(first: SelectItem | SelectItem[] | Record<string, string | ExpressionNode>, ...rest: SelectItem[]): this;
}
```

### 3.2 Specification Formats & Overloads

#### A. Array / Varargs of Column Strings
Extracts columns by name without renaming:
```typescript
db.from('users').select('id', 'name', 'salary');
// Or:
db.from('users').select(['id', 'name', 'salary']);
```
**Output Row Shape**: `{ id: number, name: string, salary: number }`

#### B. SQL Expression Strings with `AS`
Supports SQL-standard projection expressions with alias naming:
```typescript
db.from('users').select([
  'id',
  'name as full_name',
  'upper(role) as upper_role',
  'salary * 1.1 as projected_salary'
]);
```

#### C. Strict `SelectColumnSpec` (Column Aliasing Only)
For explicit, deterministic column renaming:
```typescript
export interface SelectColumnSpec {
  col: string;  // Source column name
  as: string;   // Output field alias name
}
```

**Examples:**
```typescript
db.from('users').select([
  'id',
  { col: 'name', as: 'full_name' },
  { col: 'salary', as: 'compensation' },
]);
```

> [!IMPORTANT]
> **Functions are Exclusively Expressions (No `{fn: ...}` Overload & No Ad-Hoc JS Closures):**
> 1. **Expression Power:** Functions (`upper`, `floor`, `concat`, etc.) are now authored strictly through **Expressions** (via standalone Drizzle-style helpers like `fn.upper(col('role')).as('upper_role')` or SQL strings like `'upper(role) as upper_role'`). This eliminates redundant syntax paths and allows arbitrary composition, nesting, and multi-argument evaluation (e.g. `fn.floor(col('score').mul(1.1))`).
> 2. **Elimination of Ad-Hoc JS Closures:** Direct JavaScript callbacks `(val, row) => ...` in `select()` are removed. Ad-hoc closures cannot be compiled into VDBE bytecode, cannot be evaluated across Wasm/Worker boundaries, and break in nested subqueries and planner flattening. Custom JavaScript functions must be registered as formal database UDFs via `db.registerFunction()`.

#### D. Strict Key-Value Dictionary Mapping: `{[col]: alias | ExpressionNode}`
In dictionary mode, **keys are source columns** and **values are target aliases** (or `ExpressionNode`s):
```typescript
db.from('users').select({
  id: 'userId',
  name: 'fullName',
  role: 'jobTitle',
});
```
**Output Row Shape**: `{ userId: 1, fullName: 'Alice Chen', jobTitle: 'Architect' }`

If transforming a column via dictionary, the value can be an `ExpressionNode`:
```typescript
db.from('users').select({
  name: 'full_name',
  salary: col('salary').mul(1.1).as('projected_salary'),
  dept: fn.upper(col('dept')).as('department'),
});
```

#### E. Chaining Multiple `select()` Calls
Multiple calls append fields sequentially:
```typescript
db.from('users')
  .select('id')
  .select(['name', 'dept'])
  .select({ salary: 'compensation' });
```

### 3.3 `selectExcept()` (Wildcard Column Exclusion)

Inspired by Google BigQuery's `SELECT * EXCEPT(...)` and DuckDB/Snowflake's `SELECT * EXCLUDE(...)`, `selectExcept()` projects all columns from the source table or subquery **except** the explicitly specified columns:

```typescript
// 1. Base table exclusion: selects all columns except 'age' and 'image_url'
db.from('users')
  .selectExcept('age', 'image_url');
// Or passing an array:
db.from('users')
  .selectExcept(['age', 'image_url']);

// 2. Subquery derived table exclusion:
db.from(
  db.from('users')
    .select('*', 'concat(name, last_name) as fullname')
)
.selectExcept('name');
// Flattener inlines: select id, score, last_name, concat(name, last_name) as fullname from users
```

**Semantics & Register Pipelining:**
- Evaluated at compile time against the catalog schema (for base tables) or output schema (for subqueries).
- Excluded columns referenced by active expressions (e.g. `name` needed for `concat()`) are loaded into intermediate registers but omitted from the `OP_RESULT_ROW` output range, achieving zero temporary table allocations and zero data copies.

---

## 4. Functions & Expression Specification

WebDB unifies all function invocations—**native scalar functions**, **native aggregate functions**, and **user-defined functions (UDFs)**—into a single expression model and AST.

---

### 4.1 Unified Expression AST (`ExprNode`)

Both standalone TypeScript helper chains and parsed SQL expression strings compile into the same internal Abstract Syntax Tree (`ExprNode`):

```typescript
export type ExprNode =
  | { type: 'col'; name: string }
  | { type: 'literal'; value: number | string | boolean | null }
  | { type: 'binary'; op: '+' | '-' | '*' | '/' | '%'; left: ExprNode; right: ExprNode }
  | { type: 'fn'; name: string; args: ExprNode[] };
```

Every function call in the query tree is represented as `{ type: 'fn', name: string, args: ExprNode[] }`. The engine does not require separate syntax for scalar functions, aggregate functions, or custom UDFs.

---

### 4.2 The Function Catalog & Implicit UDF Resolution

WebDB employs an **Implicit Catalog Resolution Strategy** (matching modern database standards such as SQLite, DuckDB, and PostgreSQL). When compiling a function call `name(arg1, arg2, ...)`, the query compiler resolves the function through a deterministic 3-tier lookup:

```
                  Function Call: name(args...)
                              │
                              ▼
                1. Is it a Built-In Native Function?
                (upper, lower, abs, count, sum, etc.)
                     /                    \
                   YES                     NO
                   /                        \
      Emit native VDBE opcode                ▼
      (OP_STR_UPPER, OP_AGG_STEP...)   2. Is it in db.registerFunction()?
                                             /                    \
                                           YES                     NO
                                           /                        \
                              Emit OP_CALL_UDF (0x28)                ▼
                              (host JS bridge execution)       3. Throw Compile Error:
                                                               UnknownFunctionError:
                                                               "Function 'foo' is neither native nor a registered UDF"
```

#### Architectural Rationale for Implicit Resolution:
1. **Zero Leaky Abstractions**:
   Developers write intuitive queries expressing *what* calculation is needed (`'slugify(title) as slug'` or `fn('slugify', col('title'))`). The query builder abstracts away whether the function executes in native Wasm bytecode or across the JS host bridge.
2. **Transparent Performance Promotion**:
   If WebDB implements a native opcode for an existing function (e.g. promoting `concat` or `date_add` to core Wasm bytecodes in a future release), user queries automatically upgrade to native execution with **zero code changes or refactoring**.
3. **Collision & Precedence Rules**:
   - Built-in native functions always take precedence over registered UDFs.
   - Calling `db.registerFunction(name, ...)` with a name matching a built-in function throws `ReservedFunctionNameError` unless explicitly opted-in via `{ override: true }`.

---

### 4.3 Native Scalar Functions (Row-by-Row)

Scalar functions operate on values within a single row and emit direct VDBE register opcodes:

| Function | Signature | Semantics | VDBE Opcode |
| :--- | :--- | :--- | :---: |
| `upper` | `upper(expr)` | Converts text to uppercase | `OP_STR_UPPER` (`0x2A`) |
| `lower` | `lower(expr)` | Converts text to lowercase | `OP_STR_LOWER` (`0x29`) |
| `length` | `length(expr)` | UTF-8 character length (int32) | `OP_STR_LENGTH` (`0x2B`) |
| `substr` | `substr(expr, start, len?)` | 1-indexed SQL substring | `OP_STR_SUBSTR` (`0x2C`) |
| `trim` | `trim(expr)` | Strips leading and trailing whitespace | `OP_STR_TRIM` (`0x2D`) |
| `abs` | `abs(expr)` | Absolute numeric value | `OP_MATH_ABS` (`0x2E`) |
| `round` | `round(expr)` | Rounds float to nearest integer | `OP_MATH_ROUND` (`0x2F`) |
| `floor` | `floor(expr)` | Mathematical floor $\lfloor x \rfloor$ | `OP_MATH_FLOOR` (`0x34`) |
| `ceil` | `ceil(expr)` | Mathematical ceiling $\lceil x \rceil$ | `OP_MATH_CEIL` (`0x35`) |

---

### 4.4 Native Aggregate Functions & Compound Expressions

Aggregate functions summarize data across multiple rows. Because aggregate calls share the exact same `ExprNode` AST, they seamlessly accept **arbitrary compound inner expressions**:

```typescript
// Compound arithmetic and scalar functions nested inside aggregates:
db.from('employees').select([
  'dept',
  'count(*) as headcount',
  'sum(salary * 1.1 + bonus) as projected_total_compensation',
  'avg(score) as mean_score',
]);
```

| Function | Signature | Semantics | VDBE Accumulator |
| :--- | :--- | :--- | :--- |
| `count` | `count(*)` or `count(expr)` | Counts rows or non-null values | `AggBucket.count++` |
| `sum` | `sum(expr)` | Sum of non-null numeric values | `AggBucket.sum += val` |
| `avg` | `avg(expr)` | Mean average (`sum / count`) | `OP_AGG_FINAL (sum / count)` |
| `min` | `min(expr)` | Minimum numeric or string value | `AggBucket.min_val` |
| `max` | `max(expr)` | Maximum numeric or string value | `AggBucket.max_val` |

#### Compilation Pipelining for Compound Aggregates:
1. **Inner Expression Evaluation**: For each row during the table scan, the inner expression (e.g. `salary * 1.1 + bonus`) evaluates row-by-row into intermediate registers.
2. **Accumulation Step (`OP_AGG_STEP`)**: The intermediate register is fed directly into the aggregate bucket for the active group key.
3. **Bucket Finalization (`OP_AGG_FINAL`)**: When all input rows have been consumed, the engine finalizes each bucket (e.g. dividing sum by count for `avg`) into the final output register.

#### Clause Availability Matrix:
| Clause | Scalar Functions | Aggregate Functions | Notes |
| :--- | :---: | :---: | :--- |
| `select(...)` | Allowed | Allowed | Aggregates trigger global or grouped aggregation mode |
| `having(...)` | Allowed | Allowed | Evaluated post-aggregation on group buckets (e.g. `having('count(*) > 5')`) |
| `orderBy(...)` | Allowed | Allowed | Can sort by aggregate or scalar expression |
| `where(...)` | Allowed | **Disallowed** | SQL constraint: aggregates operate on groups, not input scan rows. Throws `AggregateNotAllowedInWhereError`. |

---

### 4.5 User-Defined Functions (UDFs)

Custom functions registered on the `WebDB` instance execute via the synchronous host bridge opcode `OP_CALL_UDF (0x28)`:

```typescript
// 1. Register the UDF on the database instance:
db.registerFunction('slugify', {
  deterministic: true,
  call: (val: string) => String(val).toLowerCase().replace(/\s+/g, '-'),
});

// 2. Invoke implicitly in queries via SQL string or helper:
const results = await db.from('articles')
  .select([
    'title',
    'slugify(title) as slug',
    // Or via standalone helper:
    // fn('slugify', col('title')).as('slug')
  ])
  .where('slugify(title)', 'like', 'intro%')
  .toArray();
```

---

### 4.6 Expression Authoring: Standalone Helpers (`col`, `fn`) & String Parser

WebDB provides two complementary syntax paths for building dynamic expressions. Both compile into the exact same `ExprNode` AST:

#### A. Standalone Helper Functions (Drizzle Style)
Imported directly from `@webdb/core`, providing type safety, autocompletion, and zero runtime string parsing:

```typescript
import { col, fn } from '@webdb/core';

const results = await db.from('students')
  .select([
    'id',
    // Arithmetic chaining on column:
    fn.floor(col('score').mul(2).add(10)).as('adjusted_score'),
    // String scalar function:
    fn.upper(col('name')).as('upper_name'),
    // Native aggregate with compound expression:
    fn.sum(col('score').mul(1.1)).as('projected_sum'),
    // Multi-argument function:
    fn.concat(col('first_name'), ' ', col('last_name')).as('full_name'),
    // Implicit UDF invocation:
    fn('slugify', col('name')).as('slug'),
  ])
  .where(col('score').mul(2), '>=', 100)
  .orderBy(col('score').mul(2), 'desc')
  .toArray();
```

**Supported Helper Methods:**
- **Column References**: `col(columnName)`
- **Arithmetic Methods on Columns / Expressions**: `.add(x)`, `.sub(x)`, `.mul(x)`, `.div(x)`, `.mod(x)`
- **Aliasing**: `.as(aliasName)`
- **Function Namespace `fn`**:
  - `fn.upper(expr)`, `fn.lower(expr)`, `fn.length(expr)`, `fn.substr(expr, start, len?)`, `fn.trim(expr)`
  - `fn.abs(expr)`, `fn.round(expr)`, `fn.floor(expr)`, `fn.ceil(expr)`
  - `fn.count(expr?)`, `fn.sum(expr)`, `fn.avg(expr)`, `fn.min(expr)`, `fn.max(expr)`
  - `fn.concat(...exprs)`, `fn.coalesce(...exprs)`
  - `fn(udfName, ...args)` for any custom registered UDF

#### B. SQL String Expression Micro-Parser
For concise one-liners, developers can write expressions directly as SQL strings:

```typescript
const results = await db.from('students')
  .select([
    'id',
    'floor(score * 2 + 10) as adjusted_score',
    'upper(name) as upper_name',
    'sum(score * 1.1) as projected_sum',
    'slugify(name) as slug',
  ])
  .where('score * 2 >= 100')
  .toArray();
```

- **Micro-Parser**: A lightweight Pratt / Shunting-Yard parser tokenizes identifiers, numbers, arithmetic operators (`+`, `-`, `*`, `/`, `%`), parentheses, and function calls.
- **Identical Output**: Translates string expressions into the exact same `ExprNode` tree as the standalone helpers, ensuring the VDBE compiler executes a single, uniform compilation path.

#### C. Compilation to VDBE Bytecode Registers
```
Input: fn.floor(col('score').mul(2).add(10)).as('adjusted_score')
   or: 'floor(score * 2 + 10) as adjusted_score'
                   │
                   ▼ (Compiled into ExprNode AST)
             fn: floor
                │
            binary: +
             /      \
         binary: *  literal: 10
          /     \
      col: score literal: 2
                   │
                   ▼ (VDBE Compiler recursively emits register opcodes)
  1. OP_COLUMN_FLOAT  0 (score)  -> r[1]
  2. OP_LOAD_FLOAT    2          -> r[2]
  3. OP_MUL           r[1], r[2] -> r[3]
  4. OP_LOAD_FLOAT    10         -> r[4]
  5. OP_ADD           r[3], r[4] -> r[5]
  6. OP_MATH_FLOOR    r[5]       -> r[6] (Output Register 'adjusted_score')
```

---

## 5. Filtering API (`where`, `whereNot`, `orWhere`)

### 5.1 Binary Operators
```typescript
db.from('users')
  .where('age', '>=', 21)
  .where('dept', '=', 'Engineering')
  .where('name', 'like', 'A%')
  .where('email', 'contains', '@company.com');
```

Supported comparison operators:
- Equality: `'='`, `'!='`, `'<>'`
- Ordering: `'<'`, `'<='`, `'>'`, `'>='`
- String pattern: `'like'`, `'not like'`, `'contains'`, `'startsWith'`, `'endsWith'`

### 5.2 Dictionary Shorthand (Implicit AND)
```typescript
db.from('users').where({
  dept: 'Engineering',
  role: 'Lead',
});
```

### 5.3 Nested Boolean Groups (`AND`, `OR`, `NOT`)
Nested callback functions generate scoped jump branches:

```typescript
// (dept = 'Sales' AND salary < 50000) OR (dept = 'Engineering' AND salary >= 100000)
db.from('users')
  .where((sub) => {
    sub.where('dept', '=', 'Sales')
       .where('salary', '<', 50000);
  })
  .orWhere((sub) => {
    sub.where('dept', '=', 'Engineering')
       .where('salary', '>=', 100000);
  });

// NOT (dept = 'HR' OR dept = 'Sales')
db.from('users')
  .whereNot((sub) => {
    sub.where('dept', '=', 'HR')
       .orWhere('dept', '=', 'Sales');
  });
```

### 5.4 Null Predicates
```typescript
db.from('users')
  .whereNull('deleted_at')
  .whereNotNull('verified_at');
```

### 5.5 IN & NOT IN Predicates (`whereIn`, `whereNotIn`, `orWhereIn`, `orWhereNotIn`)

WebDB provides high-performance set membership filtering matching standard SQL `IN` and `NOT IN` semantics.

#### A. Basic Usage & Operator Overloads
```typescript
// Dedicated helper methods:
db.from('users').whereIn('dept', ['Engineering', 'Design', 'Product']);
db.from('users').whereNotIn('status', ['banned', 'suspended']);

// Boolean combinations:
db.from('users')
  .where('role', '=', 'staff')
  .orWhereIn('id', [10, 20, 30]);

// Standard binary comparison operator overload:
db.from('users').where('id', 'in', [1, 2, 3]);
db.from('users').where('dept', 'not in', ['Sales', 'HR']);
```

#### B. Edge Cases & Semantics

1. **Empty Array (`col IN ()`)**:
   - In SQL standards, membership in an empty set is always `FALSE` (`x IN ()` $\equiv$ `FALSE`).
   - `whereIn(col, [])`: Evaluates to `FALSE`. If part of the top-level query filter (`AND`), the query planner short-circuits immediately by emitting `OP_HALT` without executing any table scan or index scan (0 pages accessed, instant `[]` return). Inside an `OR` branch, it evaluates to false and jumps to the next condition.
   - `whereNotIn(col, [])`: Evaluates to `TRUE` (`NOT FALSE`). It acts as a neutral pass-through condition and retains all eligible rows.

2. **Deduplication of Values**:
   - Input arrays are deduplicated in $O(K)$ time before bytecode compilation. Redundant checks are eliminated. In index point-seek scans, deduplication prevents duplicate B+tree probe traversals and ensures each row is visited at most once.

3. **Null Values & SQL Three-Valued Logic (3VL)**:
   - Rows where the column value is `NULL` evaluate to `UNKNOWN` in SQL 3VL, which is treated as `FALSE` in `WHERE` filtering. A `NULL` row never matches `whereIn(col, ...)`.
   - If `values` contains `null` (e.g. `[1, 2, null]`), rows with `col IS NULL` still do not match (`NULL = NULL` is UNKNOWN in SQL).
   - In `whereNotIn(col, [1, 2])`, rows with `col IS NULL` evaluate to `UNKNOWN` and are excluded from the result set.

4. **Maximum Length & Large Array Limits**:
   - WebDB enforces a deterministic size limit: `MAX_IN_LIST_SIZE = 10000` items per `whereIn` clause.
   - Arrays exceeding `MAX_IN_LIST_SIZE` immediately throw a `RangeError`:
     `"WebDB: whereIn list exceeds maximum limit of 10000 elements"`.
   - This prevents out-of-memory errors and excessive bytecode generation.

5. **Register Allocation & VDBE Set Storage (`OP_IN`)**:
   - Because VDBE bytecode frames are capped at 64 registers (`0..63`), array values are **not** loaded into individual registers.
   - Instead, the compiler builds a persistent `Set<any>` constant stored on the query context (`ctx.inSets[setIdx]`).
   - The engine executes a single 5-byte opcode `OP_IN (0x1f)`:
     `OP_IN [reg_val: uint8] [set_idx: uint16] [jump_target: uint16]`
   - Each scanned row performs an $O(1)$ set membership test in host memory.

6. **Index Acceleration (`multi_point` Index Probing)**:
   - When `col` is covered by a **Primary Key** or **Unique Secondary Index**, the query compiler avoids a full table scan (`OP_REWIND` / $O(N)$) and activates `CandidateIndexScan` with `scanType: 'multi_point'`.
   - The engine opens the index B+tree cursor (`OP_OPEN_INDEX`) and iterates through each distinct value in the array, issuing an exact point seek (`OP_INDEX_SEEK_EQ`) in $O(K \log N)$ time:
     ```
     For each value k in inValues:
       OP_LOAD_INT/TEXT/FLOAT  r[seekKey], k
       OP_INDEX_SEEK_EQ        idxCursor, dataCursor, r[seekKey], keyType, notFoundPatch
       [Emit row or execute remaining predicates]
     notFoundPatch:
     ```
   - Calling `await qb.explain()` verifies index utilization:
     ```typescript
     const explain = await db.from('users').whereIn('id', [101, 202, 303]).explain();
     expect(explain.plan.scanType).toBe('IndexScan');
     expect(explain.plan.indexName).toBe('pk_users');
     ```
   - If the column is not indexed, `explain.plan.scanType` falls back to `'TableScan'`.

---

## 6. Sorting, Grouping & Pagination API

### 6.1 `orderBy`
```typescript
// Simple single-column
db.from('users').orderBy('name', 'asc');

// Multi-column array
db.from('users').orderBy([
  { col: 'dept', dir: 'asc' },
  { col: 'salary', dir: 'desc', nulls: 'last' },
]);
```

### 6.2 `groupBy` & `having`
```typescript
db.from('users')
  .select(['dept', 'count(*) as total_staff', 'avg(salary) as mean_sal'])
  .groupBy('dept')
  .having('total_staff', '>', 5);
```

### 6.3 Pagination (`limit`, `offset`)
```typescript
db.from('users')
  .orderBy('id')
  .offset(20)
  .limit(10);
```

---

## 7. Nested Queries & Subqueries (`from(subquery)`)

The Query Builder supports subqueries in the `from()` clause as derived tables:

```typescript
// SELECT name, score * 2 AS double_score FROM (SELECT upper(name) AS name, floor(score) AS score FROM students)
const subquery = db.from('students')
  .select([
    'upper(name) as name',
    'floor(score) as score',
  ])
  .where('active', '=', 1);

const results = await db.from(subquery)
  .select([
    'name',
    'score * 2 as double_score',
  ])
  .where('score', '>=', 60)
  .toArray();
```

### Execution Strategy
1. **Planner Inlining (Flattening)**:
   If the subquery does not contain `GROUP BY`, `LIMIT`, `OFFSET`, `DISTINCT`, or aggregates:
   - Outer references are substituted with inner expressions (`name` $\to$ `upper(name)`, `score * 2` $\to$ `floor(score) * 2`).
   - Outer and inner `WHERE` predicates merge with boolean `AND`.
   - Compiles into a single-pass streaming table scan with zero temporary tables.
2. **Ephemeral Table Materialization**:
   If the subquery contains `GROUP BY` or `LIMIT`:
   - Inner query writes results to an ephemeral B-Tree cursor (`OP_OPEN_EPHEMERAL`).
   - Outer query scans the ephemeral cursor.

> [!WARNING]
> **Subquery Boundary & `projectRow` Limitation:**
> In the current V1 architecture, client-side expression evaluations, UDFs, and custom alias mappings handled exclusively inside `QueryBuilder.projectRow()` only run at terminal execution (`.toArray()`, `.first()`). When a query is passed as a subquery, the VDBE executes native bytecode and does not run client-side `projectRow`. Subqueries currently only project native table columns and bytecode registers until scalar expressions are fully lowered into bytecode opcodes in the compiler.

---

## 8. Terminal Execution Methods

| Method | Return Type | Description |
| :--- | :--- | :--- |
| `.toArray()` | `Promise<DbRow[]>` | Executes query and returns all projected rows. |
| `.first()` | `Promise<DbRow \| null>` | Executes with implicit `LIMIT 1` and returns first row. |
| `.count()` | `Promise<number>` | Executes optimized count aggregation query. |
| `.explain()` | `Promise<ExplainOutput>` | Compiles query and returns disassembly assembly, bytecode size, and plan metadata. |

---

## 9. Implementation Checklist & Next Steps for `select`

- [x] Strict `SelectColumnSpec` definition (`{ col, as }`) and expression-based functions.
- [x] Deterministic dictionary mapping (`{[col]: alias}`).
- [x] Client-side scalar function projection in `QueryBuilder.projectRow`.
- [x] Comprehensive test suite for `select()` in `tests/query_builder.test.ts`.
- [ ] **Next Step 1: Move scalar function evaluation into VDBE Compiler**:
  - Emit `OP_STR_UPPER`, `OP_STR_LOWER`, `OP_MATH_FLOOR`, `OP_MATH_CEIL`, `OP_MATH_ABS` directly into bytecode registers.
  - Skip JS row post-processing when all selected columns are native expressions.
- [ ] **Next Step 2: Binary arithmetic expressions in bytecode**:
  - Support expressions like `col * 2` or `colA + colB` via `OP_ADD`, `OP_SUB`, `OP_MUL`, `OP_DIV`.
- [ ] **Next Step 3: Subquery support in `from()`**:
  - Implement `QueryBuilder.from(subquery: QueryBuilder)`.
  - Implement planner flattening optimization to inline inner expressions.
