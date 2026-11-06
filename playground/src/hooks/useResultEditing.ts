import { useCallback, useRef, useState } from 'react';
import {
  getCellEditability,
  type EditabilityResult,
} from '../utils/resultEditing';

export interface PendingEdit {
  row: number;
  col: string;
  value: number | bigint | string | null;
  /** Set when applying this edit failed. */
  error?: string;
}

export const editKey = (row: number, col: string) => `${row}\u0000${col}`;

interface Options {
  db: any;
  resultRows: any[];
  setResultRows: (rows: any[]) => void;
  showToast: (msg: string) => void;
}

const NO_EDITS: EditabilityResult = {
  disabledReason: 'Editing is only available for query builder results (e.g. return db.from("table")).',
};

/**
 * Staged (pending) cell edits for the results grid. Edits live in memory until `applyEdits`
 * writes them to the database in a single transaction.
 */
export function useResultEditing({ db, resultRows, setResultRows, showToast }: Options) {
  const [editability, setEditabilityState] = useState<EditabilityResult>(NO_EDITS);
  const [pendingEdits, setPendingEdits] = useState<Record<string, PendingEdit>>({});
  const [isApplying, setIsApplying] = useState(false);

  const pendingRef = useRef(pendingEdits);
  pendingRef.current = pendingEdits;
  const rowsRef = useRef(resultRows);
  rowsRef.current = resultRows;
  const editabilityRef = useRef(editability);
  editabilityRef.current = editability;

  const pendingCount = Object.keys(pendingEdits).length;

  const setEditability = useCallback((e: EditabilityResult | null) => {
    setEditabilityState(e ?? NO_EDITS);
  }, []);

  const discardEdits = useCallback(() => {
    setPendingEdits({});
  }, []);

  /** Returns true when it's OK to replace the current result (no pending edits or the user agreed to discard). */
  const confirmDiscardEdits = useCallback((): boolean => {
    const n = Object.keys(pendingRef.current).length;
    if (n === 0) return true;
    return window.confirm(`Discard ${n} unsaved edit${n === 1 ? '' : 's'}?`);
  }, []);

  const stageEdit = useCallback((row: number, col: string, value: PendingEdit['value']) => {
    const original = rowsRef.current[row]?.[col];
    const same =
      (original === null || original === undefined ? null : String(original)) ===
      (value === null ? null : String(value));
    setPendingEdits((prev) => {
      const key = editKey(row, col);
      const next = { ...prev };
      if (same) delete next[key];
      else next[key] = { row, col, value };
      return next;
    });
  }, []);

  const applyEdits = useCallback(async () => {
    const source = editabilityRef.current.source;
    const edits = Object.values(pendingRef.current);
    if (!db || !source || edits.length === 0) return;

    interface Group {
      table: string;
      filter: Record<string, any>;
      patch: Record<string, any>;
      cells: PendingEdit[];
      pkText: string;
    }
    const groups = new Map<string, Group>();
    const errors: Record<string, string> = {};

    for (const edit of edits) {
      const row = rowsRef.current[edit.row];
      const cell = getCellEditability(editabilityRef.current, edit.col, row);
      if (!cell.editable || !cell.target) {
        errors[editKey(edit.row, edit.col)] = cell.reason ?? 'Cell is not editable.';
        continue;
      }
      const table = cell.target.table;
      const pks = source.primaryKeys.get(table) ?? [];
      const filter: Record<string, any> = {};
      for (const pk of pks) filter[pk.column] = row[pk.resultColumn];
      const pkText = `${table}\u0000${pks.map((p) => String(filter[p.column])).join('\u0001')}`;
      let g = groups.get(pkText);
      if (!g) {
        g = { table, filter, patch: {}, cells: [], pkText };
        groups.set(pkText, g);
      }
      if (cell.target.column in g.patch && String(g.patch[cell.target.column]) !== String(edit.value)) {
        errors[editKey(edit.row, edit.col)] =
          'Conflicting edits to the same record. Make duplicate rows agree.';
        continue;
      }
      g.patch[cell.target.column] = edit.value;
      g.cells.push(edit);
    }

    const markErrors = (errs: Record<string, string>) =>
      setPendingEdits((prev) => {
        const next: Record<string, PendingEdit> = {};
        for (const [k, v] of Object.entries(prev)) {
          next[k] = errs[k] ? { ...v, error: errs[k] } : { ...v, error: undefined };
        }
        return next;
      });

    if (Object.keys(errors).length > 0) {
      markErrors(errors);
      showToast('Some edits are invalid — fix the cells highlighted in red.');
      return;
    }

    setIsApplying(true);
    let failedGroup: Group | null = null;
    try {
      await db.transaction(async (tx: any) => {
        for (const g of groups.values()) {
          try {
            const n = await tx.update(g.table, g.filter, g.patch);
            if (!n) throw new Error('Record not found (it may have been changed or deleted).');
          } catch (err) {
            failedGroup = g;
            throw err;
          }
        }
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      const errs: Record<string, string> = {};
      const failed = failedGroup as Group | null;
      if (failed) {
        for (const c of failed.cells) errs[editKey(c.row, c.col)] = message;
      } else {
        for (const e of edits) errs[editKey(e.row, e.col)] = message;
      }
      markErrors(errs);
      showToast(`Update failed, nothing was saved: ${message}`);
      setIsApplying(false);
      return;
    }

    // Success: reflect new values in every grid row that shows the same record.
    const originalRows = rowsRef.current;
    const nextRows = originalRows.map((row) => {
      if (!row || typeof row !== 'object') return row;
      let copy: any = null;
      for (const g of groups.values()) {
        const pks = source.primaryKeys.get(g.table) ?? [];
        const matches = pks.every((pk) => String(row[pk.resultColumn]) === String(g.filter[pk.column]));
        if (!matches) continue;
        for (const [resultCol, target] of source.columns) {
          if ('table' in target && target.table === g.table && target.column in g.patch) {
            copy = copy ?? { ...row };
            copy[resultCol] = g.patch[target.column];
          }
        }
      }
      return copy ?? row;
    });
    setResultRows(nextRows);
    setPendingEdits({});
    setIsApplying(false);
    showToast(`Saved ${edits.length} change${edits.length === 1 ? '' : 's'}`);
  }, [db, setResultRows, showToast]);

  return {
    editability,
    setEditability,
    pendingEdits,
    pendingCount,
    isApplyingEdits: isApplying,
    stageEdit,
    discardEdits,
    applyEdits,
    confirmDiscardEdits,
  };
}

