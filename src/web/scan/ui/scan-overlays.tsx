import { lazy, Suspense } from 'react';
import { Dialog, DialogContent } from '../../ui/dialog.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import type { Action, PassInspection } from '../result/pass-inspector.tsx';
import { READER_TIPS } from './scan-menu.tsx';

const LookupSheet = lazy(() =>
  import('../lookup/lookup-sheet.tsx').then((m) => ({ default: m.LookupSheet })),
);
const PassInspector = lazy(() =>
  import('../result/pass-inspector.tsx').then((m) => ({ default: m.PassInspector })),
);
const ShiftSheet = lazy(() => import('./shift-sheet.tsx').then((m) => ({ default: m.ShiftSheet })));
export type ScanPanel = 'shift' | 'end' | 'tips' | null;
export function ScanOverlays({
  sheet,
  panel,
  pass,
  api,
  runtime,
  open,
  showPanel,
  closePass,
  shiftStart,
  cameraError,
  clearError,
  orgId,
  timeZone,
  where,
  eventNote,
  extraActions,
  allowPeople,
  sessionTotals,
}: {
  sheet: boolean;
  panel: ScanPanel;
  pass: PassInspection | null;
  api: ScanApi;
  runtime: ScanRuntime;
  open: (sheet: boolean) => void;
  showPanel: (panel: ScanPanel) => void;
  closePass: () => void;
  shiftStart: number;
  cameraError: string;
  clearError: () => void;
  orgId?: string;
  timeZone?: string;
  where?: string;
  eventNote?: string | null | undefined;
  extraActions?: Action[];
  allowPeople: boolean;
  sessionTotals: boolean;
}) {
  const { state } = useScanMachine();
  return (
    <>
      <Suspense fallback={null}>
        {sheet ? (
          <LookupSheet
            orgId={orgId}
            timeZone={timeZone}
            open={sheet}
            allowPeople={allowPeople}
            api={api}
            onClose={() => open(false)}
            onCheckIn={(card, actionId) => {
              open(false);
              runtime.checkIn(card, actionId);
            }}
            onCode={(code) => {
              open(false);
              runtime.emit({ method: 'manual', code });
            }}
          />
        ) : null}
        {pass ? (
          <PassInspector
            api={api}
            orgId={orgId}
            timeZone={timeZone}
            where={where ?? ''}
            eventNote={eventNote}
            {...(extraActions ? { extraActions } : {})}
            inspection={pass}
            onClose={closePass}
          />
        ) : null}
        {panel === 'shift' || panel === 'end' ? (
          <ShiftSheet
            open
            ending={panel === 'end'}
            api={api}
            since={shiftStart}
            sessionTotals={sessionTotals}
            pending={state.unsure.length + state.queue.pending}
            offline={{ state: state.offline, queue: state.queue, onSync: runtime.syncNow }}
            onClose={() => showPanel(null)}
            onEnd={() => location.reload()}
          />
        ) : null}
      </Suspense>
      <Dialog
        open={panel === 'tips' || Boolean(cameraError)}
        onOpenChange={(value) => {
          if (!value) {
            showPanel(null);
            clearError();
          }
        }}
      >
        <DialogContent title={cameraError ? 'Camera' : 'Reader tips'} size="sm">
          {cameraError ? (
            <p>{cameraError}</p>
          ) : (
            <ol className="list-decimal space-y-3 pl-5">
              {READER_TIPS.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
