import type { ScanDisplayNeeds } from '../../../passkit/template/scan-display/index.ts';
import type { ScanDisplay, ScanDisplayScreen } from '../../../shared/contracts/scan-display.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';

/** C17. Stream DS owns this file after P0; the signatures are frozen. */
export interface BuildDisplayInput {
  actor: ScanActor;
  /** Null when no pass matched: there is then no display. */
  pass: { id: string; title: string } | null;
  screen: ScanDisplayScreen;
  /** DS narrows these when it builds the model. */
  card?: unknown;
  template?: unknown;
  scan?: unknown;
  history?: unknown;
}

export interface HistoryReader {
  stmts: D1PreparedStatement[];
  /** Turns the results of `stmts`, in order, into the display scope's `history` root. */
  read(results: D1Result[]): unknown;
}

const initialsOf = (holder: string) =>
  holder
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();

/** Never throws: no pass gives null, and the verdict goes out either way. P0: identity only. */
export function buildDisplay(_ctx: ServiceContext, input: BuildDisplayInput): ScanDisplay | null {
  if (!input.pass) return null;
  const holder = input.pass.title.slice(0, 40);
  return {
    v: 1,
    screen: input.screen,
    templateVersion: '',
    variant: null,
    identity: { holder, initials: initialsOf(holder).slice(0, 2), photo: null },
    header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
    panels: [],
    notes: { staff: null, refused: null },
  };
}

/** The statements a display's `history` reads need, batched with the card read. P0: none. */
export function historyStatements(
  _db: D1Database,
  _needs: ScanDisplayNeeds,
  _scope: { passId: string; orgId: string; timeZone: string; now: number },
): HistoryReader {
  return { stmts: [], read: () => ({}) };
}
