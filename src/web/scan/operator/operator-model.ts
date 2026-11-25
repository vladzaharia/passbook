/**
 * What the operator has open: one list view, the search text, the highlighted row and the person.
 * Pure, so the rules (search replaces the view, a scan never takes focus, Esc order) are tested
 * without a screen. The scan machine keeps owning scans; this holds only the operator's choices.
 */
import type { OperatorView } from './keys.ts';

/** A person's record, whichever list or key opened it. */
export type RecordRef =
  | {
      kind: 'pass';
      passId: string;
      from: 'activity' | 'problems' | 'inside' | 'roll-call' | 'search' | 'preview' | 'open';
    }
  | { kind: 'scan'; scanId: string };

export interface OperatorState {
  view: OperatorView;
  query: string;
  /** Index into the search results; -1 when none is highlighted. */
  highlight: number;
  record: RecordRef | null;
  help: boolean;
}

export const INITIAL: OperatorState = {
  view: 'activity',
  query: '',
  highlight: -1,
  record: null,
  help: false,
};

export type OperatorEvent =
  | { t: 'view'; view: OperatorView }
  | { t: 'query'; q: string }
  | { t: 'highlight'; index: number }
  | { t: 'move'; by: 1 | -1; count: number }
  | { t: 'open'; ref: RecordRef }
  | { t: 'close' }
  | { t: 'clear' }
  | { t: 'help'; open: boolean };

/** Moving to another hit leaves a record opened from search: the new hit is previewed instead. */
function withHighlight(s: OperatorState, index: number): OperatorState {
  const fromSearch = s.record?.kind === 'pass' && s.record.from === 'search';
  return { ...s, highlight: index, record: fromSearch && index !== s.highlight ? null : s.record };
}

export function reduceOperator(s: OperatorState, e: OperatorEvent): OperatorState {
  switch (e.t) {
    case 'view':
      return { ...s, view: e.view, query: '', highlight: -1 };
    case 'query':
      return { ...s, query: e.q, highlight: e.q.trim() ? s.highlight : -1 };
    case 'highlight':
      return withHighlight(s, e.index);
    case 'move': {
      if (e.count <= 0) return withHighlight(s, -1);
      const next = s.highlight + e.by;
      return withHighlight(s, Math.min(e.count - 1, Math.max(0, next)));
    }
    case 'open':
      return { ...s, record: e.ref };
    case 'close':
      // The highlighted result is no longer previewed: the record is closed until they move again.
      return { ...s, record: null, highlight: -1 };
    case 'clear':
      return { ...s, query: '', highlight: -1 };
    case 'help':
      return { ...s, help: e.open };
  }
}

/** Search replaces the list while the field has text. */
export const searching = (s: OperatorState): boolean => s.query.trim().length > 0;

/** Nothing open and nothing typed: the idle view and its focus rule. */
export const idle = (s: OperatorState, scanActive: boolean): boolean =>
  !scanActive && s.record === null && !searching(s);

/**
 * Where focus goes when a scan lands. Only from idle does it move, to the record heading;
 * anywhere else the operator keeps their place (rule 3).
 */
export function landingFocus(s: OperatorState, scanWasActive: boolean): 'heading' | 'stay' {
  return idle(s, scanWasActive) ? 'heading' : 'stay';
}
