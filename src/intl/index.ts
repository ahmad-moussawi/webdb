/**
 * @file Browser-native Internationalization (Intl) and standard formatting extension for WebDB.
 * Zero external dependencies: leverages modern browser Intl.DateTimeFormat, Intl.NumberFormat,
 * Intl.RelativeTimeFormat, Intl.PluralRules, RegExp, and Date primitives.
 */

import {
  DataType,
  ExpressionBuilder,
  col,
  fn,
  type WebDB,
} from '@ahmadmoussawi/webdb';

// ============================================================================
// 1. LRU Cache Helpers for Native Intl and RegExp Formatters
// ============================================================================

const MAX_CACHE_SIZE = 256;

function createLruCache<T>() {
  const map = new Map<string, T>();
  return {
    get(key: string): T | undefined {
      const val = map.get(key);
      if (val !== undefined) {
        // Move to end (most recently used)
        map.delete(key);
        map.set(key, val);
      }
      return val;
    },
    set(key: string, value: T): void {
      if (map.has(key)) {
        map.delete(key);
      } else if (map.size >= MAX_CACHE_SIZE) {
        // Evict least recently used (first entry in Map iterator)
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) {
          map.delete(firstKey);
        }
      }
      map.set(key, value);
    },
  };
}

const dtfCache = createLruCache<Intl.DateTimeFormat>();
const nfCache = createLruCache<Intl.NumberFormat>();
const rtfCache = createLruCache<Intl.RelativeTimeFormat>();
const reCache = createLruCache<RegExp>();

function getDateTimeFormatter(
  locale?: string,
  options?: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${locale ?? 'default'}:${JSON.stringify(options ?? {})}`;
  let fmt = dtfCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat(locale || undefined, options);
    } catch {
      // Fallback if locale or timezone is unrecognized
      fmt = new Intl.DateTimeFormat(undefined, {
        dateStyle: options?.dateStyle,
        timeStyle: options?.timeStyle,
      });
    }
    dtfCache.set(key, fmt);
  }
  return fmt;
}

function getNumberFormatter(
  locale?: string,
  options?: Intl.NumberFormatOptions
): Intl.NumberFormat {
  const key = `${locale ?? 'default'}:${JSON.stringify(options ?? {})}`;
  let fmt = nfCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(locale || undefined, options);
    } catch {
      fmt = new Intl.NumberFormat(undefined, options);
    }
    nfCache.set(key, fmt);
  }
  return fmt;
}

function getRelativeTimeFormatter(
  locale?: string,
  options?: Intl.RelativeTimeFormatOptions
): Intl.RelativeTimeFormat {
  const key = `${locale ?? 'default'}:${JSON.stringify(options ?? {})}`;
  let fmt = rtfCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.RelativeTimeFormat(locale || undefined, options);
    } catch {
      fmt = new Intl.RelativeTimeFormat(undefined, options);
    }
    rtfCache.set(key, fmt);
  }
  return fmt;
}

function getRegExp(pattern: string, flags?: string): RegExp {
  const key = `${pattern}:${flags ?? ''}`;
  let re = reCache.get(key);
  if (!re) {
    re = new RegExp(pattern, flags);
    reCache.set(key, re);
  }
  return re;
}

// ============================================================================
// 2. Date & Time Formatting Functions
// ============================================================================

/**
 * Normalizes an input value into an epoch millisecond timestamp.
 * Accepts numbers, bigints, Date instances, and ISO/date strings.
 */
export function normalizeTimestamp(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'bigint') {
    return Number(val);
  }
  if (val instanceof Date) {
    const time = val.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    // Check if numeric string
    const asNum = Number(trimmed);
    if (!Number.isNaN(asNum) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      return asNum;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export type DateStyle = 'full' | 'long' | 'medium' | 'short';

/**
 * Formats a timestamp into a localized date string using Intl.DateTimeFormat.
 * @param ts Epoch milliseconds, Date, or ISO string.
 * @param style 'short' | 'medium' | 'long' | 'full' (default: 'medium').
 * @param locale BCP 47 language tag (e.g. 'en-US', 'de-DE').
 * @param timeZone IANA time zone identifier (e.g. 'UTC', 'America/New_York').
 */
export function formatDate(
  ts: unknown,
  style: string = 'medium',
  locale?: string,
  timeZone?: string
): string | null {
  const ms = normalizeTimestamp(ts);
  if (ms === null) return null;
  const dateStyle = (['full', 'long', 'medium', 'short'].includes(style)
    ? style
    : 'medium') as DateStyle;
  const fmt = getDateTimeFormatter(locale, {
    dateStyle,
    timeZone: timeZone || undefined,
  });
  return fmt.format(new Date(ms));
}

/**
 * Formats the time portion of a timestamp into a localized time string.
 */
export function formatTime(
  ts: unknown,
  style: string = 'short',
  locale?: string,
  timeZone?: string
): string | null {
  const ms = normalizeTimestamp(ts);
  if (ms === null) return null;
  const timeStyle = (['full', 'long', 'medium', 'short'].includes(style)
    ? style
    : 'short') as DateStyle;
  const fmt = getDateTimeFormatter(locale, {
    timeStyle,
    timeZone: timeZone || undefined,
  });
  return fmt.format(new Date(ms));
}

/**
 * Returns a human-friendly relative time string (e.g. "3 days ago", "in 2 hours", "yesterday")
 * using Intl.RelativeTimeFormat.
 * @param ts Target timestamp.
 * @param baseTs Reference timestamp (default: Date.now()).
 * @param locale BCP 47 language tag.
 */
export function timeAgo(
  ts: unknown,
  baseTs?: unknown,
  locale?: string
): string | null {
  const targetMs = normalizeTimestamp(ts);
  if (targetMs === null) return null;
  const referenceMs = baseTs !== undefined ? normalizeTimestamp(baseTs) : Date.now();
  if (referenceMs === null) return null;

  const diffSec = Math.round((targetMs - referenceMs) / 1000);
  const absSec = Math.abs(diffSec);

  const rtf = getRelativeTimeFormatter(locale, { numeric: 'auto' });

  if (absSec < 60) {
    return rtf.format(diffSec, 'second');
  }
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) {
    return rtf.format(diffMin, 'minute');
  }
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) {
    return rtf.format(diffHour, 'hour');
  }
  const diffDay = Math.round(diffHour / 24);
  if (Math.abs(diffDay) < 30) {
    return rtf.format(diffDay, 'day');
  }
  const diffMonth = Math.round(diffDay / 30.4375);
  if (Math.abs(diffMonth) < 12) {
    return rtf.format(diffMonth, 'month');
  }
  const diffYear = Math.round(diffDay / 365.25);
  return rtf.format(diffYear, 'year');
}

/**
 * Extracts a specific date or time component from a timestamp.
 * Supported parts: 'year', 'month' (1-12), 'day', 'hour', 'minute', 'second', 'weekday' (0=Sun..6=Sat), 'quarter' (1-4).
 */
export function datePart(part: string, ts: unknown): number | null {
  const ms = normalizeTimestamp(ts);
  if (ms === null) return null;
  const d = new Date(ms);
  switch (part.toLowerCase().trim()) {
    case 'year':
    case 'yyyy':
      return d.getFullYear();
    case 'month':
    case 'mm':
      return d.getMonth() + 1;
    case 'day':
    case 'dd':
      return d.getDate();
    case 'hour':
    case 'hh':
      return d.getHours();
    case 'minute':
    case 'mi':
      return d.getMinutes();
    case 'second':
    case 'ss':
      return d.getSeconds();
    case 'millisecond':
    case 'ms':
      return d.getMilliseconds();
    case 'weekday':
    case 'dow':
      return d.getDay();
    case 'quarter':
    case 'q':
      return Math.floor(d.getMonth() / 3) + 1;
    default:
      return null;
  }
}

/**
 * Calculates the number of integer days elapsed from `ts` to `baseTs` (default: Date.now()).
 * Positive if `ts` is in the past, negative if in the future.
 */
export function daysSince(ts: unknown, baseTs?: unknown): number | null {
  const targetMs = normalizeTimestamp(ts);
  if (targetMs === null) return null;
  const referenceMs = baseTs !== undefined ? normalizeTimestamp(baseTs) : Date.now();
  if (referenceMs === null) return null;
  return Math.floor((referenceMs - targetMs) / 86_400_000);
}

/**
 * Adds or subtracts a time unit from a timestamp and returns the resulting epoch ms.
 * Units: 'second', 'minute', 'hour', 'day', 'week', 'month', 'year'.
 */
export function dateAdd(ts: unknown, amount: number, unit: string): number | null {
  const ms = normalizeTimestamp(ts);
  if (ms === null || !Number.isFinite(amount)) return null;
  const d = new Date(ms);
  const u = unit.toLowerCase().trim().replace(/s$/, '');
  switch (u) {
    case 'second':
      return d.getTime() + amount * 1000;
    case 'minute':
      return d.getTime() + amount * 60_000;
    case 'hour':
      return d.getTime() + amount * 3_600_000;
    case 'day':
      return d.getTime() + amount * 86_400_000;
    case 'week':
      return d.getTime() + amount * 604_800_000;
    case 'month': {
      d.setMonth(d.getMonth() + amount);
      return d.getTime();
    }
    case 'year': {
      d.setFullYear(d.getFullYear() + amount);
      return d.getTime();
    }
    default:
      return null;
  }
}

/**
 * Calculates the difference between two timestamps (`ts1 - ts2`) in the given unit.
 */
export function dateDiff(ts1: unknown, ts2: unknown, unit: string): number | null {
  const ms1 = normalizeTimestamp(ts1);
  const ms2 = normalizeTimestamp(ts2);
  if (ms1 === null || ms2 === null) return null;
  const diffMs = ms1 - ms2;
  const u = unit.toLowerCase().trim().replace(/s$/, '');
  switch (u) {
    case 'millisecond':
    case 'ms':
      return diffMs;
    case 'second':
      return Math.floor(diffMs / 1000);
    case 'minute':
      return Math.floor(diffMs / 60_000);
    case 'hour':
      return Math.floor(diffMs / 3_600_000);
    case 'day':
      return Math.floor(diffMs / 86_400_000);
    case 'week':
      return Math.floor(diffMs / 604_800_000);
    case 'month':
      return Math.floor(diffMs / (86_400_000 * 30.4375));
    case 'year':
      return Math.floor(diffMs / (86_400_000 * 365.25));
    default:
      return null;
  }
}

/**
 * Formats a timestamp into an ISO date string `YYYY-MM-DD`.
 */
export function isoDate(ts: unknown): string | null {
  const ms = normalizeTimestamp(ts);
  if (ms === null) return null;
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parses an ISO date/time string and returns epoch milliseconds.
 */
export function toTimestamp(isoString: unknown): number | null {
  return normalizeTimestamp(isoString);
}

// ============================================================================
// 3. Number, Currency & Unit Formatting Functions
// ============================================================================

/**
 * Formats a numerical amount into a localized currency string.
 * @param amount Number, bigint, or numeric string.
 * @param currency ISO 4217 currency code (default: 'USD', e.g. 'EUR', 'GBP', 'JPY').
 * @param locale BCP 47 language tag (e.g. 'en-US', 'de-DE').
 */
export function formatCurrency(
  amount: unknown,
  currency: string = 'USD',
  locale?: string
): string | null {
  if (amount === null || amount === undefined) return null;
  const num = Number(amount);
  if (!Number.isFinite(num)) return null;
  const fmt = getNumberFormatter(locale, {
    style: 'currency',
    currency: currency || 'USD',
  });
  return fmt.format(num);
}

/**
 * Formats a number with locale thousands grouping separators and fixed decimals.
 */
export function formatNumber(
  num: unknown,
  decimals?: number,
  locale?: string
): string | null {
  if (num === null || num === undefined) return null;
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  const options: Intl.NumberFormatOptions = {};
  if (decimals !== undefined && Number.isFinite(decimals)) {
    const d = Math.max(0, Math.min(20, Math.floor(decimals)));
    options.minimumFractionDigits = d;
    options.maximumFractionDigits = d;
  }
  const fmt = getNumberFormatter(locale, options);
  return fmt.format(n);
}

/**
 * Formats a number in compact notation (e.g. 1,500 -> "1.5K", 2,400,000 -> "2.4M").
 */
export function formatCompact(num: unknown, locale?: string): string | null {
  if (num === null || num === undefined) return null;
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  const fmt = getNumberFormatter(locale, {
    notation: 'compact',
    compactDisplay: 'short',
  });
  return fmt.format(n);
}

/**
 * Formats a ratio as a percentage string (e.g. 0.852 -> "85.2%").
 */
export function formatPercent(
  ratio: unknown,
  decimals: number = 1,
  locale?: string
): string | null {
  if (ratio === null || ratio === undefined) return null;
  const r = Number(ratio);
  if (!Number.isFinite(r)) return null;
  const d = Math.max(0, Math.min(20, Math.floor(decimals)));
  const fmt = getNumberFormatter(locale, {
    style: 'percent',
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
  return fmt.format(r);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/**
 * Formats a raw byte count into human-readable binary units (B, KB, MB, GB, TB).
 */
export function formatBytes(bytes: unknown, decimals: number = 1): string | null {
  if (bytes === null || bytes === undefined) return null;
  const b = Number(bytes);
  if (!Number.isFinite(b) || b < 0) return null;
  if (b === 0) return '0 B';

  const d = Math.max(0, Math.min(10, Math.floor(decimals)));
  const i = Math.floor(Math.log(b) / Math.log(1024));
  const unitIndex = Math.min(i, BYTE_UNITS.length - 1);
  const val = b / Math.pow(1024, unitIndex);
  return `${val.toFixed(d)} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * Returns a correct singular or plural form based on count.
 */
export function plural(
  count: unknown,
  singular: string,
  pluralText?: string,
  zeroText?: string
): string | null {
  if (count === null || count === undefined) return null;
  const c = Number(count);
  if (!Number.isFinite(c)) return null;
  if (c === 0 && zeroText !== undefined) {
    return zeroText;
  }
  const pluralForm = pluralText !== undefined ? pluralText : `${singular}s`;
  return c === 1 ? singular : pluralForm;
}

// ============================================================================
// 4. String, Regex & Text Processing Functions
// ============================================================================

/**
 * Tests whether a text matches a regular expression pattern. Returns 1 for match, 0 for no match.
 */
export function regexpMatch(text: unknown, pattern: unknown, flags?: string): number {
  if (text === null || text === undefined || pattern === null || pattern === undefined) {
    return 0;
  }
  try {
    const re = getRegExp(String(pattern), flags);
    return re.test(String(text)) ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * Replaces regular expression matches in text with a replacement string.
 */
export function regexpReplace(
  text: unknown,
  pattern: unknown,
  replacement: unknown,
  flags?: string
): string | null {
  if (text === null || text === undefined) return null;
  if (pattern === null || pattern === undefined) return String(text);
  const repl = replacement !== null && replacement !== undefined ? String(replacement) : '';
  try {
    const re = getRegExp(String(pattern), flags ?? 'g');
    return String(text).replace(re, repl);
  } catch {
    return String(text);
  }
}

/**
 * Converts a string into a URL-friendly slug (e.g. "Hello World! Café" -> "hello-world-cafe").
 */
export function slugify(text: unknown): string | null {
  if (text === null || text === undefined) return null;
  const str = String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return str.length > 0 ? str : null;
}

/**
 * Strips diacritics / accent marks from text (e.g. "Café München" -> "Cafe Munchen").
 */
export function unaccent(text: unknown): string | null {
  if (text === null || text === undefined) return null;
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Left-pads a string up to length with `padChar`.
 */
export function padLeft(
  str: unknown,
  length: number,
  padChar: string = ' '
): string | null {
  if (str === null || str === undefined) return null;
  return String(str).padStart(Math.max(0, Math.floor(length)), padChar);
}

/**
 * Right-pads a string up to length with `padChar`.
 */
export function padRight(
  str: unknown,
  length: number,
  padChar: string = ' '
): string | null {
  if (str === null || str === undefined) return null;
  return String(str).padEnd(Math.max(0, Math.floor(length)), padChar);
}

// ============================================================================
// 5. Registration Functions for WebDB
// ============================================================================

/**
 * Registers date and time formatting UDFs on a WebDB instance:
 * - `format_date(ts, [style='medium'], [locale], [tz]) -> TEXT`
 * - `format_time(ts, [style='short'], [locale], [tz]) -> TEXT`
 * - `time_ago(ts, [baseTs], [locale]) -> TEXT`
 * - `date_part(part, ts) -> INT32`
 * - `days_since(ts, [baseTs]) -> INT32`
 * - `date_add(ts, amount, unit) -> INT64/FLOAT64`
 * - `date_diff(ts1, ts2, unit) -> INT64/FLOAT64`
 * - `iso_date(ts) -> TEXT`
 * - `to_timestamp(isoStr) -> INT64/FLOAT64`
 */
export function registerDateFunctions(db: WebDB): WebDB {
  db.registerFunction('format_date', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (ts: any, style?: any, locale?: any, tz?: any) =>
      formatDate(ts, style, locale, tz),
    batchCall: (argsBatch) =>
      argsBatch.map(([ts, style, locale, tz]) =>
        formatDate(ts, style, locale, tz)
      ),
  });

  db.registerFunction('format_time', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (ts: any, style?: any, locale?: any, tz?: any) =>
      formatTime(ts, style, locale, tz),
    batchCall: (argsBatch) =>
      argsBatch.map(([ts, style, locale, tz]) =>
        formatTime(ts, style, locale, tz)
      ),
  });

  db.registerFunction('time_ago', {
    deterministic: false, // Relies on Date.now() when baseTs is not specified
    returnType: DataType.TEXT,
    call: (ts: any, baseTs?: any, locale?: any) => timeAgo(ts, baseTs, locale),
    batchCall: (argsBatch) =>
      argsBatch.map(([ts, baseTs, locale]) => timeAgo(ts, baseTs, locale)),
  });

  db.registerFunction('date_part', {
    deterministic: true,
    returnType: DataType.INT32,
    call: (part: any, ts: any) => datePart(String(part), ts),
    batchCall: (argsBatch) =>
      argsBatch.map(([part, ts]) => (part !== null ? datePart(String(part), ts) : null)),
  });

  db.registerFunction('days_since', {
    deterministic: false,
    returnType: DataType.INT32,
    call: (ts: any, baseTs?: any) => daysSince(ts, baseTs),
    batchCall: (argsBatch) =>
      argsBatch.map(([ts, baseTs]) => daysSince(ts, baseTs)),
  });

  db.registerFunction('date_add', {
    deterministic: true,
    returnType: DataType.FLOAT64,
    call: (ts: any, amount: any, unit: any) =>
      dateAdd(ts, Number(amount), String(unit)),
    batchCall: (argsBatch) =>
      argsBatch.map(([ts, amount, unit]) =>
        dateAdd(ts, Number(amount), String(unit ?? 'day'))
      ),
  });

  db.registerFunction('date_diff', {
    deterministic: true,
    returnType: DataType.FLOAT64,
    call: (ts1: any, ts2: any, unit: any) =>
      dateDiff(ts1, ts2, String(unit)),
    batchCall: (argsBatch) =>
      argsBatch.map(([ts1, ts2, unit]) =>
        dateDiff(ts1, ts2, String(unit ?? 'day'))
      ),
  });

  db.registerFunction('iso_date', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (ts: any) => isoDate(ts),
    batchCall: (argsBatch) => argsBatch.map(([ts]) => isoDate(ts)),
  });

  db.registerFunction('to_timestamp', {
    deterministic: true,
    returnType: DataType.FLOAT64,
    call: (iso: any) => toTimestamp(iso),
    batchCall: (argsBatch) => argsBatch.map(([iso]) => toTimestamp(iso)),
  });

  return db;
}

/**
 * Registers number, currency and unit formatting UDFs on a WebDB instance:
 * - `format_currency(amount, [currency='USD'], [locale]) -> TEXT`
 * - `format_number(num, [decimals], [locale]) -> TEXT`
 * - `format_compact(num, [locale]) -> TEXT`
 * - `format_percent(ratio, [decimals=1], [locale]) -> TEXT`
 * - `format_bytes(bytes, [decimals=1]) -> TEXT`
 * - `plural(count, singular, [pluralText], [zeroText]) -> TEXT`
 */
export function registerNumberFunctions(db: WebDB): WebDB {
  db.registerFunction('format_currency', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (amount: any, currency?: any, locale?: any) =>
      formatCurrency(amount, currency, locale),
    batchCall: (argsBatch) =>
      argsBatch.map(([amount, currency, locale]) =>
        formatCurrency(amount, currency, locale)
      ),
  });

  db.registerFunction('format_number', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (num: any, decimals?: any, locale?: any) =>
      formatNumber(num, decimals !== undefined ? Number(decimals) : undefined, locale),
    batchCall: (argsBatch) =>
      argsBatch.map(([num, decimals, locale]) =>
        formatNumber(num, decimals !== undefined ? Number(decimals) : undefined, locale)
      ),
  });

  db.registerFunction('format_compact', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (num: any, locale?: any) => formatCompact(num, locale),
    batchCall: (argsBatch) =>
      argsBatch.map(([num, locale]) => formatCompact(num, locale)),
  });

  db.registerFunction('format_percent', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (ratio: any, decimals?: any, locale?: any) =>
      formatPercent(ratio, decimals !== undefined ? Number(decimals) : 1, locale),
    batchCall: (argsBatch) =>
      argsBatch.map(([ratio, decimals, locale]) =>
        formatPercent(ratio, decimals !== undefined ? Number(decimals) : 1, locale)
      ),
  });

  db.registerFunction('format_bytes', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (bytes: any, decimals?: any) =>
      formatBytes(bytes, decimals !== undefined ? Number(decimals) : 1),
    batchCall: (argsBatch) =>
      argsBatch.map(([bytes, decimals]) =>
        formatBytes(bytes, decimals !== undefined ? Number(decimals) : 1)
      ),
  });

  db.registerFunction('plural', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (count: any, singular: any, pluralText?: any, zeroText?: any) =>
      plural(
        count,
        String(singular),
        pluralText ? String(pluralText) : undefined,
        zeroText ? String(zeroText) : undefined
      ),
    batchCall: (argsBatch) =>
      argsBatch.map(([count, singular, pluralText, zeroText]) =>
        plural(
          count,
          String(singular),
          pluralText ? String(pluralText) : undefined,
          zeroText ? String(zeroText) : undefined
        )
      ),
  });

  return db;
}

/**
 * Registers string, regex and text transformation UDFs on a WebDB instance:
 * - `regexp_match(text, pattern, [flags]) -> INT32` (1 or 0)
 * - `regexp_replace(text, pattern, replacement, [flags]) -> TEXT`
 * - `slugify(text) -> TEXT`
 * - `unaccent(text) -> TEXT`
 * - `pad_left(str, length, [padChar=' ']) -> TEXT`
 * - `pad_right(str, length, [padChar=' ']) -> TEXT`
 */
export function registerStringFunctions(db: WebDB): WebDB {
  db.registerFunction('regexp_match', {
    deterministic: true,
    returnType: DataType.INT32,
    call: (text: any, pattern: any, flags?: any) =>
      regexpMatch(text, pattern, flags),
    batchCall: (argsBatch) =>
      argsBatch.map(([text, pattern, flags]) => regexpMatch(text, pattern, flags)),
  });

  db.registerFunction('regexp_replace', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (text: any, pattern: any, replacement: any, flags?: any) =>
      regexpReplace(text, pattern, replacement, flags),
    batchCall: (argsBatch) =>
      argsBatch.map(([text, pattern, replacement, flags]) =>
        regexpReplace(text, pattern, replacement, flags)
      ),
  });

  db.registerFunction('slugify', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (text: any) => slugify(text),
    batchCall: (argsBatch) => argsBatch.map(([text]) => slugify(text)),
  });

  db.registerFunction('unaccent', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (text: any) => unaccent(text),
    batchCall: (argsBatch) => argsBatch.map(([text]) => unaccent(text)),
  });

  db.registerFunction('pad_left', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (str: any, length: any, padChar?: any) =>
      padLeft(str, Number(length), padChar ? String(padChar) : ' '),
    batchCall: (argsBatch) =>
      argsBatch.map(([str, length, padChar]) =>
        padLeft(str, Number(length), padChar ? String(padChar) : ' ')
      ),
  });

  db.registerFunction('pad_right', {
    deterministic: true,
    returnType: DataType.TEXT,
    call: (str: any, length: any, padChar?: any) =>
      padRight(str, Number(length), padChar ? String(padChar) : ' '),
    batchCall: (argsBatch) =>
      argsBatch.map(([str, length, padChar]) =>
        padRight(str, Number(length), padChar ? String(padChar) : ' ')
      ),
  });

  return db;
}

/**
 * Registers all date, number, currency, and string Intl UDFs on a WebDB instance at once.
 */
export function registerIntlFunctions(db: WebDB): WebDB {
  registerDateFunctions(db);
  registerNumberFunctions(db);
  registerStringFunctions(db);
  return db;
}

// ============================================================================
// 6. Type-Safe QueryBuilder Expression Helpers
// ============================================================================

/** Wraps a literal value into an ExpressionBuilder node. */
export function lit(value: unknown): ExpressionBuilder {
  return new ExpressionBuilder({ type: 'literal', value } as any);
}

export type ColumnOrExpr = string | ExpressionBuilder;

function toExpr(target: ColumnOrExpr): ExpressionBuilder {
  return typeof target === 'string' ? col(target) : target;
}

/**
 * Returns an ExpressionBuilder calling `format_date(col, style, locale, tz)`.
 */
export function formatDateExpr(
  target: ColumnOrExpr,
  style: string = 'medium',
  locale?: string,
  timeZone?: string
): ExpressionBuilder {
  const args = [toExpr(target), lit(style)];
  if (locale !== undefined) args.push(lit(locale));
  if (timeZone !== undefined) {
    if (locale === undefined) args.push(lit(''));
    args.push(lit(timeZone));
  }
  return fn('format_date', ...args);
}

/**
 * Returns an ExpressionBuilder calling `time_ago(col, [baseTs], [locale])`.
 */
export function timeAgoExpr(
  target: ColumnOrExpr,
  baseTs?: unknown,
  locale?: string
): ExpressionBuilder {
  const args = [toExpr(target)];
  if (baseTs !== undefined) args.push(lit(baseTs));
  if (locale !== undefined) {
    if (baseTs === undefined) args.push(lit(null));
    args.push(lit(locale));
  }
  return fn('time_ago', ...args);
}

/**
 * Returns an ExpressionBuilder calling `days_since(col, [baseTs])`.
 */
export function daysSinceExpr(target: ColumnOrExpr, baseTs?: unknown): ExpressionBuilder {
  return baseTs !== undefined
    ? fn('days_since', toExpr(target), lit(baseTs))
    : fn('days_since', toExpr(target));
}

/**
 * Returns an ExpressionBuilder calling `date_part(part, col)`.
 */
export function datePartExpr(part: string, target: ColumnOrExpr): ExpressionBuilder {
  return fn('date_part', lit(part), toExpr(target));
}

/**
 * Returns an ExpressionBuilder calling `format_currency(col, currency, [locale])`.
 */
export function formatCurrencyExpr(
  target: ColumnOrExpr,
  currency: string = 'USD',
  locale?: string
): ExpressionBuilder {
  return locale !== undefined
    ? fn('format_currency', toExpr(target), lit(currency), lit(locale))
    : fn('format_currency', toExpr(target), lit(currency));
}

/**
 * Returns an ExpressionBuilder calling `format_number(col, [decimals], [locale])`.
 */
export function formatNumberExpr(
  target: ColumnOrExpr,
  decimals?: number,
  locale?: string
): ExpressionBuilder {
  const args = [toExpr(target)];
  if (decimals !== undefined) args.push(lit(decimals));
  if (locale !== undefined) {
    if (decimals === undefined) args.push(lit(null));
    args.push(lit(locale));
  }
  return fn('format_number', ...args);
}

/**
 * Returns an ExpressionBuilder calling `format_compact(col, [locale])`.
 */
export function formatCompactExpr(target: ColumnOrExpr, locale?: string): ExpressionBuilder {
  return locale !== undefined
    ? fn('format_compact', toExpr(target), lit(locale))
    : fn('format_compact', toExpr(target));
}

/**
 * Returns an ExpressionBuilder calling `format_percent(col, [decimals], [locale])`.
 */
export function formatPercentExpr(
  target: ColumnOrExpr,
  decimals: number = 1,
  locale?: string
): ExpressionBuilder {
  return locale !== undefined
    ? fn('format_percent', toExpr(target), lit(decimals), lit(locale))
    : fn('format_percent', toExpr(target), lit(decimals));
}

/**
 * Returns an ExpressionBuilder calling `format_bytes(col, [decimals])`.
 */
export function formatBytesExpr(target: ColumnOrExpr, decimals: number = 1): ExpressionBuilder {
  return fn('format_bytes', toExpr(target), lit(decimals));
}

/**
 * Returns an ExpressionBuilder calling `regexp_match(col, pattern, [flags])`.
 */
export function regexpMatchExpr(
  target: ColumnOrExpr,
  pattern: string,
  flags?: string
): ExpressionBuilder {
  return flags !== undefined
    ? fn('regexp_match', toExpr(target), lit(pattern), lit(flags))
    : fn('regexp_match', toExpr(target), lit(pattern));
}

/**
 * Returns an ExpressionBuilder calling `slugify(col)`.
 */
export function slugifyExpr(target: ColumnOrExpr): ExpressionBuilder {
  return fn('slugify', toExpr(target));
}

/**
 * Returns an ExpressionBuilder calling `unaccent(col)`.
 */
export function unaccentExpr(target: ColumnOrExpr): ExpressionBuilder {
  return fn('unaccent', toExpr(target));
}
