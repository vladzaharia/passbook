import { useMemo, useState } from 'react';
import { ConfirmDialog } from '../../ui/alert-dialog.tsx';
import { Toaster, toast } from '../../ui/toaster.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import type { FailInfo } from '../machine/ports.ts';
import { rollCallPort } from '../roll-call/roll-call-api.ts';
import { RollCallPanel } from '../roll-call/roll-call-panel.tsx';
import { RollCallPrint } from '../roll-call/roll-call-print.tsx';
import { StartRollCallFooter } from '../roll-call/start-footer.tsx';
import { useRollCall } from '../roll-call/use-roll-call.ts';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import { insidePort } from './inside-api.ts';
import { useNow } from './inside-panel.tsx';
import { InsideSheet } from './inside-sheet.tsx';
import type { InsideRow } from './inside-types.ts';
import { useInside } from './use-inside.ts';

const COPY = ACCESS_COPY.roll;

/**
 * Who's in, mounted once for a Desk scanner that counts a place. The list lives here, so closing the
 * sheet keeps it, and the Undo toast outlives the sheet (the scanner has no other toaster). The roll
 * call lives here too: it follows the session across desks and takes over the sheet while it is open.
 */
export default function InsideHost({
  api,
  open,
  online,
  onClose,
  onOpen,
  onOpenRow,
  onFail,
}: {
  api: ScanApi;
  open: boolean;
  online: boolean;
  onClose: () => void;
  /** A roll call another desk started: show the sheet. */
  onOpen?: () => void;
  onOpenRow: (row: InsideRow) => void;
  onFail: (info: FailInfo) => void;
}) {
  const port = useMemo(() => insidePort(api), [api]);
  const inside = useInside({ api: port, active: open, online, onFail });
  const roll = useRollCall({
    port: useMemo(() => rollCallPort(api), [api]),
    enabled: true,
    online,
    by: '',
    onAppear: onOpen,
  });
  const [confirm, setConfirm] = useState<'start' | 'end' | null>(null);
  const [printing, setPrinting] = useState(false);
  const now = useNow(open && roll.call !== null);
  const place = inside.state.places.map((p) => p.name).join(', ');
  return (
    <>
      <Toaster />
      <InsideSheet
        open={open}
        onClose={onClose}
        inside={inside}
        online={online}
        onOpenRow={onOpenRow}
        body={
          roll.call ? (
            <RollCallPanel
              roll={roll}
              online={online}
              now={now}
              onEnd={() => setConfirm('end')}
              onPrint={() => setPrinting(true)}
            />
          ) : undefined
        }
        footer={
          <StartRollCallFooter
            disabled={!online || roll.busy}
            onStart={() => setConfirm('start')}
          />
        }
      />
      <ConfirmDialog
        open={confirm === 'start'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={COPY.startConfirmTitle}
        description={fill(COPY.startConfirm, { place: place || ACCESS_COPY.inside.title })}
        confirmLabel={COPY.start}
        destructive
        onConfirm={async () => {
          await roll.start();
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'end'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={COPY.endConfirmTitle}
        description={
          roll.call && roll.call.counts.unconfirmed > 0
            ? fill(COPY.endConfirm, { n: roll.call.counts.unconfirmed })
            : COPY.endConfirmNone
        }
        confirmLabel={COPY.end}
        onConfirm={async () => {
          if (await roll.end()) toast.info(COPY.saved);
          setConfirm(null);
        }}
      />
      {printing && roll.call ? (
        <RollCallPrint call={roll.call} onDone={() => setPrinting(false)} />
      ) : null}
    </>
  );
}
