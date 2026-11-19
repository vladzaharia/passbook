import { LogIn, UserRound } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { toast } from '../../ui/toaster.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { StaffStart } from '../boot/staff-start.tsx';
import { scanId } from '../platform/id.ts';
import { ApprovalSheet } from '../result/approval-sheet.tsx';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';

/** Desk actions are on and a person is signed in by PIN: the only time the monitor acts (SA 20.9). */
export function deskActing(session: ScanSession): boolean {
  return Boolean(session.scanner?.settings.deskActions && session.staff);
}

/** Who is signed in on the monitor, with Switch staff; or Sign in to act. Only with Desk actions on. */
export function StaffControl({
  session,
  api,
  refetch,
}: {
  session: ScanSession;
  api: ScanApi;
  refetch: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const staff = session.staff;
  if (!session.scanner?.settings.deskActions || !session.scanner.settings.staffSignIn) return null;
  const switchStaff = async () => {
    await api.staffSignOut();
    await refetch();
    setOpen(true);
  };
  return (
    <>
      {staff ? (
        <>
          <span className="scan-live-staff" data-testid="monitor-staff">
            <UserRound aria-hidden size={18} /> {staff.name}
          </span>
          <Button variant="outline" onClick={() => void switchStaff()}>
            Switch staff
          </Button>
        </>
      ) : (
        <Button onClick={() => setOpen(true)}>{SCAN_COPY.actions.signInToAct}</Button>
      )}
      <Sheet open={open && !staff} onOpenChange={setOpen}>
        <SheetContent title="Staff sign-in" hideTitle>
          <StaffStart
            session={session}
            api={api}
            refetch={async () => {
              await refetch();
              setOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Let in from a feed row: one tap, the scan the server named. The server decides who may and
 * whether it is still in time; a Manager-only reason asks for a Manager PIN.
 */
export function useLetIn(api: ScanApi, onDone: (row: ScanLiveRow) => void) {
  const [asking, setAsking] = useState<ScanLiveRow | null>(null);
  const [wrongPin, setWrongPin] = useState(false);
  const send = useCallback(
    async (row: ScanLiveRow, pin?: string) => {
      if (!row.scanId) return;
      try {
        const out = await api.override({
          idempotencyKey: scanId(),
          overrideOf: row.scanId,
          ...(pin ? { approval: { pin } } : {}),
        });
        if (out.kind === 'ok') {
          setAsking(null);
          setWrongPin(false);
          onDone(row);
          const undoId = out.scanId;
          const name = row.holder ?? 'Guest';
          if (undoId)
            toast.undo(fill(ACCESS_COPY.inside.letInDone, { name }), () =>
              api.undo(undoId, { idempotencyKey: scanId() }),
            );
        } else if (out.overridable && out.approvals) {
          setWrongPin(pin !== undefined);
          setAsking(row);
        } else toast.info(SCAN_COPY.actions.askAdmin);
      } catch (error) {
        setAsking(null);
        toast.error(error, 'Could not let in');
      }
    },
    [api, onDone],
  );
  const sheet = (
    <Sheet open={asking !== null} onOpenChange={(next) => !next && setAsking(null)}>
      <SheetContent title={SCAN_COPY.actions.managerPin} hideTitle>
        <ApprovalSheet
          managers={[]}
          code
          desk={false}
          action={SCAN_COPY.actions.letIn}
          note={wrongPin ? { triesLeft: 2 } : undefined}
          onApprove={(_id, pin) => asking && void send(asking, pin)}
          onCancel={() => setAsking(null)}
        />
      </SheetContent>
    </Sheet>
  );
  return { letIn: (row: ScanLiveRow) => void send(row), sheet };
}

export function LetInButton({ row, onLetIn }: { row: ScanLiveRow; onLetIn: () => void }) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="mon-letin"
      iconStart={<LogIn aria-hidden />}
      aria-label={`${SCAN_COPY.actions.letIn}: ${row.holder ?? row.label}`}
      onClick={onLetIn}
    >
      {SCAN_COPY.actions.letIn}
    </Button>
  );
}
