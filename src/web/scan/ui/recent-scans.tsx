import { Cloud, Undo2 } from 'lucide-react';
import { groupLine } from '../../../shared/copy/scan-group.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import type { Recent, ScanOutcome } from '../machine/types.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import { verdictLine } from '../machine/verdict-lines.ts';
import { toneOf } from '../result/tone.ts';
import { DISC_GLYPH } from './disc-glyph.ts';
import { sessionTime } from './session-time.ts';

const COPY = SCAN_HANDHELD_COPY.sheet;

/** What a row says it did: the action, or the verdict's own words. Never a reason code. */
export function rowLabel(o: ScanOutcome, now: number): string {
  if (o.action?.id === 'undo') return 'Undone';
  if (o.kind === 'ok') return o.action?.label ?? 'Done';
  return verdictLine(o, now)?.headline ?? o.action?.label ?? 'Not checked';
}

/** The last 20 scans of this device: the verdict, who, what, when. A row opens its pass; Undo reverts it. */
export function RecentList({ onPick }: { onPick: (row: Recent) => void }) {
  const { state, now, dispatch } = useScanMachine();
  return (
    <>
      {state.recent.length ? (
        <ol className="scan-recent" data-testid="scan-recent">
          {state.recent.slice(0, 20).map((row) => {
            const tone = toneOf(row.outcome.kind);
            const Glyph = DISC_GLYPH[tone];
            const canUndo = row.undoable && row.scanId && (row.outcome.undoUntil ?? 0) > now;
            return (
              <li key={row.scanId ?? row.at} className="scan-recent-row">
                <button type="button" className="scan-recent-open" onClick={() => onPick(row)}>
                  <span aria-hidden className="scan-strip-disc" data-kind={tone}>
                    <Glyph size={15} strokeWidth={2.5} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <p>
                      {row.outcome.display?.identity.holder ??
                        row.outcome.card?.title ??
                        'Unknown code'}
                    </p>
                    <p>
                      {rowLabel(row.outcome, now)}
                      {row.outcome.group ? ` · ${groupLine(row.outcome.group)}` : ''} ·{' '}
                      {sessionTime(row.at)}
                      {row.outcome.kind === 'queued' ? (
                        <>
                          {' · '}
                          <Cloud aria-hidden size={13} className="inline" /> {COPY.notConfirmed}
                        </>
                      ) : null}
                    </p>
                  </span>
                </button>
                {canUndo ? (
                  <button
                    type="button"
                    className="scan-strip-undo"
                    disabled={state.undo !== null}
                    onClick={() => dispatch({ type: 'undo', scanId: row.scanId ?? '' })}
                  >
                    <Undo2 aria-hidden size={18} className="scan-strip-undo-icon" />
                    {COPY.undo}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="scan-sheet-status" style={{ textAlign: 'center', paddingBlock: 32 }}>
          {COPY.noScans}
        </p>
      )}
      {state.unsure.length ? (
        <p role="status" className="scan-sheet-status">
          {COPY.unsure.replace('{n}', String(state.unsure.length))}
        </p>
      ) : null}
    </>
  );
}
