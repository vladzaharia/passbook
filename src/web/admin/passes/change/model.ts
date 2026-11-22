import type { FieldDef } from '../schema-form/index.ts';
import { CHANGE_COPY as C } from './copy.ts';

export type ChangeKind = 'fields' | 'design' | 'void';
export type OpChoice = 'set' | 'clear' | 'extend' | 'shorten' | 'add' | 'subtract';
export type Unit = 'D' | 'W' | 'M' | 'Y';

/** One field of the "Set fields" kind. */
export interface FieldRow {
  id: string;
  key: string;
  op: OpChoice;
  /** The value for `set`. */
  value: unknown;
  /** The number for extend, shorten, add and subtract. */
  amount: string;
  unit: Unit;
}

export const newRow = (key: string, id: string): FieldRow => ({
  id,
  key,
  op: 'set',
  value: undefined,
  amount: '1',
  unit: 'Y',
});

/** The operations a field's type allows. */
export function opsFor(field: FieldDef | undefined): OpChoice[] {
  if (field?.widget === 'date' || field?.widget === 'datetime')
    return ['set', 'clear', 'extend', 'shorten'];
  if (field?.type === 'number' || field?.type === 'integer')
    return ['set', 'clear', 'add', 'subtract'];
  return ['set', 'clear'];
}

export const opLabel = (op: OpChoice) => C.ops[op];

/** The row's server op, or an error line when it is not ready. */
export function rowOp(row: FieldRow): { op: unknown } | { error: string } {
  if (row.op === 'clear') return { op: { clear: true } };
  if (row.op === 'set') {
    if (row.value === undefined || row.value === '') return { error: 'Enter a value.' };
    return { op: { set: row.value } };
  }
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0 || row.amount.trim() === '')
    return { error: 'Enter a number above 0.' };
  if (row.op === 'add') return { op: { add: amount } };
  if (row.op === 'subtract') return { op: { add: -amount } };
  if (!Number.isInteger(amount)) return { error: 'Use a whole number.' };
  return { op: { shift: `${row.op === 'shorten' ? '-' : ''}P${amount}${row.unit}` } };
}

/** The patch the server takes for a kind; null when the person has more to fill in. */
export function patchOf(
  kind: ChangeKind,
  rows: readonly FieldRow[],
): Record<string, unknown> | null {
  if (kind === 'void') return { $void: true };
  if (kind === 'design') return { $design: true };
  if (rows.length === 0) return null;
  const patch: Record<string, unknown> = {};
  for (const row of rows) {
    const made = rowOp(row);
    if ('error' in made) return null;
    patch[row.key] = made.op;
  }
  return patch;
}

export const rowErrors = (rows: readonly FieldRow[]): Record<string, string> =>
  Object.fromEntries(
    rows.flatMap((r) => {
      const made = rowOp(r);
      return 'error' in made ? [[r.id, made.error] as const] : [];
    }),
  );
