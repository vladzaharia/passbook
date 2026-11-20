import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import type { PinNote, ScanOutcome } from '../machine/types.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import type { Approver } from '../result/approval-parts.tsx';
import { ApprovalTray } from '../result/approval-tray.tsx';
import { DockButton } from './dock.tsx';

export interface DockApproval {
  managers: Approver[];
  code: boolean;
  approvals: 'managers' | 'desk';
  note?: PinNote | undefined;
  onApprove: (staffId: string | undefined, pin: string) => void;
}

const ids = new WeakMap<object, number>();
let issued = 0;
/** One number per outcome on screen: a different pass is a different approval. */
const idOf = (outcome: ScanOutcome): number => {
  const known = ids.get(outcome);
  if (known !== undefined) return known;
  issued += 1;
  ids.set(outcome, issued);
  return issued;
};

/**
 * A `needs_approval` hold on a handheld: Manager PIN is the primary (it opens the tray), Done
 * the way out. With nobody who may approve, the dock says to ask an admin.
 */
export function ApprovalDock(props: {
  outcome: ScanOutcome;
  approval: DockApproval;
  busy: boolean;
}) {
  // A scan that replaces the hold, from the camera or a reader, starts over: the tray closes and
  // whatever was keyed goes with it. A refused PIN keeps the same outcome.
  return <HeldApproval key={idOf(props.outcome)} {...props} />;
}

function HeldApproval({
  outcome,
  approval,
  busy,
}: {
  outcome: ScanOutcome;
  approval: DockApproval;
  busy: boolean;
}) {
  const { dispatch } = useScanMachine();
  const [open, setOpen] = useState(false);
  const nobody = !outcome.approvals || (!approval.code && approval.managers.length === 0);
  // A refused PIN brings the tray back with the tries left.
  useEffect(() => {
    if (approval.note) setOpen(true);
  }, [approval.note]);
  return (
    <>
      {nobody ? (
        <p className="scan-dock-line">{SCAN_COPY.actions.askAdmin}</p>
      ) : (
        <DockButton
          primary
          variant="filled"
          autoFocus
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <ShieldCheck aria-hidden size={20} />
          {approval.code ? SCAN_COPY.managerCode.action : SCAN_COPY.actions.managerPin}
        </DockButton>
      )}
      <DockButton
        primary={nobody}
        variant={nobody ? 'filled' : 'gray'}
        shape={nobody ? undefined : 'fixed'}
        onClick={() => dispatch({ type: 'dismiss' })}
      >
        Done
      </DockButton>
      {open && !nobody ? (
        <ApprovalTray
          action={outcome.action?.label}
          managers={approval.managers}
          code={approval.code}
          desk={approval.approvals === 'desk'}
          note={approval.note}
          busy={busy}
          onApprove={approval.onApprove}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
