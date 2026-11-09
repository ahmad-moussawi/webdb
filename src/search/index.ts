/**
 * @file Browser-native fuzzy & typo-tolerant search extension for WebDB.
 * Zero external dependencies: utilizes modern browser Intl.Segmenter, Unicode normalization,
 * and Damerau-Levenshtein distance for fast client-side full-text search.
 */

import {
  DataType,
  ExpressionBuilder,
  col,
  fn,
  type QueryBuilder,
  type WebDB,
} from '@ahmadmoussawi/webdb';

// ============================================================================
// 1. Text Normalization, Tokenization & Distance Primitives
// ============================================================================

/**
 * Normalizes a text by trimming, lowercasing, and stripping Unicode diacritics/accents
 * (e.g. "Café" -> "cafe", "München" -> "munchen").
 */
export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

let cachedSegmenter: any = null;
let cachedLocale = '';

/**
 * Splits text into normalized, word-like tokens. Uses the browser's native
 * `Intl.Segmenter` where available, with a resilient Unicode regex fallback.
 */
export function tokenize(value: unknown, locale: string = 'en'): string[] {
  const norm = normalizeText(value);
  if (!norm) return [];

  if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
    try {
      if (!cachedSegmenter || cachedLocale !== locale) {
        cachedSegmenter = new (Intl as any).Segmenter(locale, { granularity: 'word' });
        cachedLocale = locale;
      }
      const tokens: string[] = [];
      for (const seg of cachedSegmenter.segment(norm)) {
        if (seg.isWordLike) {
          const w = seg.segment.trim();
          if (w) tokens.push(w);
        }
      }
      if (tokens.length > 0) return tokens;
    } catch {
      // Fall through to regex if Segmenter throws for an unsupported locale
    }
  }

  // Unicode letter & number word matching fallback
  return norm.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Splits text into character n-grams of length `n` (default: 3 / trigrams).
 * E.g., `ngrams("webdb", 3)` -> `["web", "ebd", "bdb"]`.
 * If `pad` is true, pads start and end with boundary markers `^` and `$`.
 */
export function ngrams(
  value: unknown,
  n: number = 3,
  options?: { pad?: boolean; locale?: string }
): string[] {
  const norm = normalizeText(value);
  if (!norm || n <= 0) return [];

  const tokens = tokenize(norm, options?.locale);
  const result: string[] = [];

  for (const token of tokens) {
    const text = options?.pad
      ? `${'^'.repeat(Math.max(1, n - 1))}${token}${'$'.repeat(Math.max(1, n - 1))}`
      : token;

    if (text.length < n) {
      result.push(text);
      continue;
    }

    for (let i = 0; i <= text.length - n; i++) {
      result.push(text.slice(i, i + n));
    }
  }

  return result;
}

/**
 * Splits text into word-level n-grams (e.g. bigrams, trigrams).
 * E.g., `wordNgrams("Fast relational database in browser", 2)` ->
 * `["fast relational", "relational database", "database in", "in browser"]`.
 */
export function wordNgrams(
  value: unknown,
  n: number = 2,
  options?: { locale?: string }
): string[] {
  const tokens = tokenize(value, options?.locale);
  if (tokens.length < n) return tokens.length > 0 ? [tokens.join(' ')] : [];

  const result: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    result.push(tokens.slice(i, i + n).join(' '));
  }
  return result;
}

/**
 * Computes Sørensen-Dice similarity coefficient (between 0.0 and 1.0)
 * using character n-grams between two strings.
 * Formula: 2 * |A ∩ B| / (|A| + |B|)
 */
export function ngramSimilarity(
  a: string,
  b: string,
  n: number = 3,
  options?: { pad?: boolean }
): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const gramsA = ngrams(a, n, options);
  const gramsB = ngrams(b, n, options);

  if (gramsA.length === 0 || gramsB.length === 0) return 0.0;

  const countsA = new Map<string, number>();
  for (const g of gramsA) {
    countsA.set(g, (countsA.get(g) ?? 0) + 1);
  }

  let intersection = 0;
  for (const g of gramsB) {
    const count = countsA.get(g);
    if (count && count > 0) {
      intersection++;
      countsA.set(g, count - 1);
    }
  }

  return (2.0 * intersection) / (gramsA.length + gramsB.length);
}

/**
 * Computes the restricted Damerau-Levenshtein distance (Optimal String Alignment)
 * between two strings. Correctly accounts for insertions, deletions, substitutions,
 * and adjacent character transpositions (e.g. "tehs" -> "thes" = 1 edit).
 * Supports bounded early exit if distance exceeds maxDistance.
 */
export function damerauLevenshtein(
  a: string,
  b: string,
  maxDistance: number = Infinity
): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDistance) return maxDistance + 1;
  if (la === 0) return lb <= maxDistance ? lb : maxDistance + 1;
  if (lb === 0) return la <= maxDistance ? la : maxDistance + 1;

  const d: number[][] = [];
  for (let i = 0; i <= la; i++) {
    d[i] = new Array(lb + 1);
    d[i][0] = i;
  }
  for (let j = 0; j <= lb; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= la; i++) {
    let rowMin = d[i][0];
    const ai = a[i - 1];

    for (let j = 1; j <= lb; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      let minVal = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      );

      // Transposition
      if (
        i > 1 &&
        j > 1 &&
        ai === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        const transVal = d[i - 2][j - 2] + 1;
        if (transVal < minVal) {
          minVal = transVal;
        }
      }

      d[i][j] = minVal;
      if (minVal < rowMin) rowMin = minVal;
    }

    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
  }

  return d[la][lb];
}

/**
 * Returns true if the Damerau-Levenshtein distance between a and b is <= max.
 */
export function withinEdits(a: string, b: string, max: number): boolean {
  return damerauLevenshtein(a, b, max) <= max;
}

/** Match classification: 0 = none, 1 = typo (fuzzy), 2 = prefix, 3 = exact. */
export type MatchKind = 0 | 1 | 2 | 3;

export interface MatchOptions {
  /** Allow typo tolerance (Damerau-Levenshtein edit distance). Defaults to true. */
  fuzzy?: boolean;
  /** Allow prefix matching for typing-as-you-type. Defaults to true. */
  prefix?: boolean;
  /** Minimum token length required to trigger prefix matching. Defaults to 2. */
  prefixMinLength?: number;
  /** Maximum edit distance allowed, or a function resolving it per token. */
  maxDistance?: number | ((token: string) => number);
}

/**
 * Standard default typo tolerance based on token length:
 * - < 4 chars: 0 edits (exact or prefix only)
 * - 4..7 chars: 1 edit
 * - >= 8 chars: 2 edits
 */
export function defaultMaxDistance(token: string): number {
  if (token.length < 4) return 0;
  if (token.length < 8) return 1;
  return 2;
}

/**
 * Evaluates the match quality between a word and a search token.
 */
export function matchWord(
  word: string,
  token: string,
  options?: MatchOptions
): MatchKind {
  if (!word || !token) return 0;
  if (word === token) return 3;

  const prefix = options?.prefix !== false;
  const prefixMinLength = options?.prefixMinLength ?? 2;
  if (prefix && token.length >= prefixMinLength && word.startsWith(token)) {
    return 2;
  }

  const fuzzy = options?.fuzzy !== false;
  if (fuzzy) {
    const maxDist =
      typeof options?.maxDistance === 'function'
        ? options.maxDistance(token)
        : typeof options?.maxDistance === 'number'
          ? options.maxDistance
          : defaultMaxDistance(token);

    if (maxDist > 0 && damerauLevenshtein(word, token, maxDist) <= maxDist) {
      return 1;
    }
  }

  return 0;
}

/**
 * Finds the highest quality match between a list of document words and a search token.
 */
export function bestMatch(
  wordList: string[],
  token: string,
  options?: MatchOptions
): MatchKind {
  let result: MatchKind = 0;
  for (const w of wordList) {
    const m = matchWord(w, token, options);
    if (m > result) {
      result = m;
      if (result === 3) break;
    }
  }
  return result;
}

// ============================================================================
// 2. Highlighting & Contextual Snippets
// ============================================================================

/** Escapes special HTML characters to prevent XSS in rendered snippets. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface HighlightOptions extends MatchOptions {
  /** HTML tag used for matches. Defaults to 'mark'. */
  tag?: string;
  /** Optional CSS class applied to the tag. */
  className?: string;
  /** Locale for tokenization. Defaults to 'en'. */
  locale?: string;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * Wraps all words in text that match the search query with HTML highlight tags.
 * Output is safely HTML-escaped and safe for `v-html` or `dangerouslySetInnerHTML`.
 */
export function highlight(
  text: unknown,
  query: unknown,
  options?: HighlightOptions
): string {
  const source = String(text ?? '');
  if (!source) return '';

  const tokens = tokenize(query, options?.locale);
  if (tokens.length === 0) {
    return escapeHtml(source);
  }

  const tag = options?.tag ?? 'mark';
  const openTag = options?.className
    ? `<${tag} class="${escapeHtml(options.className)}">`
    : `<${tag}>`;
  const closeTag = `</${tag}>`;

  let out = '';
  let last = 0;

  for (const m of source.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    const word = m[0];
    const normWord = normalizeText(word);

    const isMatch = tokens.some((tok) => matchWord(normWord, tok, options) > 0);

    out += escapeHtml(source.slice(last, start));
    if (isMatch) {
      out += `${openTag}${escapeHtml(word)}${closeTag}`;
    } else {
      out += escapeHtml(word);
    }
    last = start + word.length;
  }

  out += escapeHtml(source.slice(last));
  return out;
}

export interface SnippetOptions extends HighlightOptions {
  /** Target character length for the snippet. Defaults to 140. */
  size?: number;
  /** Ellipsis string appended/prepended when excerpted. Defaults to '…'. */
  ellipsis?: string;
}

/**
 * Extracts a contextual window around the first matching term, wrapped in highlighted HTML.
 */
export function snippet(
  text: unknown,
  query: unknown,
  options?: SnippetOptions
): string {
  const source = String(text ?? '');
  if (!source) return '';

  const size = options?.size ?? 140;
  const ellipsis = options?.ellipsis ?? '…';
  const tokens = tokenize(query, options?.locale);

  if (tokens.length === 0) {
    if (source.length <= size) {
      return highlight(source, '', options);
    }
    const truncated = source.slice(0, size).trimEnd();
    return `${highlight(truncated, '', options)}${ellipsis}`;
  }

  let firstMatchIndex = -1;
  let firstMatchLength = 0;

  for (const m of source.matchAll(WORD_RE)) {
    const word = m[0];
    const normWord = normalizeText(word);
    if (tokens.some((tok) => matchWord(normWord, tok, options) > 0)) {
      firstMatchIndex = m.index ?? 0;
      firstMatchLength = word.length;
      break;
    }
  }

  if (firstMatchIndex === -1) {
    if (source.length <= size) {
      return highlight(source, '', options);
    }
    const truncated = source.slice(0, size).trimEnd();
    return `${highlight(truncated, '', options)}${ellipsis}`;
  }

  let start = Math.max(0, firstMatchIndex - Math.floor(size / 3));
  let end = Math.min(source.length, start + size);

  if (start > 0) {
    const nextSpace = source.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace < firstMatchIndex) {
      start = nextSpace + 1;
    }
  }

  if (end < source.length) {
    const prevSpace = source.lastIndexOf(' ', end);
    if (prevSpace > firstMatchIndex + firstMatchLength) {
      end = prevSpace;
    }
  }

  const excerpt = source.slice(start, end).trim();
  const highlighted = highlight(excerpt, query, options);
  const prefix = start > 0 ? ellipsis : '';
  const suffix = end < source.length ? ellipsis : '';

  return `${prefix}${highlighted}${suffix}`;
}

/** Counts words in a text string. */
export function wordCount(text: unknown): number {
  return (String(text ?? '').match(/\S+/g) ?? []).length;
}

// ============================================================================
// 3. Multi-Field Relevance Scoring
// ============================================================================

export interface ScoreOptions extends MatchOptions {
  /** If true, every query token must match in at least one field. Defaults to true. */
  matchAll?: boolean;
  locale?: string;
}

/**
 * Computes a relevance score across multiple document fields.
 * Weights: Exact = 10 * weight, Prefix = 6 * weight, Typo = 3 * weight.
 */
export function scoreRow(
  fieldValues: unknown[],
  weights: number[],
  query: unknown,
  options?: ScoreOptions
): number {
  const tokens = tokenize(query, options?.locale);
  if (tokens.length === 0) return 0;

  const matchAll = options?.matchAll !== false;
  const fieldTokenLists = fieldValues.map((v) => tokenize(v, options?.locale));

  let totalScore = 0;
  for (const token of tokens) {
    let bestScoreForToken = 0;

    for (let i = 0; i < fieldValues.length; i++) {
      const weight = weights[i] ?? 1;
      const kind = bestMatch(fieldTokenLists[i], token, options);
      let score = 0;
      if (kind === 3) score = 10 * weight;
      else if (kind === 2) score = 6 * weight;
      else if (kind === 1) score = 3 * weight;

      if (score > bestScoreForToken) {
        bestScoreForToken = score;
      }
    }

    if (bestScoreForToken === 0 && matchAll) {
      return 0;
    }

    totalScore += bestScoreForToken;
  }

  return totalScore;
}

// ============================================================================
// 4. Low-Level UDF Registration & Expression Helpers (Option 1)
// ============================================================================

/**
 * Registers WebDB search UDFs:
 * - `fuzzy(field, query, [fuzzy=1], [prefix=1])` -> 1 or 0
 * - `fuzzy_score(field, query, [weight=1], [fuzzy=1], [prefix=1])` -> number
 * - `search_score(query, configJson, ...fields)` -> number
 * - `relevance(title, body, tags, query, fuzzy)` -> number (demo compatibility)
 * - `highlight(text, query, [fuzzy=1], [prefix=1], [tag='mark'], [class=''])` -> string
 * - `snippet(text, query, [fuzzy=1], [prefix=1], [size=140], [tag='mark'], [class=''], [ellipsis='…'])` -> string
 * - `word_count(text)` -> number
 * - `normalize_text(text)` -> string
 */
export function registerFuzzySearch(db: WebDB): void {
  // 1. Single column boolean match
  db.registerFunction('fuzzy', {
    call: (fieldVal: unknown, query: unknown, fuzzy?: unknown, prefix?: unknown) => {
      const q = String(query ?? '').trim();
      if (!q) return 0;
      const f = fuzzy === undefined ? true : Number(fuzzy) === 1;
      const p = prefix === undefined ? true : Number(prefix) === 1;
      const score = scoreRow([fieldVal], [1], q, { fuzzy: f, prefix: p, matchAll: true });
      return score > 0 ? 1 : 0;
    },
    batchCall: (argsBatch: any[][]) => {
      return argsBatch.map(([fieldVal, query, fuzzy, prefix]) => {
        const q = String(query ?? '').trim();
        if (!q) return 0;
        const f = fuzzy === undefined ? true : Number(fuzzy) === 1;
        const p = prefix === undefined ? true : Number(prefix) === 1;
        const score = scoreRow([fieldVal], [1], q, { fuzzy: f, prefix: p, matchAll: true });
        return score > 0 ? 1 : 0;
      });
    },
    returnType: DataType.INT32,
  });

  // 2. Single column score
  db.registerFunction('fuzzy_score', {
    call: (fieldVal: unknown, query: unknown, weight?: unknown, fuzzy?: unknown, prefix?: unknown) => {
      const q = String(query ?? '').trim();
      if (!q) return 0;
      const w = Number(weight) || 1;
      const f = fuzzy === undefined ? true : Number(fuzzy) === 1;
      const p = prefix === undefined ? true : Number(prefix) === 1;
      return scoreRow([fieldVal], [w], q, { fuzzy: f, prefix: p, matchAll: false });
    },
    batchCall: (argsBatch: any[][]) => {
      return argsBatch.map(([fieldVal, query, weight, fuzzy, prefix]) => {
        const q = String(query ?? '').trim();
        if (!q) return 0;
        const w = Number(weight) || 1;
        const f = fuzzy === undefined ? true : Number(fuzzy) === 1;
        const p = prefix === undefined ? true : Number(prefix) === 1;
        return scoreRow([fieldVal], [w], q, { fuzzy: f, prefix: p, matchAll: false });
      });
    },
    returnType: DataType.FLOAT64,
  });

  // 3. Multi-column search score
  db.registerFunction('search_score', {
    call: (query: unknown, configJson: unknown, ...fieldValues: unknown[]) => {
      const q = String(query ?? '').trim();
      if (!q) return 0;
      let config: any = {};
      try {
        config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson ?? {};
      } catch {
        config = {};
      }
      const weights = Array.isArray(config.weights) ? config.weights : [];
      const fuzzy = config.fuzzy === undefined ? true : Number(config.fuzzy) === 1;
      const prefix = config.prefix === undefined ? true : Number(config.prefix) === 1;
      const matchAll = config.matchAll === undefined ? true : Number(config.matchAll) === 1;

      return scoreRow(fieldValues, weights, q, { fuzzy, prefix, matchAll });
    },
    batchCall: (argsBatch: any[][]) => {
      return argsBatch.map(([query, configJson, ...fieldValues]) => {
        const q = String(query ?? '').trim();
        if (!q) return 0;
        let config: any = {};
        try {
          config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson ?? {};
        } catch {
          config = {};
        }
        const weights = Array.isArray(config.weights) ? config.weights : [];
        const fuzzy = config.fuzzy === undefined ? true : Number(config.fuzzy) === 1;
        const prefix = config.prefix === undefined ? true : Number(config.prefix) === 1;
        const matchAll = config.matchAll === undefined ? true : Number(config.matchAll) === 1;

        return scoreRow(fieldValues, weights, q, { fuzzy, prefix, matchAll });
      });
    },
    returnType: DataType.FLOAT64,
  });

  // 4. Highlight
  db.registerFunction('highlight', {
    call: (
      text: unknown,
      query: unknown,
      fuzzy?: unknown,
      prefix?: unknown,
      tag?: unknown,
      className?: unknown
    ) => {
      const f = fuzzy === undefined ? true : Number(fuzzy) === 1;
      const p = prefix === undefined ? true : Number(prefix) === 1;
      const t = tag ? String(tag) : undefined;
      const c = className ? String(className) : undefined;
      return highlight(text, query, { fuzzy: f, prefix: p, tag: t, className: c });
    },
    returnType: DataType.TEXT,
  });

  // 5. Snippet
  db.registerFunction('snippet', {
    call: (
      text: unknown,
      query: unknown,
      fuzzy?: unknown,
      prefix?: unknown,
      size?: unknown,
      tag?: unknown,
      className?: unknown,
      ellipsis?: unknown
    ) => {
      const f = fuzzy === undefined ? true : Number(fuzzy) === 1;
      const p = prefix === undefined ? true : Number(prefix) === 1;
      const s = Number(size) || 140;
      const t = tag ? String(tag) : undefined;
      const c = className ? String(className) : undefined;
      const el = ellipsis ? String(ellipsis) : undefined;
      return snippet(text, query, {
        fuzzy: f,
        prefix: p,
        size: s,
        tag: t,
        className: c,
        ellipsis: el,
      });
    },
    returnType: DataType.TEXT,
  });

  // 6. Word count
  db.registerFunction('word_count', {
    call: (text: unknown) => wordCount(text),
    returnType: DataType.INT32,
  });

  // 7. Normalize text
  db.registerFunction('normalize_text', {
    call: (text: unknown) => normalizeText(text),
    returnType: DataType.TEXT,
  });

  // 8. Demo-compatible relevance(title, body, tags, query, fuzzy)
  db.registerFunction('relevance', {
    call: (
      title: unknown,
      body: unknown,
      tags: unknown,
      query: unknown,
      fuzzy: unknown
    ) => {
      const q = String(query ?? '').trim();
      if (!q) return 0;
      const f = Number(fuzzy) === 1;
      return scoreRow([title, tags, body], [10, 5, 1], q, {
        fuzzy: f,
        prefix: true,
        matchAll: true,
      });
    },
    returnType: DataType.FLOAT64,
  });

  // 9. N-gram similarity (0.0 to 1.0)
  db.registerFunction('ngram_similarity', {
    call: (valA: unknown, valB: unknown, n?: unknown) => {
      const numN = Number(n) || 3;
      return ngramSimilarity(String(valA ?? ''), String(valB ?? ''), numN);
    },
    batchCall: (argsBatch: any[][]) => {
      return argsBatch.map(([valA, valB, n]) => {
        const numN = Number(n) || 3;
        return ngramSimilarity(String(valA ?? ''), String(valB ?? ''), numN);
      });
    },
    returnType: DataType.FLOAT64,
  });

  // 10. Multi-field BM25 relevance score
  db.registerFunction('bm25_score', {
    call: (query: unknown, configJson: unknown, ...fieldValues: unknown[]) => {
      return computeBM25ScoreRow(query, configJson, fieldValues);
    },
    batchCall: (argsBatch: any[][]) => {
      return argsBatch.map(([query, configJson, ...fieldValues]) => {
        return computeBM25ScoreRow(query, configJson, fieldValues);
      });
    },
    returnType: DataType.FLOAT64,
  });
}

/** Wraps a literal value in an ExpressionBuilder node. */
export function lit(value: unknown): ExpressionBuilder {
  return new ExpressionBuilder({ type: 'literal', value } as any);
}

/** Creates an expression for checking if a field fuzzy-matches a query in WHERE. */
export function fuzzyMatch(
  field: string,
  query: string,
  options?: { fuzzy?: boolean; prefix?: boolean }
): ExpressionBuilder {
  const f = options?.fuzzy !== false ? 1 : 0;
  const p = options?.prefix !== false ? 1 : 0;
  return fn('fuzzy', col(field), lit(query), lit(f), lit(p)).eq(1);
}

/** Creates an expression calculating the relevance score for a single column. */
export function fuzzyScore(
  field: string,
  query: string,
  options?: { weight?: number; fuzzy?: boolean; prefix?: boolean }
): ExpressionBuilder {
  const w = options?.weight ?? 1;
  const f = options?.fuzzy !== false ? 1 : 0;
  const p = options?.prefix !== false ? 1 : 0;
  return fn('fuzzy_score', col(field), lit(query), lit(w), lit(f), lit(p));
}

export interface MultiScoreField {
  name: string;
  weight?: number;
}

/** Creates an expression calculating multi-field weighted search relevance. */
export function multiFuzzyScore(
  fields: (string | MultiScoreField)[],
  query: string,
  options?: { fuzzy?: boolean; prefix?: boolean; matchAll?: boolean }
): ExpressionBuilder {
  const normFields = fields.map((f) =>
    typeof f === 'string' ? { name: f, weight: 1 } : { name: f.name, weight: f.weight ?? 1 }
  );
  const config = JSON.stringify({
    weights: normFields.map((f) => f.weight),
    fuzzy: options?.fuzzy !== false ? 1 : 0,
    prefix: options?.prefix !== false ? 1 : 0,
    matchAll: options?.matchAll !== false ? 1 : 0,
  });
  const cols = normFields.map((f) => col(f.name));
  return fn('search_score', lit(query), lit(config), ...cols);
}

/** Creates an expression projecting highlighted text for a field. */
export function highlightExpr(
  field: string,
  query: string,
  options?: { fuzzy?: boolean; prefix?: boolean; tag?: string; className?: string }
): ExpressionBuilder {
  const f = options?.fuzzy !== false ? 1 : 0;
  const p = options?.prefix !== false ? 1 : 0;
  const tag = options?.tag ?? 'mark';
  const className = options?.className ?? '';
  return fn('highlight', col(field), lit(query), lit(f), lit(p), lit(tag), lit(className));
}

/** Creates an expression projecting a contextual snippet for a field. */
export function snippetExpr(
  field: string,
  query: string,
  options?: {
    fuzzy?: boolean;
    prefix?: boolean;
    size?: number;
    tag?: string;
    className?: string;
    ellipsis?: string;
  }
): ExpressionBuilder {
  const f = options?.fuzzy !== false ? 1 : 0;
  const p = options?.prefix !== false ? 1 : 0;
  const size = options?.size ?? 140;
  const tag = options?.tag ?? 'mark';
  const className = options?.className ?? '';
  const ellipsis = options?.ellipsis ?? '…';
  return fn(
    'snippet',
    col(field),
    lit(query),
    lit(f),
    lit(p),
    lit(size),
    lit(tag),
    lit(className),
    lit(ellipsis)
  );
}

/** Creates an expression computing character n-gram Sorensen-Dice similarity (0.0 to 1.0). */
export function ngramSimilarityExpr(
  field: string,
  query: string,
  n: number = 3
): ExpressionBuilder {
  return fn('ngram_similarity', col(field), lit(query), lit(n));
}

/** Creates an expression computing multi-field BM25 relevance score. */
export function bm25Score(
  fields: (string | MultiScoreField)[],
  query: string,
  config?: BM25ConfigPayload
): ExpressionBuilder {
  const normFields = fields.map((f) =>
    typeof f === 'string' ? { name: f, weight: 1 } : { name: f.name, weight: f.weight ?? 1 }
  );
  const cfgPayload: BM25ConfigPayload = {
    weights: normFields.map((f) => f.weight),
    k1: config?.k1 ?? 1.2,
    b: config?.b ?? 0.75,
    avgdl: config?.avgdl,
    totalDocs: config?.totalDocs,
    docFreqs: config?.docFreqs,
    fuzzy: config?.fuzzy,
  };
  const cols = normFields.map((f) => col(f.name));
  return fn('bm25_score', lit(query), lit(JSON.stringify(cfgPayload)), ...cols);
}

export interface BM25ConfigPayload {
  k1?: number;
  b?: number;
  avgdl?: number;
  totalDocs?: number;
  weights?: number[];
  docFreqs?: Record<string, number>;
  fuzzy?: boolean;
}

/**
 * Computes BM25 score for a single row given pre-computed or estimated corpus parameters.
 */
export function computeBM25ScoreRow(
  query: unknown,
  configJson: unknown,
  fieldValues: unknown[]
): number {
  const q = String(query ?? '').trim();
  if (!q) return 0;

  let config: BM25ConfigPayload = {};
  try {
    config = typeof configJson === 'string' ? JSON.parse(configJson) : (configJson as any) ?? {};
  } catch {
    config = {};
  }

  const k1 = config.k1 ?? 1.2;
  const b = config.b ?? 0.75;
  const avgdl = config.avgdl && config.avgdl > 0 ? config.avgdl : 10;
  const totalDocs = config.totalDocs && config.totalDocs > 0 ? config.totalDocs : 100;
  const weights = Array.isArray(config.weights) ? config.weights : [];
  const docFreqs = config.docFreqs ?? {};
  const fuzzy = Boolean(config.fuzzy);

  const queryTokens = tokenize(q);
  if (queryTokens.length === 0) return 0;

  let docLen = 0;
  const fieldTokens: string[][] = [];
  for (let i = 0; i < fieldValues.length; i++) {
    const w = weights[i] ?? 1;
    const tokens = tokenize(fieldValues[i]);
    fieldTokens.push(tokens);
    docLen += tokens.length * w;
  }

  let totalScore = 0;
  for (const qt of queryTokens) {
    let tf = 0;
    for (let i = 0; i < fieldValues.length; i++) {
      const w = weights[i] ?? 1;
      const tokens = fieldTokens[i];
      for (const t of tokens) {
        if (t === qt) {
          tf += w;
        } else if (fuzzy) {
          if (t.startsWith(qt)) {
            tf += w * 0.7;
          } else if (withinEdits(t, qt, qt.length <= 4 ? 1 : 2)) {
            tf += w * 0.5;
          }
        }
      }
    }

    if (tf > 0) {
      const df = docFreqs[qt] ?? 1;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      const num = tf * (k1 + 1);
      const denom = tf + k1 * (1 - b + b * (docLen / avgdl));
      totalScore += idf * (num / denom);
    }
  }

  return totalScore;
}

// ============================================================================
// 5. BM25 (Best Matching 25) Probabilistic Index & Scoring
// ============================================================================

export interface BM25IndexConfig<T = Record<string, unknown>> {
  fields: (string | SearchFieldConfig)[];
  idField?: string;
  k1?: number; // default: 1.2
  b?: number;  // default: 0.75
  locale?: string;
  fuzzy?: boolean;
}

/**
 * Standard BM25 corpus index computing Robertson-Spärck Jones IDF
 * and document length normalization for information retrieval.
 */
export class BM25Index<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly fields: SearchFieldConfig[];
  readonly idField: string;
  readonly k1: number;
  readonly b: number;
  readonly locale: string;
  readonly fuzzy: boolean;

  private docs: { id: any; row: T; fieldTokens: string[][]; length: number }[] = [];
  private docFreqs = new Map<string, number>();
  private avgdl: number = 0;
  private totalLength: number = 0;

  constructor(config: BM25IndexConfig<T>) {
    this.idField = config.idField ?? 'id';
    this.k1 = config.k1 ?? 1.2;
    this.b = config.b ?? 0.75;
    this.locale = config.locale ?? 'en';
    this.fuzzy = config.fuzzy ?? false;
    this.fields = (config.fields ?? []).map((f) =>
      typeof f === 'string'
        ? { name: f, weight: 1, highlight: false, snippet: false }
        : {
            name: f.name,
            weight: f.weight ?? 1,
            highlight: f.highlight ?? false,
            snippet: f.snippet ?? false,
          }
    );
  }

  get totalDocuments(): number {
    return this.docs.length;
  }

  get averageDocumentLength(): number {
    return this.avgdl;
  }

  addDocuments(items: T[]): this {
    for (const item of items) {
      this.addDocument(item);
    }
    return this;
  }

  addDocument(row: T): this {
    const id = (row as any)[this.idField];
    const fieldTokens: string[][] = [];
    let docLen = 0;
    const seenTerms = new Set<string>();

    for (let f = 0; f < this.fields.length; f++) {
      const fieldConfig = this.fields[f];
      const val = (row as any)[fieldConfig.name];
      const tokens = tokenize(val, this.locale);
      fieldTokens.push(tokens);
      const w = fieldConfig.weight ?? 1;
      docLen += tokens.length * w;

      for (const t of tokens) {
        seenTerms.add(t);
      }
    }

    for (const term of seenTerms) {
      this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
    }

    this.docs.push({ id, row, fieldTokens, length: docLen });
    this.totalLength += docLen;
    this.avgdl = this.docs.length > 0 ? this.totalLength / this.docs.length : 0;
    return this;
  }

  idf(term: string): number {
    const N = this.docs.length;
    const n = this.docFreqs.get(term) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  score(docIdx: number, queryTerms: string[]): number {
    const d = this.docs[docIdx];
    if (!d || queryTerms.length === 0) return 0;

    const avgdl = this.avgdl || 1;
    let totalScore = 0;

    for (const qt of queryTerms) {
      let tf = 0;
      for (let f = 0; f < this.fields.length; f++) {
        const w = this.fields[f].weight ?? 1;
        const tokens = d.fieldTokens[f];
        for (const t of tokens) {
          if (t === qt) {
            tf += w;
          } else if (this.fuzzy) {
            if (t.startsWith(qt)) {
              tf += w * 0.7;
            } else if (withinEdits(t, qt, qt.length <= 4 ? 1 : 2)) {
              tf += w * 0.5;
            }
          }
        }
      }

      if (tf > 0) {
        const idfVal = this.idf(qt);
        const num = tf * (this.k1 + 1);
        const denom = tf + this.k1 * (1 - this.b + this.b * (d.length / avgdl));
        totalScore += idfVal * (num / denom);
      }
    }

    return totalScore;
  }

  search(queryString: string, options?: { limit?: number; threshold?: number }): SearchResult<T> {
    const start = performance.now();
    const q = queryString.trim();
    if (!q) {
      return {
        hits: [],
        total: 0,
        query: queryString,
        durationMs: performance.now() - start,
      };
    }

    const queryTokens = tokenize(q, this.locale);
    const threshold = options?.threshold ?? 0;
    const avgdl = this.avgdl || 1;
    const hits: SearchHit<T>[] = [];

    for (let i = 0; i < this.docs.length; i++) {
      const d = this.docs[i];
      let totalScore = 0;

      for (const qt of queryTokens) {
        let tf = 0;
        for (let f = 0; f < this.fields.length; f++) {
          const w = this.fields[f].weight ?? 1;
          const tokens = d.fieldTokens[f];
          for (const t of tokens) {
            if (t === qt) {
              tf += w;
            } else if (this.fuzzy) {
              if (t.startsWith(qt)) {
                tf += w * 0.7;
              } else if (withinEdits(t, qt, qt.length <= 4 ? 1 : 2)) {
                tf += w * 0.5;
              }
            }
          }
        }

        if (tf > 0) {
          const idfVal = this.idf(qt);
          const num = tf * (this.k1 + 1);
          const denom = tf + this.k1 * (1 - this.b + this.b * (d.length / avgdl));
          totalScore += idfVal * (num / denom);
        }
      }

      if (totalScore > threshold) {
        const highlights: Record<string, string> = {};
        const snippets: Record<string, string> = {};
        for (const f of this.fields) {
          const val = (d.row as any)[f.name];
          if (f.highlight) {
            highlights[f.name] = highlight(val, q, { fuzzy: this.fuzzy, prefix: true });
          }
          if (f.snippet) {
            const size = typeof f.snippet === 'object' ? f.snippet.size : 140;
            snippets[f.name] = snippet(val, q, { fuzzy: this.fuzzy, prefix: true, size });
          }
        }
        hits.push({
          id: d.id,
          score: totalScore,
          row: d.row,
          highlights,
          snippets,
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const limited = options?.limit !== undefined ? hits.slice(0, options.limit) : hits;

    return {
      hits: limited,
      total: hits.length,
      query: queryString,
      durationMs: performance.now() - start,
    };
  }
}

// ============================================================================
// 6. High-Level SearchIndex Abstraction (Option 3)
// ============================================================================

export interface SearchFieldConfig {
  name: string;
  weight?: number;
  highlight?: boolean;
  snippet?: boolean | { size?: number };
}

export interface SearchIndexConfig<T = Record<string, unknown>> {
  db: WebDB;
  table: string;
  fields: (string | SearchFieldConfig)[];
  idField?: string;
  algorithm?: 'fuzzy' | 'bm25';
  bm25?: {
    k1?: number;
    b?: number;
  };
  fuzzy?: boolean;
  prefix?: boolean;
  matchAll?: boolean;
  threshold?: number;
  highlightTag?: string;
  highlightClass?: string;
  snippetLength?: number;
  snippetEllipsis?: string;
  locale?: string;
}

export interface SearchQueryOptions {
  limit?: number;
  offset?: number;
  threshold?: number;
  algorithm?: 'fuzzy' | 'bm25';
  fuzzy?: boolean;
  prefix?: boolean;
  matchAll?: boolean;
  columns?: string[];
  filter?: (qb: QueryBuilder) => QueryBuilder;
  emptyBehavior?: 'empty' | 'all';
}

export interface SearchHit<T = Record<string, unknown>> {
  id: any;
  score: number;
  row: T;
  highlights: Record<string, string>;
  snippets: Record<string, string>;
}

export interface SearchResult<T = Record<string, unknown>> {
  hits: SearchHit<T>[];
  total: number;
  query: string;
  durationMs: number;
}

/**
 * High-level search abstraction managing multi-column ranking, typo tolerance,
 * prefix matching, and automatic highlighting/snippets.
 */
export class SearchIndex<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly db: WebDB;
  readonly table: string;
  readonly idField: string;
  readonly fields: SearchFieldConfig[];
  private tableColumns: string[] | null = null;
  private readonly config: SearchIndexConfig<T>;

  constructor(
    dbOrConfig: WebDB | SearchIndexConfig<T>,
    maybeConfig?: Omit<SearchIndexConfig<T>, 'db'>
  ) {
    const config: SearchIndexConfig<T> = maybeConfig
      ? { ...maybeConfig, db: dbOrConfig as WebDB }
      : (dbOrConfig as SearchIndexConfig<T>);

    this.config = config;
    this.db = config.db;
    this.table = config.table;
    this.idField = config.idField ?? 'id';
    this.fields = (config.fields ?? []).map((f) =>
      typeof f === 'string'
        ? { name: f, weight: 1, highlight: false, snippet: false }
        : {
            name: f.name,
            weight: f.weight ?? 1,
            highlight: f.highlight ?? false,
            snippet: f.snippet ?? false,
          }
    );

    registerFuzzySearch(this.db);
  }

  /**
   * Initializes table metadata to discover all underlying table columns for projection.
   */
  async init(): Promise<this> {
    if (!this.tableColumns) {
      try {
        const meta = await this.db.getTable(this.table);
        this.tableColumns = meta.columns.map((c) => c.name);
      } catch {
        this.tableColumns = [this.idField, ...this.fields.map((f) => f.name)];
      }
    }
    return this;
  }

  /**
   * Builds the WebDB QueryBuilder for a search query.
   * Useful for composing with `.live()`, custom `.where()`, `.limit()`, or inspecting `.toSQL()`.
   */
  buildQuery(queryString: string, options?: SearchQueryOptions): QueryBuilder {
    const q = queryString.trim();
    let qb = this.db.from(this.table);

    const emptyBehavior = options?.emptyBehavior ?? 'all';
    if (!q) {
      if (emptyBehavior === 'empty') {
        return qb.where(lit(1).eq(0));
      }
      if (options?.filter) {
        qb = options.filter(qb);
      }
      if (options?.limit !== undefined) {
        qb = qb.limit(options.limit);
      }
      if (options?.offset !== undefined) {
        qb = qb.offset(options.offset);
      }
      return qb.orderBy(this.idField, 'desc');
    }

    const fuzzy = options?.fuzzy ?? this.config.fuzzy ?? true;
    const prefix = options?.prefix ?? this.config.prefix ?? true;
    const matchAll = options?.matchAll ?? this.config.matchAll ?? true;
    const threshold = options?.threshold ?? this.config.threshold ?? 0;

    const scoreExpr = multiFuzzyScore(this.fields, q, { fuzzy, prefix, matchAll });

    const baseCols =
      options?.columns ?? this.tableColumns ?? [this.idField, ...this.fields.map((f) => f.name)];
    const selectItems: any[] = [...baseCols];
    if (!selectItems.includes(this.idField)) {
      selectItems.unshift(this.idField);
    }

    selectItems.push(scoreExpr.as('_search_score'));

    for (const f of this.fields) {
      if (f.highlight) {
        selectItems.push(
          highlightExpr(f.name, q, {
            fuzzy,
            prefix,
            tag: this.config.highlightTag,
            className: this.config.highlightClass,
          }).as(`_search_hl_${f.name}`)
        );
      }
      if (f.snippet) {
        const size = typeof f.snippet === 'object' ? f.snippet.size : this.config.snippetLength;
        selectItems.push(
          snippetExpr(f.name, q, {
            fuzzy,
            prefix,
            size,
            tag: this.config.highlightTag,
            className: this.config.highlightClass,
            ellipsis: this.config.snippetEllipsis,
          }).as(`_search_snip_${f.name}`)
        );
      }
    }

    qb = qb.select(selectItems);
    qb = qb.where(scoreExpr.gt(threshold));

    if (options?.filter) {
      qb = options.filter(qb);
    }

    qb = qb.orderBy('_search_score', 'desc');

    if (options?.limit !== undefined) {
      qb = qb.limit(options.limit);
    }
    if (options?.offset !== undefined) {
      qb = qb.offset(options.offset);
    }

    return qb;
  }

  /**
   * Builds an in-memory BM25 index from table rows (optionally pre-filtered).
   */
  async buildBM25Index(filter?: (qb: QueryBuilder) => QueryBuilder): Promise<BM25Index<T>> {
    let qb = this.db.from(this.table);
    if (filter) qb = filter(qb);
    const rows = (await qb.toArray()) as T[];
    const bm25 = new BM25Index<T>({
      fields: this.fields,
      idField: this.idField,
      k1: this.config.bm25?.k1,
      b: this.config.bm25?.b,
      locale: this.config.locale,
      fuzzy: this.config.fuzzy,
    });
    bm25.addDocuments(rows);
    return bm25;
  }

  /**
   * Executes a fuzzy or BM25 search query against the table, returning ranked results with highlights.
   */
  async search(
    queryString: string,
    options?: SearchQueryOptions
  ): Promise<SearchResult<T>> {
    const start = performance.now();
    await this.init();

    const q = queryString.trim();
    if (!q && (options?.emptyBehavior === 'empty')) {
      return {
        hits: [],
        total: 0,
        query: queryString,
        durationMs: performance.now() - start,
      };
    }

    const algo = options?.algorithm ?? this.config.algorithm ?? 'fuzzy';
    if (algo === 'bm25') {
      const bm25 = await this.buildBM25Index(options?.filter);
      return bm25.search(queryString, {
        limit: options?.limit,
        threshold: options?.threshold ?? this.config.threshold,
      });
    }

    const qb = this.buildQuery(queryString, options);
    const rows = (await qb.toArray()) as Record<string, any>[];

    const hits: SearchHit<T>[] = rows.map((r) => {
      const id = r[this.idField];
      const score = Number(r._search_score ?? 0);
      const highlights: Record<string, string> = {};
      const snippets: Record<string, string> = {};
      const cleanRow: Record<string, any> = {};

      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith('_search_hl_')) {
          highlights[k.slice('_search_hl_'.length)] = String(v ?? '');
        } else if (k.startsWith('_search_snip_')) {
          snippets[k.slice('_search_snip_'.length)] = String(v ?? '');
        } else if (k === '_search_score') {
          // Internal score field
        } else {
          cleanRow[k] = v;
        }
      }

      return {
        id,
        score,
        row: cleanRow as T,
        highlights,
        snippets,
      };
    });

    const durationMs = performance.now() - start;
    return {
      hits,
      total: hits.length,
      query: queryString,
      durationMs,
    };
  }
}

/**
 * Creates and returns a new SearchIndex instance.
 */
export function createSearchIndex<T extends Record<string, unknown> = Record<string, unknown>>(
  db: WebDB,
  config: Omit<SearchIndexConfig<T>, 'db'>
): SearchIndex<T> {
  return new SearchIndex<T>({ ...config, db });
}

// ============================================================================
// 6. In-Memory Search Utility
// ============================================================================

export interface InMemorySearchOptions<T> extends ScoreOptions {
  fields: (
    | keyof T
    | {
        name: keyof T;
        weight?: number;
        highlight?: boolean;
        snippet?: boolean | { size?: number };
      }
  )[];
  algorithm?: 'fuzzy' | 'bm25';
  bm25?: {
    k1?: number;
    b?: number;
  };
  limit?: number;
  offset?: number;
  threshold?: number;
  tag?: string;
  className?: string;
  snippetLength?: number;
  snippetEllipsis?: string;
  idField?: keyof T;
}

/**
 * Searches an in-memory array of JavaScript objects without touching the database.
 * Supports both multi-field fuzzy typo-tolerant ranking and probabilistic BM25 ranking.
 */
export function searchInMemory<T extends Record<string, any>>(
  items: T[],
  queryString: string,
  options: InMemorySearchOptions<T>
): SearchResult<T> {
  const start = performance.now();
  const q = queryString.trim();

  if (!q) {
    return {
      hits: items.slice(0, options.limit).map((item) => ({
        id: options.idField ? item[options.idField] : undefined,
        score: 0,
        row: item,
        highlights: {},
        snippets: {},
      })),
      total: items.length,
      query: queryString,
      durationMs: performance.now() - start,
    };
  }

  const normFields = options.fields.map((f) =>
    typeof f === 'object' && 'name' in f
      ? {
          name: f.name as string,
          weight: f.weight ?? 1,
          highlight: f.highlight ?? false,
          snippet: f.snippet ?? false,
        }
      : {
          name: String(f),
          weight: 1,
          highlight: false,
          snippet: false,
        }
  );

  if (options.algorithm === 'bm25') {
    const bm25 = new BM25Index<T>({
      fields: normFields,
      idField: (options.idField as string) ?? 'id',
      k1: options.bm25?.k1,
      b: options.bm25?.b,
      locale: options.locale,
      fuzzy: options.fuzzy,
    });
    bm25.addDocuments(items);
    return bm25.search(queryString, {
      limit: options.limit,
      threshold: options.threshold,
    });
  }

  const weights = normFields.map((f) => f.weight);
  const threshold = options.threshold ?? 0;
  const tag = options.tag ?? 'mark';
  const className = options.className;
  const size = options.snippetLength ?? 140;
  const ellipsis = options.snippetEllipsis ?? '…';

  const scored: SearchHit<T>[] = [];

  for (const item of items) {
    const fieldValues = normFields.map((f) => item[f.name]);
    const score = scoreRow(fieldValues, weights, q, options);

    if (score > threshold) {
      const highlights: Record<string, string> = {};
      const snippets: Record<string, string> = {};

      for (const f of normFields) {
        if (f.highlight) {
          highlights[f.name] = highlight(item[f.name], q, { ...options, tag, className });
        }
        if (f.snippet) {
          const s = typeof f.snippet === 'object' ? f.snippet.size ?? size : size;
          snippets[f.name] = snippet(item[f.name], q, {
            ...options,
            tag,
            className,
            size: s,
            ellipsis,
          });
        }
      }

      scored.push({
        id: options.idField ? item[options.idField] : undefined,
        score,
        row: item,
        highlights,
        snippets,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const offset = options.offset ?? 0;
  const limit = options.limit ?? scored.length;
  const paginated = scored.slice(offset, offset + limit);

  return {
    hits: paginated,
    total: scored.length,
    query: queryString,
    durationMs: performance.now() - start,
  };
}
