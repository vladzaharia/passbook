import { DoorClosed, DoorOpen, Pencil, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { formatCalendarDate, todayKey } from '@/web/lib/format.ts';
import { Button, toast } from '@/web/ui/index.ts';
import { useHoldSession } from './api.ts';
import { hoursSummary } from './session-hours.ts';
import type { HoursDialog } from './session-hours-actions.tsx';
import { SessionHoursFields } from './session-hours-fields.tsx';
import { RowEditor, SetupRow } from './setup-row.tsx';
import { useSectionEdit } from './use-section-edit.ts';

/** The upcoming closed dates: a date with no spans is closed all day. */
export const closedDates = (s: ScanningSession): string[] =>
  Object.entries(s.hours?.dates ?? {})
    .filter(([key, spans]) => spans.length === 0 && key >= todayKey(s.timeZone))
    .map(([key]) => key)
    .sort();

/** When: the hours in a sentence, Close now and Open now, and the closed dates. */
export function WhenRow({
  session: s,
  canManage,
  onDialog,
}: {
  session: ScanningSession;
  canManage: boolean;
  onDialog: (dialog: HoursDialog) => void;
}) {
  const [editing, setEditing] = useState(false);
  const edit = useSectionEdit(s, () => setEditing(false));
  const hold = useHoldSession(s.id);
  const lines = hoursSummary(s.hours);
  const closed = closedDates(s);
  const holdable = s.status === 'active' && Boolean(s.hours) && Boolean(s.window);
  const open = s.window?.open ?? true;
  const back = () =>
    hold
      .mutateAsync({ action: 'clear', revision: s.updatedAt })
      .catch((e: unknown) => toast.error(e, 'Could not change session'));
  const actions =
    canManage && !editing ? (
      <>
        {holdable ? (
          open ? (
            <Button
              variant="ghost"
              size="sm"
              iconStart={<DoorClosed aria-hidden />}
              onClick={() => onDialog('hold-close')}
            >
              Close now
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              iconStart={<DoorOpen aria-hidden />}
              onClick={() => onDialog('hold-open')}
            >
              Open now
            </Button>
          )
        ) : null}
        {holdable && s.hold ? (
          <Button
            variant="ghost"
            size="sm"
            iconStart={<Undo2 aria-hidden />}
            loading={hold.isPending}
            onClick={() => void back()}
          >
            Back to hours
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          iconStart={<Pencil aria-hidden />}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
      </>
    ) : undefined;
  return (
    <SetupRow label="When" actions={actions}>
      {editing ? (
        <RowEditor
          onSave={() => void edit.save()}
          onCancel={() => setEditing(false)}
          saving={edit.saving}
          disabled={!edit.ready}
          error={edit.error}
        >
          <SessionHoursFields draft={edit.draft} set={edit.set} />
        </RowEditor>
      ) : (
        <div className="grid gap-0.5 text-sm">
          <span className="font-medium text-fg-strong">
            {lines.length ? lines.join(', ') : s.hoursInvalid ? 'Closed' : 'Always open'}
          </span>
          {closed.length ? (
            <span className="text-fg-muted">
              Closed {closed.map(formatCalendarDate).join(', ')}
            </span>
          ) : null}
        </div>
      )}
    </SetupRow>
  );
}
