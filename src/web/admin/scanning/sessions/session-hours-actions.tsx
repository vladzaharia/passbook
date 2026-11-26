import { DoorClosed, DoorOpen, Undo2 } from 'lucide-react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { whenIn } from '@/shared/session-window.ts';
import { Button, ConfirmDialog, DropdownMenuItem, toast } from '@/web/ui/index.ts';
import { useHoldSession } from './api.ts';
import { OpenNowDialog } from './session-hold-dialog.tsx';

export type HoursDialog = 'hold-open' | 'hold-close';

/** Hold actions exist for an active session that keeps hours: otherwise Pause is the switch. */
const holdable = (s: ScanningSession) => s.status === 'active' && Boolean(s.hours) && !!s.window;

function useBackToHours(s: ScanningSession) {
  const hold = useHoldSession(s.id);
  return {
    pending: hold.isPending,
    run: () =>
      hold
        .mutateAsync({ action: 'clear', revision: s.updatedAt })
        .catch((error: unknown) => toast.error(error, 'Could not change session')),
  };
}

export function HoursMenuItems({
  session: s,
  onDialog,
}: {
  session: ScanningSession;
  onDialog: (dialog: HoursDialog) => void;
}) {
  const back = useBackToHours(s);
  if (!holdable(s) || !s.window) return null;
  return (
    <>
      {s.window.open ? (
        <DropdownMenuItem onSelect={() => onDialog('hold-close')}>
          <DoorClosed aria-hidden />
          Close now
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => onDialog('hold-open')}>
          <DoorOpen aria-hidden />
          Open now…
        </DropdownMenuItem>
      )}
      {s.hold ? (
        <DropdownMenuItem disabled={back.pending} onSelect={() => void back.run()}>
          <Undo2 aria-hidden />
          Back to hours
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/** Says why the door is shut or held open, with the way out. Nothing while hours run as set. */
export function HoursBanner({
  session: s,
  canManage,
  onDialog,
}: {
  session: ScanningSession;
  canManage: boolean;
  onDialog: (dialog: HoursDialog) => void;
}) {
  const back = useBackToHours(s);
  const w = s.window;
  if (!holdable(s) || !w) return null;
  if (w.open && w.by !== 'hold') return null;
  const at = (t: number) => whenIn(t, s.timeZone, Date.now());
  const text = w.open
    ? `Held open until ${w.closesAt ? at(w.closesAt) : 'further notice'}. Then the hours resume.`
    : w.by === 'hold'
      ? `Closed by hand${w.opensAt ? ` until ${at(w.opensAt)}` : ''}. Then the hours resume.`
      : null;
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken p-4">
      {text ? <p className="text-sm">{text}</p> : null}
      {canManage ? (
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {w.open ? (
            <Button variant="outline" onClick={() => onDialog('hold-close')}>
              Close now
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onDialog('hold-open')}>
              Open now…
            </Button>
          )}
          {s.hold ? (
            <Button variant="outline" loading={back.pending} onClick={() => void back.run()}>
              Back to hours
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function HoursDialogs({
  session: s,
  dialog,
  onClose,
}: {
  session: ScanningSession;
  dialog: HoursDialog | undefined;
  onClose: () => void;
}) {
  const hold = useHoldSession(s.id);
  if (dialog === 'hold-open') return <OpenNowDialog session={s} onClose={onClose} />;
  if (dialog !== 'hold-close') return null;
  const next = s.window?.opensAt;
  return (
    <ConfirmDialog
      open
      title="Close now?"
      description={`Scanning stops on every device${
        next ? ` until ${whenIn(next, s.timeZone, Date.now())}` : ''
      }. Back to hours lifts it.`}
      confirmLabel="Close now"
      onOpenChange={(open) => !open && onClose()}
      onConfirm={async () => {
        await hold.mutateAsync({ action: 'close', revision: s.updatedAt });
      }}
    />
  );
}
