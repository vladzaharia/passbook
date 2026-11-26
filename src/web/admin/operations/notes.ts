import { PRINT_COPY } from '../../../shared/copy/print.ts';
import type { Operation } from '../../ui/operation/index.ts';

const n = (op: Operation, key: string) => Number(op.result?.ids[key] ?? 0);
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The line under a finished rebuild: what changed, what stayed, what failed. */
export function rebuildNote(op: Operation): string | null {
  if (!op.result) return null;
  const failed = n(op, 'failed');
  return `${plural(n(op, 'changed'), 'pass', 'passes')} rebuilt, ${n(op, 'unchanged')} unchanged${failed ? `, ${failed} failed` : ''}.`;
}

/** The line under a finished sync. */
export function syncNote(op: Operation): string | null {
  if (!op.result) return null;
  const errors = n(op, 'errors');
  return `${plural(n(op, 'seen'), 'record')} read, ${n(op, 'created')} new, ${n(op, 'changed')} changed${errors ? `, ${errors} with errors` : ''}.`;
}

/** The line under finished wallet passes. */
export function walletNote(op: Operation): string | null {
  if (!op.result) return null;
  const skipped = n(op, 'skipped');
  return `${plural(n(op, 'updated'), 'pass', 'passes')} updated${skipped ? `, ${skipped} skipped` : ''}.`;
}

/** The line under finished tickets: what was left out, and whether the PDF replaced a character. */
export function printNote(op: Operation): string | null {
  if (!op.result) return null;
  const count = n(op, 'count');
  return PRINT_COPY.bulkReady(plural(count, 'ticket'), n(op, 'lossy') > 0, n(op, 'skipped'), '');
}
