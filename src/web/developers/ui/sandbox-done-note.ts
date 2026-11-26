import { formatShortDateIn } from '../../lib/format.ts';
import type { Operation } from '../../ui/operation/types.ts';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The line under a finished operation: what a delete left to do, what a reset removed. */
export function doneNoteOf(op: Operation): string | null {
  if (op.kind === 'sandbox.delete' || op.kind === 'sandbox.recreate') {
    const erase = op.steps.find((s) => s.key === 'erase' && s.until !== null);
    return op.kind === 'sandbox.delete' && erase?.until
      ? `Data is erased by ${formatShortDateIn(erase.until)}.`
      : null;
  }
  const ids = op.result?.ids;
  if (op.kind !== 'sandbox.reset' || !ids) return null;
  const n = (key: string) => Number(ids[key] ?? 0);
  const kept =
    n('kept') > 0 ? ` ${plural(n('kept'), 'pass', 'passes')} could not be deleted yet.` : '';
  return `Deleted ${plural(n('passes'), 'pass', 'passes')}, ${plural(n('captures'), 'event')} and ${plural(n('calls'), 'call')}.${kept} ${n('resetsLeft')} ${n('resetsLeft') === 1 ? 'reset' : 'resets'} left today.`;
}
