import type { ConfirmCopy } from './confirms.ts';
import { formatCount } from './format.ts';

/** A change run's undo: every pass still at the run's value goes back, silently. */
export function changeUndoConfirm(count: number): ConfirmCopy {
  return {
    title: 'Undo this change?',
    confirmLabel: 'Undo change',
    description: `${count === 1 ? '1 pass goes' : `${formatCount(count)} passes go`} back to their old values. Passes edited since stay as they are. Nobody is told.`,
    typed: false,
  };
}

/** The passes a change run reaches differ from the count the person selected: confirm the new one. */
export function selectionMovedConfirm(now: number): ConfirmCopy {
  return {
    title: 'The selection changed',
    confirmLabel: 'Run',
    cancelLabel: 'Review again',
    description: `It now matches ${formatCount(now)} ${now === 1 ? 'pass' : 'passes'}. Run on those?`,
    typed: false,
  };
}
