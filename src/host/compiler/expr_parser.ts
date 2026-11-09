import {
  AggregateNotAllowedInWhereError,
  UnknownFunctionError,
  DbRow,
} from '../../types/index.js';
import { sql_like_match } from '../../core/js/vm.helpers.c.js';

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>=';

export type ExprNode =
  | { type: 'col'; name: string }
  | { type: 'literal'; value: number | string | boolean | null }
  | { type: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { type: 'fn'; name: string; args: ExprNode[] };

export interface ParsedSelectExpr {
  expr: ExprNode;
  alias: string;
}

export const BUILTIN_AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

export const BUILTIN_SCALARS = new Set([
  'upper',
  'lower',
  'length',
  'substr',
  'trim',
  'abs',
  'round',
  'floor',
  'ceil',
  'concat',
  'coalesce',
  'starts_with',
  'startswith',
  'ends_with',
  'endswith',
  'contains',
  'like',
  'levenshtein',
  'edit_distance',
  'fuzzy',
]);

export function isAggregateFunction(name: string): boolean {
  return BUILTIN_AGGREGATES.has(name.toLowerCase());
}

export function isBuiltinScalarFunction(name: string): boolean {
  return BUILTIN_SCALARS.has(name.toLowerCase());
}

export function isBuiltinFunction(name: string): boolean {
  return isAggregateFunction(name) || isBuiltinScalarFunction(name);
}

export function validateClause(
  expr: ExprNode,
  clause: 'select' | 'where' | 'having' | 'orderBy',
): void {
  if (clause === 'where') {
    if (expr.type === 'fn' && isAggregateFunction(expr.name)) {
      throw new AggregateNotAllowedInWhereError(expr.name);
    }
    if (expr.type === 'binary') {
      validateClause(expr.left, clause);
      validateClause(expr.right, clause);
    }
    if (expr.type === 'fn') {
      for (const arg of expr.args) {
        validateClause(arg, clause);
      }
    }
  }
}

// -------------------------------------------------------------
// Tokenizer & Pratt Parser for SQL Expressions
// -------------------------------------------------------------

type TokenType =
  | 'IDENT'
  | 'NUMBER'
  | 'STRING'
  | 'OP'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'STAR'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Number (int or float)
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < len && /[0-9]/.test(input[i + 1]))) {
      const start = i;
      let hasDot = false;
      while (i < len && (/[0-9]/.test(input[i]) || (input[i] === '.' && !hasDot))) {
        if (input[i] === '.') hasDot = true;
        i++;
      }
      tokens.push({ type: 'NUMBER', value: input.slice(start, i), pos: start });
      continue;
    }

    // Quoted string ('...' or "...")
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      let str = '';
      while (i < len && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < len) {
          i++;
          str += input[i];
        } else {
          str += input[i];
        }
        i++;
      }
      if (i < len && input[i] === quote) {
        i++;
      }
      tokens.push({ type: 'STRING', value: str, pos: start });
      continue;
    }

    // Punctuation
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(', pos: i++ });
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')', pos: i++ });
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'COMMA', value: ',', pos: i++ });
      continue;
    }

    // Operators
    if (ch === '<') {
      if (i + 1 < len && input[i + 1] === '=') {
        tokens.push({ type: 'OP', value: '<=', pos: i });
        i += 2;
        continue;
      }
      if (i + 1 < len && input[i + 1] === '>') {
        tokens.push({ type: 'OP', value: '!=', pos: i });
        i += 2;
        continue;
      }
      tokens.push({ type: 'OP', value: '<', pos: i++ });
      continue;
    }
    if (ch === '>') {
      if (i + 1 < len && input[i + 1] === '=') {
        tokens.push({ type: 'OP', value: '>=', pos: i });
        i += 2;
        continue;
      }
      tokens.push({ type: 'OP', value: '>', pos: i++ });
      continue;
    }
    if (ch === '=') {
      if (i + 1 < len && input[i + 1] === '=') {
        tokens.push({ type: 'OP', value: '=', pos: i });
        i += 2;
        continue;
      }
      tokens.push({ type: 'OP', value: '=', pos: i++ });
      continue;
    }
    if (ch === '!' && i + 1 < len && input[i + 1] === '=') {
      tokens.push({ type: 'OP', value: '!=', pos: i });
      i += 2;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '/' || ch === '%') {
      tokens.push({ type: 'OP', value: ch, pos: i++ });
      continue;
    }
    if (ch === '*') {
      // Disambiguate * (can be multiplication op or wildcard count(*))
      tokens.push({ type: 'STAR', value: '*', pos: i++ });
      continue;
    }

    // Identifier / Keyword (supports qualified identifiers like table.column)
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < len) {
        if (/[a-zA-Z0-9_]/.test(input[i])) {
          i++;
        } else if (input[i] === '.' && i + 1 < len && /[a-zA-Z_]/.test(input[i + 1])) {
          i += 2;
        } else {
          break;
        }
      }
      const val = input.slice(start, i);
      tokens.push({ type: 'IDENT', value: val, pos: start });
      continue;
    }

    // Unknown char, advance
    i++;
  }

  tokens.push({ type: 'EOF', value: '', pos: len });
  return tokens;
}

class ExpressionParser {
  private tokens: Token[];
  private cursor = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.cursor] ?? { type: 'EOF', value: '', pos: 0 };
  }

  private consume(): Token {
    const t = this.peek();
    this.cursor++;
    return t;
  }

  private match(type: TokenType, value?: string): boolean {
    const t = this.peek();
    if (t.type !== type) return false;
    if (value !== undefined && t.value.toLowerCase() !== value.toLowerCase()) return false;
    this.cursor++;
    return true;
  }

  private getPrecedence(token: Token): number {
    if (token.type === 'OP' || token.type === 'STAR') {
      if (
        token.value === '=' ||
        token.value === '!=' ||
        token.value === '<' ||
        token.value === '<=' ||
        token.value === '>' ||
        token.value === '>='
      ) {
        return 5;
      }
      if (token.value === '+' || token.value === '-') return 10;
      if (token.value === '*' || token.value === '/' || token.value === '%') return 20;
    }
    return 0;
  }

  parse(minPrecedence = 0): ExprNode {
    let left = this.parsePrimary();

    while (true) {
      const token = this.peek();
      const prec = this.getPrecedence(token);
      if (prec === 0 || prec <= minPrecedence) {
        break;
      }
      this.consume();
      const right = this.parse(prec);
      left = {
        type: 'binary',
        op: token.value as BinaryOp,
        left,
        right,
      };
    }

    return left;
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();

    // Unary minus: -number or -(expr)
    if (token.type === 'OP' && token.value === '-') {
      this.consume();
      const operand = this.parse(25);
      if (operand.type === 'literal' && typeof operand.value === 'number') {
        return { type: 'literal', value: -operand.value };
      }
      return {
        type: 'binary',
        op: '-',
        left: { type: 'literal', value: 0 },
        right: operand,
      };
    }

    // Number literal
    if (this.match('NUMBER')) {
      return { type: 'literal', value: Number(token.value) };
    }

    // String literal
    if (this.match('STRING')) {
      return { type: 'literal', value: token.value };
    }

    // Parentheses
    if (this.match('LPAREN')) {
      const expr = this.parse(0);
      if (!this.match('RPAREN')) {
        throw new Error('Unclosed parenthesis in expression');
      }
      return expr;
    }

    // Star wildcard (e.g. count(*))
    if (this.match('STAR')) {
      return { type: 'col', name: '*' };
    }

    // Identifier or Function Call
    if (token.type === 'IDENT') {
      this.consume();
      const name = token.value;

      // Check for literals: null, true, false
      const lower = name.toLowerCase();
      if (lower === 'null' && this.peek().type !== 'LPAREN') {
        return { type: 'literal', value: null };
      }
      if (lower === 'true' && this.peek().type !== 'LPAREN') {
        return { type: 'literal', value: true };
      }
      if (lower === 'false' && this.peek().type !== 'LPAREN') {
        return { type: 'literal', value: false };
      }

      // Function call: ident(...)
      if (this.match('LPAREN')) {
        const args: ExprNode[] = [];
        if (!this.match('RPAREN')) {
          while (true) {
            args.push(this.parse(0));
            if (this.match('COMMA')) {
              continue;
            }
            if (this.match('RPAREN')) {
              break;
            }
            throw new Error(`Expected ',' or ')' in argument list of function ${name}`);
          }
        }
        return {
          type: 'fn',
          name: lower,
          args,
        };
      }

      // Plain column reference
      return { type: 'col', name };
    }

    throw new Error(`Unexpected token "${token.value}" in expression at position ${token.pos}`);
  }
}

/**
 * Parses a raw SQL expression string into an AST ExprNode.
 */
export function parseExpression(sql: string): ExprNode {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error('Cannot parse empty expression');
  }
  const tokens = tokenize(trimmed);
  const parser = new ExpressionParser(tokens);
  return parser.parse(0);
}

/**
 * Splits a select expression string into expression and alias.
 * Safely looks for top-level ` AS ` outside parentheses and string literals.
 */
function splitAsAlias(raw: string): { exprStr: string; explicitAlias?: string } {
  let depth = 0;
  let inQuote: string | null = null;
  const len = raw.length;

  for (let i = 0; i < len; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === inQuote && raw[i - 1] !== '\\') {
        inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      depth--;
      continue;
    }

    if (depth === 0) {
      // Check for ' AS ' (case-insensitive)
      if (
        (ch === ' ' || ch === '\t') &&
        i + 4 < len &&
        raw.slice(i + 1, i + 3).toLowerCase() === 'as' &&
        /\s/.test(raw[i + 3])
      ) {
        const exprStr = raw.slice(0, i).trim();
        const explicitAlias = raw.slice(i + 4).trim();
        return { exprStr, explicitAlias };
      }
    }
  }

  return { exprStr: raw.trim() };
}

/**
 * Derives a human-friendly default alias if no explicit `AS alias` is provided.
 */
export function deriveDefaultAlias(expr: ExprNode): string {
  if (expr.type === 'col') {
    return expr.name.includes('.')
      ? expr.name.slice(expr.name.lastIndexOf('.') + 1)
      : expr.name;
  }
  if (expr.type === 'fn') {
    if (expr.args.length > 0 && expr.args[0].type === 'col' && expr.args[0].name !== '*') {
      const colName = expr.args[0].name.includes('.')
        ? expr.args[0].name.slice(expr.args[0].name.lastIndexOf('.') + 1)
        : expr.args[0].name;
      return `${expr.name}_${colName}`;
    }
    return expr.name;
  }
  if (expr.type === 'binary') {
    return 'expr';
  }
  return 'val';
}

/**
 * Parses a select clause item string (e.g. "abs(salary) as abs_salary" or "name").
 */
export function parseSelectExpr(raw: string): ParsedSelectExpr {
  const { exprStr, explicitAlias } = splitAsAlias(raw);
  const expr = parseExpression(exprStr);
  const alias = explicitAlias && explicitAlias.length > 0 ? explicitAlias : deriveDefaultAlias(expr);
  return { expr, alias };
}

/**
 * Extracts all column names referenced in an expression tree.
 */
export function extractReferencedColumns(expr: ExprNode): string[] {
  const cols = new Set<string>();
  function walk(node: ExprNode) {
    if (!node) return;
    if (node.type === 'col' && node.name !== '*') {
      cols.add(node.name);
    } else if (node.type === 'binary') {
      walk(node.left);
      walk(node.right);
    } else if (node.type === 'fn') {
      for (const a of node.args) walk(a);
    }
  }
  walk(expr);
  return Array.from(cols);
}

/**
 * Checks whether an expression tree contains any user-defined function with a `batchCall` implementation.
 */
export function exprHasBatchedUdf(expr: ExprNode, db: any): boolean {
  if (!expr || !db || typeof db.getUdf !== 'function') return false;
  let found = false;
  function walk(node: ExprNode) {
    if (!node || found) return;
    if (node.type === 'fn') {
      const entry = db.getUdf(node.name);
      if (entry?.def && typeof entry.def.batchCall === 'function') {
        found = true;
        return;
      }
      for (const a of node.args) walk(a);
    } else if (node.type === 'binary') {
      walk(node.left);
      walk(node.right);
    }
  }
  walk(expr);
  return found;
}

/**
 * Produces a normalized, canonical string representation of an expression AST
 * suitable for common subexpression elimination (CSE) and query caching.
 */
export function canonicalExpr(node: ExprNode): string {
  if (!node) return '';
  switch (node.type) {
    case 'literal':
      return typeof node.value === 'string'
        ? `"${node.value}"`
        : String(node.value);
    case 'col':
      return node.name.toLowerCase();
    case 'fn':
      return `${node.name.toLowerCase()}(${node.args.map(canonicalExpr).join(',')})`;
    case 'binary':
      return `(${canonicalExpr(node.left)}${node.op}${canonicalExpr(node.right)})`;
  }
}

// -------------------------------------------------------------
// Drizzle-style Standalone Expression Helpers (col, fn)
// -------------------------------------------------------------

export class ExpressionBuilder {
  readonly node: ExprNode;

  constructor(node: ExprNode) {
    this.node = node;
  }

  add(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '+',
      left: this.node,
      right: toExprNode(other),
    });
  }

  sub(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '-',
      left: this.node,
      right: toExprNode(other),
    });
  }

  mul(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '*',
      left: this.node,
      right: toExprNode(other),
    });
  }

  div(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '/',
      left: this.node,
      right: toExprNode(other),
    });
  }

  mod(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '%',
      left: this.node,
      right: toExprNode(other),
    });
  }

  eq(other: ExprNode | ExpressionBuilder | number | string | boolean | null): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '=',
      left: this.node,
      right: toExprNode(other),
    });
  }

  ne(other: ExprNode | ExpressionBuilder | number | string | boolean | null): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '!=',
      left: this.node,
      right: toExprNode(other),
    });
  }

  lt(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '<',
      left: this.node,
      right: toExprNode(other),
    });
  }

  lte(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '<=',
      left: this.node,
      right: toExprNode(other),
    });
  }

  gt(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '>',
      left: this.node,
      right: toExprNode(other),
    });
  }

  gte(other: ExprNode | ExpressionBuilder | number | string): ExpressionBuilder {
    return new ExpressionBuilder({
      type: 'binary',
      op: '>=',
      left: this.node,
      right: toExprNode(other),
    });
  }

  as(alias: string): ParsedSelectExpr {
    return {
      expr: this.node,
      alias,
    };
  }
}

function toExprNode(val: ExprNode | ExpressionBuilder | number | string | boolean | null): ExprNode {
  if (val === null) {
    return { type: 'literal', value: null };
  }
  if (typeof val === 'boolean') {
    return { type: 'literal', value: val };
  }
  if (val instanceof ExpressionBuilder) {
    return val.node;
  }
  if (typeof val === 'number') {
    return { type: 'literal', value: val };
  }
  if (typeof val === 'string') {
    return { type: 'literal', value: val };
  }
  return val;
}

export function col(name: string): ExpressionBuilder {
  return new ExpressionBuilder({ type: 'col', name });
}

export function exp(sqlStr: string): ExpressionBuilder {
  return new ExpressionBuilder(parseExpression(sqlStr));
}

export const sql = exp;

export interface FnNamespace {
  (name: string, ...args: (ExprNode | ExpressionBuilder | number | string)[]): ExpressionBuilder;
  upper(expr: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  lower(expr: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  length(expr: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  substr(
    expr: ExprNode | ExpressionBuilder | string,
    start: number | ExprNode | ExpressionBuilder,
    len?: number | ExprNode | ExpressionBuilder,
  ): ExpressionBuilder;
  trim(expr: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  abs(expr: ExprNode | ExpressionBuilder | number): ExpressionBuilder;
  round(expr: ExprNode | ExpressionBuilder | number): ExpressionBuilder;
  floor(expr: ExprNode | ExpressionBuilder | number): ExpressionBuilder;
  ceil(expr: ExprNode | ExpressionBuilder | number): ExpressionBuilder;
  count(expr?: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  sum(expr: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  avg(expr: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  min(expr: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  max(expr: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  concat(...exprs: (ExprNode | ExpressionBuilder | string)[]): ExpressionBuilder;
  coalesce(...exprs: (ExprNode | ExpressionBuilder | string | null)[]): ExpressionBuilder;
  levenshtein(s1: ExprNode | ExpressionBuilder | string, s2: ExprNode | ExpressionBuilder | string): ExpressionBuilder;
  fuzzy(
    str: ExprNode | ExpressionBuilder | string,
    pattern: ExprNode | ExpressionBuilder | string,
    maxDistance?: number | ExprNode | ExpressionBuilder,
  ): ExpressionBuilder;
}

function wrapFn(name: string, args: (ExprNode | ExpressionBuilder | any)[]): ExpressionBuilder {
  return new ExpressionBuilder({
    type: 'fn',
    name: name.toLowerCase(),
    args: args.map((a) => (typeof a === 'string' && !a.startsWith("'") ? col(a).node : toExprNode(a))),
  });
}

const fnBase = (
  name: string,
  ...args: (ExprNode | ExpressionBuilder | number | string)[]
) => {
  return wrapFn(name, args);
};

const fnMethods = {
  upper: (expr: any) => wrapFn('upper', [expr]),
  lower: (expr: any) => wrapFn('lower', [expr]),
  length: (expr: any) => wrapFn('length', [expr]),
  substr: (expr: any, start: any, len?: any) => {
    const args = [expr, start];
    if (len !== undefined) args.push(len);
    return wrapFn('substr', args);
  },
  trim: (expr: any) => wrapFn('trim', [expr]),
  abs: (expr: any) => wrapFn('abs', [expr]),
  round: (expr: any) => wrapFn('round', [expr]),
  floor: (expr: any) => wrapFn('floor', [expr]),
  ceil: (expr: any) => wrapFn('ceil', [expr]),
  count: (expr?: any) => wrapFn('count', [expr ?? col('*').node]),
  sum: (expr: any) => wrapFn('sum', [expr]),
  avg: (expr: any) => wrapFn('avg', [expr]),
  min: (expr: any) => wrapFn('min', [expr]),
  max: (expr: any) => wrapFn('max', [expr]),
  concat: (...exprs: any[]) => wrapFn('concat', exprs),
  coalesce: (...exprs: any[]) => wrapFn('coalesce', exprs),
  levenshtein: (s1: any, s2: any) => wrapFn('levenshtein', [s1, s2]),
  fuzzy: (str: any, pattern: any, maxDistance?: any) => {
    const args = [str, pattern];
    if (maxDistance !== undefined) args.push(maxDistance);
    return wrapFn('fuzzy', args);
  },
};

for (const [key, value] of Object.entries(fnMethods)) {
  Object.defineProperty(fnBase, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export const fn: FnNamespace = fnBase as any;

export function levenshteinDistance(s1: string, s2: string, maxDist: number = 64): number {
  if (s1 === s2) return 0;
  const l1 = s1.length;
  const l2 = s2.length;
  const diff = Math.abs(l1 - l2);
  if (diff > maxDist) return maxDist + 1;
  if (l1 === 0) return l2 <= maxDist ? l2 : maxDist + 1;
  if (l2 === 0) return l1 <= maxDist ? l1 : maxDist + 1;

  const boundedL1 = Math.min(l1, 64);
  const boundedL2 = Math.min(l2, 64);

  const prev = new Uint32Array(boundedL2 + 1);
  const cur = new Uint32Array(boundedL2 + 1);
  const prev2 = new Uint32Array(boundedL2 + 1);

  for (let j = 0; j <= boundedL2; j++) {
    prev[j] = j;
    prev2[j] = j;
  }

  const s1Low = s1.toLowerCase();
  const s2Low = s2.toLowerCase();

  for (let i = 1; i <= boundedL1; i++) {
    cur[0] = i;
    const c1 = s1Low.charCodeAt(i - 1);

    for (let j = 1; j <= boundedL2; j++) {
      const c2 = s2Low.charCodeAt(j - 1);
      const cost = c1 === c2 ? 0 : 1;

      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      let minVal = Math.min(del, ins, sub);

      if (i > 1 && j > 1) {
        const c1Prev = s1Low.charCodeAt(i - 2);
        const c2Prev = s2Low.charCodeAt(j - 2);
        if (c1 === c2Prev && c1Prev === c2) {
          const trans = prev2[j - 2] + 1;
          if (trans < minVal) minVal = trans;
        }
      }
      cur[j] = minVal;
    }
    prev2.set(prev);
    prev.set(cur);
  }
  return prev[boundedL2];
}

export function fuzzyMatchString(str: string, pattern: string, maxDistance?: number): boolean {
  if (!pattern) return true;
  if (!str) return false;
  const sLow = str.toLowerCase();
  const pLow = pattern.toLowerCase();
  if (sLow.includes(pLow)) return true;

  const maxDist = maxDistance !== undefined ? maxDistance : (pLow.length <= 4 ? 1 : 2);
  const wholeDist = levenshteinDistance(sLow, pLow, maxDist);
  if (wholeDist <= maxDist) return true;

  // Word-by-word matching
  const words = sLow.split(/[\s,._\-]+/);
  for (const w of words) {
    if (w.length === 0) continue;
    if (w.startsWith(pLow) || pLow.startsWith(w)) return true;
    const wDist = levenshteinDistance(w, pLow, maxDist);
    if (wDist <= maxDist) return true;
  }
  return false;
}

export function evalScalarFn(name: string, args: any[]): any {
  switch (name) {
    case 'upper':
      return args[0] !== null && args[0] !== undefined
        ? String(args[0]).toUpperCase()
        : null;
    case 'lower':
      return args[0] !== null && args[0] !== undefined
        ? String(args[0]).toLowerCase()
        : null;
    case 'length':
      return args[0] !== null && args[0] !== undefined
        ? String(args[0]).length
        : null;
    case 'trim':
      return args[0] !== null && args[0] !== undefined
        ? String(args[0]).trim()
        : null;
    case 'substr': {
      if (args[0] === null || args[0] === undefined) return null;
      const str = String(args[0]);
      const start = Math.max(0, (Number(args[1]) || 1) - 1);
      const len =
        args[2] !== null && args[2] !== undefined
          ? Number(args[2])
          : undefined;
      return len !== undefined
        ? str.substring(start, start + len)
        : str.substring(start);
    }
    case 'abs':
      return args[0] !== null && args[0] !== undefined
        ? Math.abs(Number(args[0]))
        : null;
    case 'round':
      return args[0] !== null && args[0] !== undefined
        ? Math.round(Number(args[0]))
        : null;
    case 'floor':
      return args[0] !== null && args[0] !== undefined
        ? Math.floor(Number(args[0]))
        : null;
    case 'ceil':
      return args[0] !== null && args[0] !== undefined
        ? Math.ceil(Number(args[0]))
        : null;
    case 'concat': {
      if (args.some((a) => a === null || a === undefined)) return null;
      return args.map(String).join('');
    }
    case 'coalesce': {
      for (const a of args) {
        if (a !== null && a !== undefined) return a;
      }
      return null;
    }
    case 'starts_with':
    case 'startswith':
      return args[0] !== null && args[0] !== undefined && args[1] !== null && args[1] !== undefined
        ? String(args[0]).startsWith(String(args[1])) ? 1 : 0
        : null;
    case 'ends_with':
    case 'endswith':
      return args[0] !== null && args[0] !== undefined && args[1] !== null && args[1] !== undefined
        ? String(args[0]).endsWith(String(args[1])) ? 1 : 0
        : null;
    case 'contains':
      return args[0] !== null && args[0] !== undefined && args[1] !== null && args[1] !== undefined
        ? String(args[0]).includes(String(args[1])) ? 1 : 0
        : null;
    case 'like':
      return args[0] !== null && args[0] !== undefined && args[1] !== null && args[1] !== undefined
        ? sql_like_match(String(args[0]), String(args[1])) ? 1 : 0
        : null;
    case 'levenshtein':
    case 'edit_distance': {
      if (args[0] === null || args[0] === undefined || args[1] === null || args[1] === undefined) return null;
      return levenshteinDistance(String(args[0]), String(args[1]));
    }
    case 'fuzzy': {
      if (args[0] === null || args[0] === undefined || args[1] === null || args[1] === undefined) return null;
      const maxDist = args[2] !== null && args[2] !== undefined ? Number(args[2]) : undefined;
      return fuzzyMatchString(String(args[0]), String(args[1]), maxDist) ? 1 : 0;
    }
    default:
      return null;
  }
}

/**
 * Evaluates an ExprNode AST against a database row.
 * Used for fallback projection and post-processing.
 */
export function evalExprNode(
  expr: ExprNode,
  row: DbRow,
  udfs?:
    | Map<string, { call?: (...args: any[]) => any; batchCall?: (argsBatch: any[][]) => any[] } | ((...args: any[]) => any)>
    | Record<string, { call?: (...args: any[]) => any; batchCall?: (argsBatch: any[][]) => any[] } | ((...args: any[]) => any)>
    | ((name: string) => { call?: (...args: any[]) => any; batchCall?: (argsBatch: any[][]) => any[] } | ((...args: any[]) => any) | undefined),
): any {
  switch (expr.type) {
    case 'literal':
      return expr.value;
    case 'col': {
      if (expr.name === '*') return null;
      return row[expr.name] !== undefined ? row[expr.name] : null;
    }
    case 'binary': {
      const left = evalExprNode(expr.left, row, udfs);
      const right = evalExprNode(expr.right, row, udfs);
      if (
        left === null ||
        right === null ||
        left === undefined ||
        right === undefined
      ) {
        return null;
      }
      if (
        expr.op === '=' ||
        expr.op === '!=' ||
        expr.op === '<' ||
        expr.op === '<=' ||
        expr.op === '>' ||
        expr.op === '>='
      ) {
        const cmp =
          typeof left === 'string' && typeof right === 'string'
            ? left < right
              ? -1
              : left > right
                ? 1
                : 0
            : Number(left) < Number(right)
              ? -1
              : Number(left) > Number(right)
                ? 1
                : 0;
        switch (expr.op) {
          case '=':
            return cmp === 0 ? 1 : 0;
          case '!=':
            return cmp !== 0 ? 1 : 0;
          case '<':
            return cmp < 0 ? 1 : 0;
          case '<=':
            return cmp <= 0 ? 1 : 0;
          case '>':
            return cmp > 0 ? 1 : 0;
          case '>=':
            return cmp >= 0 ? 1 : 0;
        }
      }
      const numL = Number(left);
      const numR = Number(right);
      switch (expr.op) {
        case '+':
          return numL + numR;
        case '-':
          return numL - numR;
        case '*':
          return numL * numR;
        case '/':
          return numR === 0 ? null : numL / numR;
        case '%':
          return numR === 0 ? null : numL % numR;
      }
      return null;
    }
    case 'fn': {
      const name = expr.name.toLowerCase();
      // Check built-in aggregates first (if already computed by aggregator, row has alias or func)
      if (isAggregateFunction(name)) {
        if (row[name] !== undefined) return row[name];
        const arg0 = expr.args[0];
        if (arg0 && arg0.type === 'col') {
          const colKey = `${name}_${arg0.name}`;
          if (row[colKey] !== undefined) return row[colKey];
        }
        return null;
      }
      const args = expr.args.map((a) => evalExprNode(a, row, udfs));
      if (BUILTIN_SCALARS.has(name)) {
        return evalScalarFn(name, args);
      }
      let fnCb: ((...a: any[]) => any) | undefined;
      if (typeof udfs === 'function') {
        const entry: any = udfs(name);
        fnCb = typeof entry === 'function' ? entry : entry?.call ?? (entry?.batchCall ? (...a: any[]) => entry.batchCall([a])[0] : undefined);
      } else if (udfs instanceof Map) {
        const entry: any = udfs.get(name);
        fnCb = typeof entry === 'function' ? entry : entry?.call ?? (entry?.batchCall ? (...a: any[]) => entry.batchCall([a])[0] : undefined);
      } else if (udfs && typeof udfs === 'object') {
        const entry: any = (udfs as any)[name];
        fnCb = typeof entry === 'function' ? entry : entry?.call ?? (entry?.batchCall ? (...a: any[]) => entry.batchCall([a])[0] : undefined);
      }
      if (fnCb) {
        return fnCb(...args);
      }
      throw new UnknownFunctionError(name);
    }
  }
}

/**
 * Evaluates an ExprNode AST in vector batches against a slice of database rows.
 * If any UDF provides `batchCall`, calls are dispatched in power-of-two batches (e.g. 128 rows per call)
 * instead of incurring per-row call overhead. Power-of-two sizing (128) aligns with CPU cache lines
 * and V8 memory allocation buckets.
 */
export function evalExprNodeBatch(
  expr: ExprNode,
  rows: DbRow[],
  udfs?:
    | Map<string, { call?: (...args: any[]) => any; batchCall?: (argsBatch: any[][]) => any[]; deterministic?: boolean } | ((...args: any[]) => any)>
    | Record<string, { call?: (...args: any[]) => any; batchCall?: (argsBatch: any[][]) => any[]; deterministic?: boolean } | ((...args: any[]) => any)>
    | ((name: string) => { call?: (...args: any[]) => any; batchCall?: (argsBatch: any[][]) => any[]; deterministic?: boolean } | ((...args: any[]) => any) | undefined),
  batchSize: number = 128,
  exprCache?: WeakMap<DbRow, Map<string, any>>,
): any[] {
  const n = rows.length;
  if (n === 0) return [];

  switch (expr.type) {
    case 'literal': {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = expr.value;
      return out;
    }
    case 'col': {
      const out = new Array(n);
      if (expr.name === '*') {
        for (let i = 0; i < n; i++) out[i] = null;
      } else {
        const colName = expr.name;
        for (let i = 0; i < n; i++) {
          const val = rows[i][colName];
          out[i] = val !== undefined ? val : null;
        }
      }
      return out;
    }
    case 'binary': {
      const leftVals = evalExprNodeBatch(expr.left, rows, udfs, batchSize, exprCache);
      const rightVals = evalExprNodeBatch(expr.right, rows, udfs, batchSize, exprCache);
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const left = leftVals[i];
        const right = rightVals[i];
        if (left === null || right === null || left === undefined || right === undefined) {
          out[i] = null;
          continue;
        }
        if (
          expr.op === '=' ||
          expr.op === '!=' ||
          expr.op === '<' ||
          expr.op === '<=' ||
          expr.op === '>' ||
          expr.op === '>='
        ) {
          const cmp =
            typeof left === 'string' && typeof right === 'string'
              ? left < right
                ? -1
                : left > right
                  ? 1
                  : 0
              : Number(left) < Number(right)
                ? -1
                : Number(left) > Number(right)
                  ? 1
                  : 0;
          switch (expr.op) {
            case '=': out[i] = cmp === 0 ? 1 : 0; break;
            case '!=': out[i] = cmp !== 0 ? 1 : 0; break;
            case '<': out[i] = cmp < 0 ? 1 : 0; break;
            case '<=': out[i] = cmp <= 0 ? 1 : 0; break;
            case '>': out[i] = cmp > 0 ? 1 : 0; break;
            case '>=': out[i] = cmp >= 0 ? 1 : 0; break;
          }
        } else {
          const numL = Number(left);
          const numR = Number(right);
          switch (expr.op) {
            case '+': out[i] = numL + numR; break;
            case '-': out[i] = numL - numR; break;
            case '*': out[i] = numL * numR; break;
            case '/': out[i] = numR === 0 ? null : numL / numR; break;
            case '%': out[i] = numR === 0 ? null : numL % numR; break;
            default: out[i] = null; break;
          }
        }
      }
      return out;
    }
    case 'fn': {
      const name = expr.name.toLowerCase();
      if (isAggregateFunction(name)) {
        return rows.map((r) => evalExprNode(expr, r, udfs as any));
      }

      let udfEntry: any;
      if (typeof udfs === 'function') {
        udfEntry = udfs(name);
      } else if (udfs instanceof Map) {
        udfEntry = udfs.get(name);
      } else if (udfs && typeof udfs === 'object') {
        udfEntry = (udfs as any)[name];
      }

      const isDeterministic =
        typeof udfEntry === 'object' && udfEntry !== null && udfEntry.deterministic !== undefined
          ? Boolean(udfEntry.deterministic)
          : name !== 'random';

      const cacheKey = exprCache && isDeterministic ? canonicalExpr(expr) : null;
      if (cacheKey) {
        let allCached = true;
        for (let i = 0; i < n; i++) {
          const rowMap = exprCache!.get(rows[i]);
          if (!rowMap || !rowMap.has(cacheKey)) {
            allCached = false;
            break;
          }
        }
        if (allCached) {
          const out = new Array(n);
          for (let i = 0; i < n; i++) {
            out[i] = exprCache!.get(rows[i])!.get(cacheKey);
          }
          return out;
        }
      }

      const argsVals: any[][] = expr.args.map((a) =>
        evalExprNodeBatch(a, rows, udfs, batchSize, exprCache),
      );

      let out: any[];

      if (udfEntry) {
        const batchFn =
          typeof udfEntry === 'object' && typeof udfEntry.batchCall === 'function'
            ? udfEntry.batchCall
            : undefined;
        const callFn = typeof udfEntry === 'function' ? udfEntry : udfEntry.call;

        const numArgs = expr.args.length;
        if (batchFn) {
          out = new Array(n);
          for (let start = 0; start < n; start += batchSize) {
            const end = Math.min(start + batchSize, n);
            const batchLen = end - start;
            const batchArgList: any[][] = new Array(batchLen);
            if (numArgs === 1) {
              const a0 = argsVals[0];
              for (let i = start; i < end; i++) {
                batchArgList[i - start] = [a0[i]];
              }
            } else if (numArgs === 2) {
              const a0 = argsVals[0];
              const a1 = argsVals[1];
              for (let i = start; i < end; i++) {
                batchArgList[i - start] = [a0[i], a1[i]];
              }
            } else if (numArgs === 3) {
              const a0 = argsVals[0];
              const a1 = argsVals[1];
              const a2 = argsVals[2];
              for (let i = start; i < end; i++) {
                batchArgList[i - start] = [a0[i], a1[i], a2[i]];
              }
            } else {
              for (let i = start; i < end; i++) {
                const rowArgs = new Array(numArgs);
                for (let aIdx = 0; aIdx < numArgs; aIdx++) {
                  rowArgs[aIdx] = argsVals[aIdx][i];
                }
                batchArgList[i - start] = rowArgs;
              }
            }
            const resBatch = batchFn(batchArgList);
            for (let i = start; i < end; i++) {
              out[i] = resBatch[i - start];
            }
          }
        } else if (callFn) {
          out = new Array(n);
          if (numArgs === 1) {
            const a0 = argsVals[0];
            for (let i = 0; i < n; i++) out[i] = callFn(a0[i]);
          } else if (numArgs === 2) {
            const a0 = argsVals[0];
            const a1 = argsVals[1];
            for (let i = 0; i < n; i++) out[i] = callFn(a0[i], a1[i]);
          } else if (numArgs === 3) {
            const a0 = argsVals[0];
            const a1 = argsVals[1];
            const a2 = argsVals[2];
            for (let i = 0; i < n; i++) out[i] = callFn(a0[i], a1[i], a2[i]);
          } else {
            for (let i = 0; i < n; i++) {
              const rowArgs = new Array(numArgs);
              for (let aIdx = 0; aIdx < numArgs; aIdx++) {
                rowArgs[aIdx] = argsVals[aIdx][i];
              }
              out[i] = callFn(...rowArgs);
            }
          }
        } else {
          throw new UnknownFunctionError(name);
        }
      } else if (BUILTIN_SCALARS.has(name)) {
        out = new Array(n);
        for (let i = 0; i < n; i++) {
          const rowArgs = expr.args.map((_, aIdx) => argsVals[aIdx][i]);
          out[i] = evalScalarFn(name, rowArgs);
        }
      } else {
        throw new UnknownFunctionError(name);
      }

      if (cacheKey) {
        for (let i = 0; i < n; i++) {
          let rowMap = exprCache!.get(rows[i]);
          if (!rowMap) {
            rowMap = new Map<string, any>();
            exprCache!.set(rows[i], rowMap);
          }
          rowMap.set(cacheKey, out[i]);
        }
      }
      return out;
    }
  }
}

