import { z } from 'zod';
import { ScanStaffSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { formatCount } from '@/web/lib/format.ts';
import { ConfirmDialog, StatusPill } from '@/web/ui/index.ts';
import type { ScanStaff } from './staff-dialogs.tsx';

/** The PIN column: the five-try lock, the daily lock, a PIN to be replaced, or just Set. */
export function StaffPinCell({ person }: { person: ScanStaff }) {
  if (person.locked)
    return (
      <StatusPill status="pin_locked" tone="warning">
        Locked on a scanner
      </StatusPill>
    );
  if (person.pinLockedToday)
    return (
      <StatusPill status="pin_locked_today" tone="warning">
        Locked today
      </StatusPill>
    );
  if (person.pinResetRequired)
    return (
      <StatusPill status="pin_reset" tone="warning">
        Needs new PIN
      </StatusPill>
    );
  return <span className="text-fg-muted">Set</span>;
}

/** "Successful today": the number, with the long reading for screen readers. */
export function StaffTodayCell({ person }: { person: ScanStaff }) {
  return (
    <span className="tabular-nums">
      <span aria-hidden>{formatCount(person.today)}</span>
      <span className="sr-only">
        {formatCount(person.today)} successful, not-undone {person.today === 1 ? 'scan' : 'scans'}{' '}
        since each scanner&apos;s local midnight for {person.name}; removed scanners use UTC
      </span>
    </span>
  );
}

export type PinToolDialog = { type: 'unlock'; staff: ScanStaff } | { type: 'untagged' };

/** The two confirms that are not a PIN reveal: lift a daily lock, and ask old PINs to be replaced. */
export function StaffPinToolDialog({
  orgId,
  dialog,
  onClose,
  onDone,
}: {
  orgId: string;
  dialog: PinToolDialog;
  onClose: () => void;
  onDone: () => void;
}) {
  const unlock = dialog.type === 'unlock';
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={unlock ? `Unlock ${dialog.staff.name}'s PIN?` : 'Reset untagged PINs?'}
      description={
        unlock
          ? 'Their wrong PINs today stop counting. They can sign in by name again.'
          : 'Door and Desk staff who have not signed in since PIN tags came are asked for a new PIN at their next sign-in by name. Managers are reset one by one.'
      }
      confirmLabel={unlock ? 'Unlock' : 'Reset PINs'}
      onConfirm={async () => {
        await api.post(
          unlock
            ? `/api/v1/scan-staff/${dialog.staff.id}/unlock-pin`
            : '/api/v1/scan-staff/reset-untagged',
          unlock ? ScanStaffSchema : z.object({ flagged: z.number() }),
          undefined,
          { query: { orgId } },
        );
        onDone();
      }}
    />
  );
}
