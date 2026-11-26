import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { admitsOf, admitsWire, type ScanEventDto } from '@/shared/contracts/scanners.ts';
import { ScanningSessionDetailSchema } from '@/shared/contracts/scanning-sessions.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Callout, CheckboxField, FormDialog } from '@/web/ui/index.ts';
import { useScanningSessions } from '../sessions/api.ts';

/** Sessions that admit this event: tick one to add it, untick to take it off. */
export function AddToSessionDialog({
  event,
  onClose,
}: {
  event: ScanEventDto;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const sessions = useScanningSessions(event.orgId);
  const items = (sessions.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (s) => s.orgId === event.orgId && s.mode === event.mode && s.status !== 'ended',
  );
  const has = (s: (typeof items)[number]) =>
    s.accepts === null || admitsOf(s.accepts).eventIds.includes(event.id);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const on = (s: (typeof items)[number]) => picked[s.id] ?? has(s);
  const changed = items.filter((s) => s.accepts !== null && on(s) !== has(s));
  const save = useMutation({
    mutationFn: async () => {
      for (const s of changed) {
        const admits = s.accepts ? admitsOf(s.accepts) : { templateIds: [], eventIds: [] };
        const eventIds = on(s)
          ? [...admits.eventIds, event.id]
          : admits.eventIds.filter((id) => id !== event.id);
        await api.patch(`/api/v1/scanning-sessions/${s.id}`, ScanningSessionDetailSchema, {
          accepts: admitsWire({ templateIds: admits.templateIds, eventIds }),
          revision: s.updatedAt,
        });
      }
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'scanning'] });
      onClose();
    },
  });
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Add to a session"
      size="sm"
      dirty={changed.length > 0}
      submitLabel="Save"
      busy={save.isPending}
      onSubmit={() => (changed.length ? save.mutateAsync() : onClose())}
    >
      {items.map((s) => (
        <CheckboxField
          key={s.id}
          label={s.accepts === null ? `${s.name} (any pass type)` : s.name}
          checked={on(s)}
          disabled={s.accepts === null}
          onCheckedChange={(checked) => setPicked((p) => ({ ...p, [s.id]: checked === true }))}
        />
      ))}
      {!items.length && !sessions.isPending ? <p className="text-sm">No sessions yet.</p> : null}
      {sessions.isError ? <Callout tone="danger">{errorMessage(sessions.error)}</Callout> : null}
    </FormDialog>
  );
}
