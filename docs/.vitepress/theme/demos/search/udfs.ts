/**
 * Search helpers exposed to WebDB as user-defined functions (UDFs).
 *
 * WebDB ships no full-text engine on purpose: the browser already has Unicode normalisation, `Intl`,
 * regular expressions... so you write the search logic in plain JavaScript and call it from queries
 * (`WHERE`, `SELECT`, `ORDER BY`) like any built-in function. Everything here is a pure function,
 * so it is also easy to unit-test.
 */
import type { WebDB } from '@ahmadmoussawi/webdb';

/** Lower-cases and strips diacritics: `Café` -> `cafe`. */
export function norm(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Normalised words of a text. */
export function words(value: unknown): string[] {
  return norm(value).match(/[a-z0-9]+/g) ?? [];
}

/** True when the Levenshtein distance between `a` and `b` is at most `max` (bounded, early exit). */
export function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** 0 = no match, 1 = typo (fuzzy), 2 = prefix, 3 = exact word. */
export type MatchKind = 0 | 1 | 2 | 3;

export function matchWord(word: string, token: string, fuzzy: boolean): MatchKind {
  if (word === token) return 3;
  if (token.length >= 2 && word.startsWith(token)) return 2;
  if (fuzzy && token.length >= 4 && withinEdits(word, token, token.length >= 8 ? 2 : 1)) return 1;
  return 0;
}

function best(wordList: string[], token: string, fuzzy: boolean): MatchKind {
  let result: MatchKind = 0;
  for (const w of wordList) {
    const m = matchWord(w, token, fuzzy);
    if (m > result) result = m;
    if (result === 3) break;
  }
  return result;
}

const TITLE_WEIGHT = [0, 3, 6, 10] as const;
const TAG_WEIGHT = [0, 2, 4, 6] as const;
const BODY_WEIGHT = [0, 1, 2, 3] as const;

/**
 * Relevance score of a row for a query. Every query word must match somewhere (title, tags or body),
 * otherwise the score is 0. Title matches count most, then tags, then body. Exact words beat prefixes,
 * which beat typo matches (only when `fuzzy` is on).
 */
export function relevance(title: unknown, body: unknown, tags: unknown, query: unknown, fuzzy: unknown): number {
  const tokens = words(query);
  if (tokens.length === 0) return 0;
  const useFuzzy = Number(fuzzy) === 1;
  const t = words(title);
  const g = words(tags);
  const b = words(body);
  let total = 0;
  for (const token of tokens) {
    const mt = best(t, token, useFuzzy);
    const mg = best(g, token, useFuzzy);
    const mb = best(b, token, useFuzzy);
    if (!mt && !mg && !mb) return 0;
    total += TITLE_WEIGHT[mt] + TAG_WEIGHT[mg] + BODY_WEIGHT[mb];
  }
  return total;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

function matcher(query: unknown, fuzzy: unknown) {
  const tokens = words(query);
  const useFuzzy = Number(fuzzy) === 1;
  return (word: string) => {
    const w = norm(word);
    return tokens.some((tok) => matchWord(w, tok, useFuzzy) > 0);
  };
}

/** HTML-escaped `text` with every word that matches the query wrapped in `<mark>`. Safe for `v-html`. */
export function highlight(text: unknown, query: unknown, fuzzy: unknown): string {
  const source = String(text ?? '');
  const isMatch = matcher(query, fuzzy);
  let out = '';
  let last = 0;
  for (const m of source.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    out += escapeHtml(source.slice(last, start));
    out += isMatch(m[0]) ? `<mark>${escapeHtml(m[0])}</mark>` : escapeHtml(m[0]);
    last = start + m[0].length;
  }
  return out + escapeHtml(source.slice(last));
}

/** A short excerpt of `body` around the first match (highlighted HTML). */
export function snippet(body: unknown, query: unknown, fuzzy: unknown, size = 140): string {
  const source = String(body ?? '');
  const isMatch = matcher(query, fuzzy);
  let first = -1;
  for (const m of source.matchAll(WORD_RE)) {
    if (isMatch(m[0])) {
      first = m.index ?? 0;
      break;
    }
  }
  if (first === -1) {
    return highlight(source.length > size ? `${source.slice(0, size).trimEnd()}…` : source, '', 0);
  }
  let start = Math.max(0, first - Math.floor(size / 3));
  let end = Math.min(source.length, start + size);
  if (start > 0) start = source.indexOf(' ', start) === -1 ? start : source.indexOf(' ', start) + 1;
  if (end < source.length) {
    const cut = source.lastIndexOf(' ', end);
    if (cut > first) end = cut;
  }
  const excerpt = source.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${highlight(excerpt, query, fuzzy)}${end < source.length ? '…' : ''}`;
}

export function wordCount(text: unknown): number {
  return (String(text ?? '').match(/\S+/g) ?? []).length;
}

/** Registers every search UDF on a database. Call once after `WebDB.open()`. */
export function registerSearchUdfs(db: WebDB): void {
  db.registerFunction('relevance', relevance);
  db.registerFunction('highlight', highlight);
  db.registerFunction('snippet', snippet);
  db.registerFunction('word_count', wordCount);
}
