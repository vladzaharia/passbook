import { useState } from 'react';
import { ConfirmDialog } from '../../../ui/alert-dialog.tsx';
import { toast } from '../../../ui/toaster.tsx';
import { RollCallPrint } from '../../roll-call/roll-call-print.tsx';
import type { RollCallState, UnsavedMark } from '../../roll-call/use-roll-call.ts';
import { fill } from '../../ui/copy.ts';
import { ACCESS_COPY } from '../../ui/copy-access.ts';

const R = ACCESS_COPY.roll;

/** The call ended under the taps, or the server kept refusing them: either way they are shown, not dropped. */
function unsavedTitle(unsaved: readonly UnsavedMark[]): string {
  const ended = unsaved.every((u) => !u.reason);
  const n = unsaved.length;
  if (ended) return n === 1 ? R.endedLostOne : fill(R.endedLost, { n });
  return n === 1 ? R.notSavedOne : fill(R.notSaved, { n });
}

/** Start, end, print and the taps that were not saved: the roll call's dialogs, whichever view asks for them. */
export function useRollControls() {
  const [confirm, setConfirm] = useState<'start' | 'end' | null>(null);
  const [printing, setPrinting] = useState(false);
  return { confirm, setConfirm, printing, setPrinting };
}
export type RollControls = ReturnType<typeof useRollControls>;

export function RollCallDialogs({
  roll,
  controls,
  place,
}: {
  roll: RollCallState;
  controls: RollControls;
  place: string;
}) {
  const { confirm, setConfirm, printing, setPrinting } = controls;
  return (
    <>
      <ConfirmDialog
        open={confirm === 'start'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={R.startConfirmTitle}
        description={fill(R.startConfirm, { place: place || ACCESS_COPY.inside.title })}
        confirmLabel={R.start}
        destructive
        onConfirm={async () => {
          await roll.start();
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'end'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={R.endConfirmTitle}
        description={
          roll.call && roll.call.counts.unconfirmed > 0
            ? fill(R.endConfirm, { n: roll.call.counts.unconfirmed })
            : undefined
        }
        confirmLabel={R.end}
        onConfirm={async () => {
          if (await roll.end()) toast.info(R.saved);
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
                {u.name ?? ACCESS_COPY.inside.unnamed}: {u.status === 'out' ? R.out : R.safe}
                {u.reason
                  ? ` (${(R.refused as Record<string, string>)[u.reason] ?? R.refused.other})`
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
