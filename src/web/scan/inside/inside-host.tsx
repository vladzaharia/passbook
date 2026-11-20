import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '../../ui/alert-dialog.tsx';
import { Toaster, toast } from '../../ui/toaster.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { toFail } from '../api/to-fail.ts';
import type { FailInfo } from '../machine/ports.ts';
import type { KeyValue } from '../offline/wipe.ts';
import { rollCallPort } from '../roll-call/roll-call-api.ts';
import type { QueuedMark } from '../roll-call/roll-call-model.ts';
import { RollCallPanel } from '../roll-call/roll-call-panel.tsx';
import { RollCallPrint } from '../roll-call/roll-call-print.tsx';
import { StartRollCallFooter } from '../roll-call/start-footer.tsx';
import { type UnsavedMark, useRollCall } from '../roll-call/use-roll-call.ts';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import { insidePort } from './inside-api.ts';
import { useNow } from './inside-panel.tsx';
import { InsideSheet } from './inside-sheet.tsx';
import type { InsidePlace, InsideRow } from './inside-types.ts';
import { useInside } from './use-inside.ts';

const COPY = ACCESS_COPY.roll;

/** The call ended under the taps, or the server kept refusing them: either way they are shown, not dropped. */
function unsavedTitle(unsaved: readonly UnsavedMark[]): string {
  const ended = unsaved.every((u) => !u.reason);
  const n = unsaved.length;
  if (ended) return n === 1 ? COPY.endedLostOne : fill(COPY.endedLost, { n });
  return n === 1 ? COPY.notSavedOne : fill(COPY.notSaved, { n });
}

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
  onPlaces,
  store,
}: {
  api: ScanApi;
  open: boolean;
  online: boolean;
  onClose: () => void;
  /** A roll call another desk started: show the sheet. */
  onOpen?: () => void;
  onOpenRow: (row: InsideRow) => void;
  onFail: (info: FailInfo) => void;
  /** The counts the list last read, so the scanner's own chip follows a mark-out. */
  onPlaces?: (places: InsidePlace[]) => void;
  /** Unsent roll call taps survive a reload here. */
  store?: KeyValue<QueuedMark[]>;
}) {
  const port = useMemo(() => insidePort(api), [api]);
  const inside = useInside({ api: port, active: open, online, onFail });
  const { places } = inside.state;
  useEffect(() => {
    if (places.length) onPlaces?.(places);
  }, [places, onPlaces]);
  const roll = useRollCall({
    port: useMemo(() => rollCallPort(api), [api]),
    enabled: true,
    online,
    by: '',
    onAppear: onOpen,
    onRefused: (items) => {
      const people = new Map(roll.call?.people.map((p) => [p.passId, p.holder]) ?? []);
      const reasons = COPY.refused as Record<string, string>;
      for (const { passId, code } of items.slice(0, 3))
        toast.info(
          `${people.get(passId) ?? ACCESS_COPY.inside.unnamed}: ${reasons[code] ?? COPY.refused.other}`,
        );
    },
    onBlocked: (error) => onFail(toFail(error)),
    ...(store ? { store } : {}),
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
      <ConfirmDialog
        open={roll.unsaved.length > 0}
        onOpenChange={(next) => !next && roll.clearUnsaved()}
        title={unsavedTitle(roll.unsaved)}
        description={
          <ul>
            {roll.unsaved.map((u) => (
              <li key={`${u.passId}-${u.status}`}>
                {u.name ?? ACCESS_COPY.inside.unnamed}: {u.status === 'out' ? COPY.out : COPY.safe}
                {u.reason
                  ? ` (${(COPY.refused as Record<string, string>)[u.reason] ?? COPY.refused.other})`
                  : ''}
              </li>
            ))}
          </ul>
        }
        hideConfirm
        cancelLabel="Close"
        onConfirm={() => roll.clearUnsaved()}
      />
      {printing && roll.call ? (
        <RollCallPrint call={roll.call} onDone={() => setPrinting(false)} />
      ) : null}
    </>
  );
}
