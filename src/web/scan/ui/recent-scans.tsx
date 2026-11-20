import { Check, CircleAlert, Info, TriangleAlert, Undo2 } from 'lucide-react';
import { groupLine } from '../../../shared/copy/scan-group.ts';
import { formatTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { ScanOutcome } from '../machine/types.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import { verdictLine } from '../machine/verdict-lines.ts';

const GLYPH = {
  ok: Check,
  heads_up: TriangleAlert,
  refused: CircleAlert,
  system: Info,
  ready: Info,
  queued: Info,
};
/** What a row says it did: the action, or the verdict's own words. Never a reason code. */
export function rowLabel(o: ScanOutcome, now: number): string {
  if (o.action?.id === 'undo') return 'Undone';
  if (o.kind === 'ok') return o.action?.label ?? 'Done';
  return verdictLine(o, now)?.headline ?? o.action?.label ?? 'Not checked';
}

export function RecentScans({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, now, dispatch } = useScanMachine();
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetContent title="Recent scans" className="scan-detail-sheet">
        <div className="p-4">
          {state.recent.length ? (
            <ol>
              {state.recent.slice(0, 20).map((row) => {
                const Glyph = GLYPH[row.outcome.kind];
                return (
                  <li
                    key={row.scanId ?? row.at}
                    className="flex min-h-18 items-center gap-3 border-b border-border py-3"
                  >
                    <span className="scan-strip-disc" data-kind={row.outcome.kind}>
                      <Glyph size={15} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {row.outcome.display?.identity.holder ??
                          row.outcome.card?.title ??
                          'Unknown code'}
                      </p>
                      <p className="text-sm text-fg-muted">
                        {rowLabel(row.outcome, now)}
                        {row.outcome.group ? ` · ${groupLine(row.outcome.group)}` : ''} ·{' '}
                        {formatTime(row.at)}
                      </p>
                    </div>
                    {row.undoable && row.scanId && (row.outcome.undoUntil ?? 0) > now ? (
                      <Button
                        variant="ghost"
                        disabled={state.undo !== null}
                        loading={state.undo?.scanId === row.scanId}
                        iconStart={<Undo2 aria-hidden />}
                        onClick={() => dispatch({ type: 'undo', scanId: row.scanId ?? '' })}
                      >
                        Undo
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="py-8 text-center text-fg-muted">No scans yet.</p>
          )}
          {state.unsure.length ? (
            <p role="status" className="pt-4 text-sm">
              {state.unsure.length} scans not confirmed yet. Keep this page open.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
