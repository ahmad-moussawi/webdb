import type { OutputFormat } from './format.js';

export interface FlagDef {
  name: string;
  short?: string;
  type: 'string' | 'boolean';
  multiple?: boolean;
}

export interface ParsedFlagEntry {
  name: string;
  value: string | boolean;
}

export interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | boolean | string[]>;
  /** Flags in the exact order they appeared on the command line. */
  entries: ParsedFlagEntry[];
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function parseCliArgs(argv: string[], defs: FlagDef[]): ParsedArgs {
  const byLong = new Map<string, FlagDef>();
  const byShort = new Map<string, FlagDef>();
  const values: Record<string, string | boolean | string[]> = {};
  const entries: ParsedFlagEntry[] = [];

  for (const def of defs) {
    byLong.set(def.name, def);
    if (def.short) byShort.set(def.short, def);
    if (def.multiple) {
      values[def.name] = [];
    } else if (def.type === 'boolean') {
      values[def.name] = false;
    }
  }

  const positionals: string[] = [];
  let stopFlags = false;

  const assignValue = (def: FlagDef, val: string | boolean) => {
    entries.push({ name: def.name, value: val });
    if (def.multiple) {
      (values[def.name] as string[]).push(String(val));
    } else {
      values[def.name] = val;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (stopFlags) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      stopFlags = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      const flagName = eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2);
      const inlineVal = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;
      const def = byLong.get(flagName);
      if (!def) {
        throw new CliUsageError(`Unknown option: --${flagName}`);
      }
      if (def.type === 'boolean') {
        if (inlineVal !== undefined) {
          if (inlineVal === 'true' || inlineVal === '1') assignValue(def, true);
          else if (inlineVal === 'false' || inlineVal === '0') assignValue(def, false);
          else throw new CliUsageError(`Invalid boolean value for --${flagName}: ${inlineVal}`);
        } else {
          assignValue(def, true);
        }
      } else {
        if (inlineVal !== undefined) {
          assignValue(def, inlineVal);
        } else {
          if (i + 1 >= argv.length) {
            throw new CliUsageError(`Option --${flagName} requires a value`);
          }
          assignValue(def, argv[++i]);
        }
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const shortName = arg.slice(1);
      const def = byShort.get(shortName);
      if (!def) {
        throw new CliUsageError(`Unknown option: -${shortName}`);
      }
      if (def.type === 'boolean') {
        assignValue(def, true);
      } else {
        if (i + 1 >= argv.length) {
          throw new CliUsageError(`Option -${shortName} requires a value`);
        }
        assignValue(def, argv[++i]);
      }
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, values, entries };
}

/**
 * Checks whether `-h` or `--help` was passed as a real flag (not after `--` and
 * not as the value argument to another string option such as `--out --help`).
 */
export function hasHelpFlag(argv: string[], defs: FlagDef[]): boolean {
  const stringLongs = new Set<string>();
  const stringShorts = new Set<string>();
  for (const def of defs) {
    if (def.type === 'string') {
      stringLongs.add(def.name);
      if (def.short) stringShorts.add(def.short);
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return false;
    if (arg === '-h' || arg === '--help') return true;
    if (arg.startsWith('--') && !arg.includes('=')) {
      if (stringLongs.has(arg.slice(2))) i++;
    } else if (arg.startsWith('-') && arg.length > 1) {
      if (stringShorts.has(arg.slice(1))) i++;
    }
  }
  return false;
}

/**
 * Splits a comma-separated string while ignoring commas inside parentheses or quotes.
 * Example: `"concat(first, ' ', last) as full_name, age"` -> `["concat(first, ' ', last) as full_name", "age"]`
 */
export function splitTopLevelComma(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < input.length) {
        current += input[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

export interface ParsedOrderSpec {
  col: string;
  direction: 'asc' | 'desc';
  nullOrder?: 'nulls_first' | 'nulls_last';
}

/**
 * Parses an order-by spec such as:
 * - `"score"`
 * - `"score:desc"`
 * - `"score desc"`
 * - `"score desc nulls last"`
 */
export function parseOrderSpec(raw: string): ParsedOrderSpec {
  let text = raw.trim();
  if (!text) {
    throw new CliUsageError('Empty --order specification');
  }

  let nullOrder: 'nulls_first' | 'nulls_last' | undefined;
  const nullsMatch = text.match(/\s+nulls\s+(first|last)$/i);
  if (nullsMatch) {
    nullOrder = nullsMatch[1].toLowerCase() === 'first' ? 'nulls_first' : 'nulls_last';
    text = text.slice(0, nullsMatch.index).trim();
  }

  const colonMatch = text.match(/^(.+):(asc|desc)$/i);
  if (colonMatch) {
    return {
      col: colonMatch[1].trim(),
      direction: colonMatch[2].toLowerCase() as 'asc' | 'desc',
      nullOrder,
    };
  }

  const spaceMatch = text.match(/^(.+)\s+(asc|desc)$/i);
  if (spaceMatch) {
    return {
      col: spaceMatch[1].trim(),
      direction: spaceMatch[2].toLowerCase() as 'asc' | 'desc',
      nullOrder,
    };
  }

  return { col: text, direction: 'asc', nullOrder };
}

export interface ParsedJoinSpec {
  table: string;
  leftCol: string;
  op: '=' | '!=' | '<' | '<=' | '>' | '>=';
  rightCol: string;
}

/**
 * Parses a join spec in the format `table:leftCol=rightCol`
 * (supports `=`, `==`, `!=`, `<>`, `<`, `<=`, `>`, `>=`).
 */
export function parseJoinSpec(raw: string): ParsedJoinSpec {
  const colonIdx = raw.indexOf(':');
  if (colonIdx <= 0 || colonIdx === raw.length - 1) {
    throw new CliUsageError(
      `Invalid join spec "${raw}". Expected format: <table>:<leftCol>=<rightCol> (e.g. orders:users.id=orders.user_id)`,
    );
  }
  const table = raw.slice(0, colonIdx).trim();
  const cond = raw.slice(colonIdx + 1).trim();
  if (!table || !cond) {
    throw new CliUsageError(
      `Invalid join spec "${raw}". Expected non-empty table name and condition.`,
    );
  }
  const match = cond.match(/^(.+?)\s*(!=|<>|<=|>=|==|=|<|>)\s*(.+)$/);
  if (!match) {
    throw new CliUsageError(
      `Invalid join condition "${cond}" in "${raw}". Expected format: <leftCol>=<rightCol>`,
    );
  }
  const leftCol = match[1].trim();
  const rightCol = match[3].trim();
  if (!leftCol || !rightCol) {
    throw new CliUsageError(
      `Invalid join condition "${cond}" in "${raw}". Both left and right columns are required.`,
    );
  }
  const rawOp = match[2];
  const op: ParsedJoinSpec['op'] =
    rawOp === '==' ? '=' : rawOp === '<>' ? '!=' : (rawOp as ParsedJoinSpec['op']);
  return {
    table,
    leftCol,
    op,
    rightCol,
  };
}

export function parseOutputFormat(
  raw: string | undefined,
  allowed: OutputFormat[] = ['table', 'json', 'ndjson', 'csv'],
  fallback: OutputFormat = 'table',
): OutputFormat {
  if (!raw) return fallback;
  const lower = raw.toLowerCase() as OutputFormat;
  if (!allowed.includes(lower)) {
    throw new CliUsageError(
      `Invalid --format "${raw}". Allowed values: ${allowed.join(', ')}`,
    );
  }
  return lower;
}

export function parsePositiveInt(raw: string, flagName: string, allowZero = false): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliUsageError(
      `Invalid ${flagName} value "${raw}": expected ${allowZero ? 'a non-negative' : 'a positive'} integer`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || (allowZero ? n < 0 : n <= 0)) {
    throw new CliUsageError(
      `Invalid ${flagName} value "${raw}": expected ${allowZero ? 'a non-negative' : 'a positive'} integer`,
    );
  }
  return n;
}
