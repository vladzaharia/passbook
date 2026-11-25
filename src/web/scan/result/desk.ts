import { useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { localOutcome } from '../machine/outcome.ts';
import type { Counts, ScanEvent, ScanOutcome, ScanState } from '../machine/types.ts';
import { shortName } from './approval-parts.tsx';

/** What the result card's desk regions need from the machine: the open picker and the PIN's managers. */
export function deskOf(
  loop: ScanState['loop'],
  session: Pick<ScanSession, 'staffList' | 'staff'> & {
    scanner?: { settings: { approvals?: 'managers' | 'desk' | undefined } } | null;
  },
  dispatch: (event: ScanEvent) => void,
) {
  const { staffList } = session;
  const approvals = session.scanner?.settings.approvals;
  const selfId = session.staff?.id;
  return {
    picker: loop.s === 'member' ? loop.picker : null,
    onAmount: (value: number | null) => dispatch({ type: 'amount', value }),
    onValue: (value: unknown) => dispatch({ type: 'value', value }),
    onConfirm: () => dispatch({ type: 'confirm' }),
    onCancel: () => dispatch({ type: 'cancel' }),
    note: loop.s === 'verdict' ? loop.pin : undefined,
    code: staffList === null,
    approvals: approvals ?? 'managers',
    // Whoever may approve here, never the signed-in person asking.
    managers: (staffList ?? []).filter(
      (m) =>
        m.id !== selfId && (m.role === 'manager' || (approvals === 'desk' && m.role === 'desk')),
    ),
    onApprove: (staffId: string | undefined, pin: string) =>
      dispatch({ type: 'approve', ...(staffId ? { staffId } : {}), pin }),
  };
}

/** What the result card shows for the loop: a verdict, or the desk's open member as a `ready` outcome. */
export function resultOf(loop: ScanState['loop'], counts: Counts): ScanOutcome | null {
  if (loop.s === 'verdict') return loop.outcome;
  if (loop.s !== 'member') return null;
  return {
    ...localOutcome('system', 'server', counts),
    kind: 'ready',
    reason: 'choose',
    card: loop.card,
    display: loop.card.display,
    local: false,
  };
}

/**
 * Who approved the hold on screen, for the green card's "Approved by Maya R." (a manager code is
 * anonymous, so it names nobody). The name is remembered against the read it approved.
 */
export function useApprovedBy(loop: ScanState['loop'], desk: ReturnType<typeof deskOf>) {
  const [approver, setApprover] = useState<{ inputId: string; name: string } | null>(null);
  const withName = {
    ...desk,
    onApprove: (staffId: string | undefined, pin: string) => {
      const who = desk.managers.find((m) => m.id === staffId);
      if (who && 'input' in loop)
        setApprover({ inputId: loop.input.id, name: shortName(who.name) });
      desk.onApprove(staffId, pin);
    },
  };
  const approvedBy =
    approver &&
    loop.s === 'verdict' &&
    loop.outcome.kind === 'ok' &&
    loop.input.id === approver.inputId
      ? approver.name
      : undefined;
  return { desk: withName, approvedBy };
}
