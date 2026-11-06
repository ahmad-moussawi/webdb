import { ColumnFlag, DataType } from '@ahmadmoussawi/webdb';
import type { QueryShape, TableMeta } from '@ahmadmoussawi/webdb';

/** Maps a result-grid column onto a real table column. */
export interface ColumnTarget {
  table: string;
  column: string;
  type: DataType;
  notNull: boolean;
  isPrimaryKey: boolean;
}

export interface EditableSource {
  /** Result column -> table column. `null` means the column can't be edited (with a reason). */
  columns: Map<string, ColumnTarget | { reason: string }>;
  /** Table name -> its PK columns as `{ pk column, result column }` pairs. */
  primaryKeys: Map<string, Array<{ column: string; resultColumn: string }>>;
  /** Tables whose records can't be identified (PK missing or table has no PK), with reason. */
  blockedTables: Map<string, string>;
}

export interface EditabilityResult {
  /** Present when the whole grid is read-only. */
  disabledReason?: string;
  source?: EditableSource;
}

const NO_SHAPE_REASON =
  'Editing is only available for query builder results (e.g. return db.from("table")).';

function splitQualified(name: string): { table?: string; column: string } {
  const dot = name.indexOf('.');
  if (dot === -1) return { column: name };
  return { table: name.slice(0, dot), column: name.slice(dot + 1) };
}

/**
 * Decides which result columns map onto real table columns, and which tables have
 * their full primary key present in the result (required to identify a record).
 */
export function resolveEditability(
  shape: QueryShape | null | undefined,
  resultColumns: string[],
  tables: TableMeta[],
): EditabilityResult {
  if (!shape) return { disabledReason: NO_SHAPE_REASON };
  if (shape.fromSubquery) {
    return { disabledReason: 'Results from a derived table (subquery in FROM) are read-only.' };
  }
  if (shape.grouped) {
    return { disabledReason: 'Grouped / aggregated results are read-only.' };
  }

  const metaByName = new Map<string, TableMeta>();
  for (const t of tables) metaByName.set(t.name.toLowerCase(), t);

  const scope = [shape.table, ...shape.joins.map((j) => j.table)];
  const scopeMetas: TableMeta[] = [];
  for (const name of scope) {
    const meta = metaByName.get(name.toLowerCase());
    if (!meta) return { disabledReason: `Table "${name}" was not found in the catalog.` };
    scopeMetas.push(meta);
  }
  const hasJoins = shape.joins.length > 0;

  const findTarget = (rawName: string): ColumnTarget | { reason: string } => {
    const { table, column } = splitQualified(rawName);
    let candidates: TableMeta[];
    if (table) {
      candidates = scopeMetas.filter((m) => m.name.toLowerCase() === table.toLowerCase());
    } else {
      candidates = scopeMetas.filter((m) => m.columns.some((c) => c.name === column));
    }
    if (candidates.length === 0) {
      return { reason: `Column "${rawName}" doesn't map to a table column.` };
    }
    if (candidates.length > 1) {
      return {
        reason: `Column "${rawName}" is ambiguous across joined tables. Qualify it (e.g. "table.${column}").`,
      };
    }
    const meta = candidates[0];
    const col = meta.columns.find((c) => c.name === column);
    if (!col) return { reason: `Column "${rawName}" doesn't exist on "${meta.name}".` };
    return {
      table: meta.name,
      column: col.name,
      type: col.type,
      notNull: (col.flags & ColumnFlag.NOT_NULL) !== 0,
      isPrimaryKey: (col.flags & ColumnFlag.PRIMARY_KEY) !== 0,
    };
  };

  const columns = new Map<string, ColumnTarget | { reason: string }>();

  if (shape.select.length === 0) {
    // No projection: keys are bare column names, or "table.column" when they collide across joins.
    for (const key of resultColumns) {
      columns.set(key, findTarget(key));
    }
  } else {
    const byAlias = new Map(shape.select.map((s) => [s.alias, s]));
    for (const key of resultColumns) {
      const field = byAlias.get(key);
      if (!field) {
        columns.set(key, { reason: `Column "${key}" isn't a plain table column.` });
      } else if (field.computed || !field.sourceCol) {
        columns.set(key, { reason: `"${key}" is a computed value and can't be edited.` });
      } else {
        columns.set(key, findTarget(field.sourceCol));
      }
    }
  }

  // Which tables appear in the result, and is their full PK present?
  const primaryKeys = new Map<string, Array<{ column: string; resultColumn: string }>>();
  const blockedTables = new Map<string, string>();
  const usedTables = new Set<string>();
  for (const t of columns.values()) {
    if ('table' in t) usedTables.add(t.table);
  }
  for (const tableName of usedTables) {
    const meta = metaByName.get(tableName.toLowerCase())!;
    const pkCols = meta.columns.filter((c) => (c.flags & ColumnFlag.PRIMARY_KEY) !== 0);
    if (pkCols.length === 0) {
      blockedTables.set(tableName, `Table "${tableName}" has no primary key, so its rows can't be identified.`);
      continue;
    }
    const pairs: Array<{ column: string; resultColumn: string }> = [];
    let missing: string | null = null;
    for (const pk of pkCols) {
      let resultColumn: string | null = null;
      for (const [rk, t] of columns) {
        if ('table' in t && t.table === tableName && t.column === pk.name) {
          resultColumn = rk;
          break;
        }
      }
      if (resultColumn === null) {
        missing = pk.name;
        break;
      }
      pairs.push({ column: pk.name, resultColumn });
    }
    if (missing !== null) {
      blockedTables.set(
        tableName,
        `Primary key column "${missing}" of "${tableName}" isn't in the result, so its rows can't be identified.`,
      );
    } else {
      primaryKeys.set(tableName, pairs);
    }
  }

  void hasJoins;
  return { source: { columns, primaryKeys, blockedTables } };
}

export interface CellEditability {
  editable: boolean;
  reason?: string;
  target?: ColumnTarget;
}

/** Whether a given cell (column + row) can be edited, with a user-facing reason when it can't. */
export function getCellEditability(
  result: EditabilityResult,
  resultColumn: string,
  row: Record<string, unknown> | null | undefined,
): CellEditability {
  if (result.disabledReason) return { editable: false, reason: result.disabledReason };
  const source = result.source;
  if (!source) return { editable: false, reason: NO_SHAPE_REASON };
  const target = source.columns.get(resultColumn);
  if (!target) return { editable: false, reason: `Column "${resultColumn}" can't be edited.` };
  if ('reason' in target) return { editable: false, reason: target.reason };
  const blocked = source.blockedTables.get(target.table);
  if (blocked) return { editable: false, reason: blocked };
  if (target.type === DataType.BLOB) {
    return { editable: false, reason: 'BLOB columns can\'t be edited in the grid.' };
  }
  const pks = source.primaryKeys.get(target.table) ?? [];
  if (!row || pks.some((pk) => row[pk.resultColumn] === null || row[pk.resultColumn] === undefined)) {
    return {
      editable: false,
      reason: `This row has no record from "${target.table}" (NULL primary key, e.g. unmatched LEFT JOIN).`,
    };
  }
  return { editable: true, target };
}

/** Parses the text typed in a cell into a value matching the column's type. */
export function parseCellInput(
  text: string,
  target: Pick<ColumnTarget, 'type' | 'notNull' | 'isPrimaryKey' | 'column'>,
  isNull: boolean,
): { ok: true; value: number | bigint | string | null } | { ok: false; error: string } {
  if (isNull) {
    if (target.notNull || target.isPrimaryKey) {
      return { ok: false, error: `"${target.column}" is NOT NULL.` };
    }
    return { ok: true, value: null };
  }
  const trimmed = text.trim();
  switch (target.type) {
    case DataType.INT32: {
      if (!/^[+-]?\d+$/.test(trimmed)) return { ok: false, error: 'Expected an integer.' };
      const n = Number(trimmed);
      if (n < -2147483648 || n > 2147483647) return { ok: false, error: 'Out of INT32 range.' };
      return { ok: true, value: n };
    }
    case DataType.INT64: {
      if (!/^[+-]?\d+$/.test(trimmed)) return { ok: false, error: 'Expected an integer.' };
      return { ok: true, value: BigInt(trimmed) };
    }
    case DataType.FLOAT64: {
      const n = Number(trimmed);
      if (trimmed === '' || !Number.isFinite(n)) return { ok: false, error: 'Expected a number.' };
      return { ok: true, value: n };
    }
    case DataType.UUID:
    case DataType.ULID:
      return { ok: true, value: trimmed };
    default:
      return { ok: true, value: text };
  }
}

/** Display text used to seed the editor from a cell value. */
export function cellValueToText(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

