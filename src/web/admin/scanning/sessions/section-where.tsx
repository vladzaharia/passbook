import { Pencil } from 'lucide-react';
import { useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { Badge, Button, ProgressBar, SwitchRow } from '@/web/ui/index.ts';
import { ZonePicker } from '../zones/zone-picker.tsx';
import { eventsOnly, sessionDraft } from './draft.ts';
import type { useSessionLive } from './session-live.ts';
import { RowEditor, SetupRow } from './setup-row.tsx';
import { useSectionEdit } from './use-section-edit.ts';

type Live = ReturnType<typeof useSessionLive>;

/** Where: the zone, how many are inside against its max, and whether the session tracks in and out. */
export function WhereRow({
  session: s,
  live,
  canManage,
}: {
  session: ScanningSession;
  live: Live;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const edit = useSectionEdit(s, () => setEditing(false));
  const zone = (live.zones.data ?? []).find((z) => s.zoneIds?.includes(z.id));
  const tracks = s.settings.checkIn?.mode === 'in_out';
  const event = eventsOnly(sessionDraft(s));
  const { draft } = edit;
  return (
    <SetupRow
      label="Where"
      actions={
        canManage && !editing && !event ? (
          <Button
            variant="ghost"
            size="sm"
            iconStart={<Pencil aria-hidden />}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <RowEditor
          onSave={() => void edit.save()}
          onCancel={() => setEditing(false)}
          saving={edit.saving}
          disabled={!edit.ready}
          error={edit.error}
        >
          <ZonePicker
            orgId={s.orgId}
            label="Zones"
            value={draft.zoneIds ?? []}
            onChange={(zoneIds) => edit.set({ zoneIds })}
          />
          <SwitchRow
            label="Track in and out"
            checked={draft.checkIn.mode === 'in_out'}
            onCheckedChange={(on) => {
              const { mode: _mode, ...rest } = draft.checkIn;
              edit.set({ checkIn: on ? { ...rest, mode: 'in_out' } : rest });
            }}
          />
        </RowEditor>
      ) : event ? (
        <span className="text-sm text-fg-muted">Events check in once</span>
      ) : zone ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg-strong">{zone.name}</span>
            {tracks ? <Badge>In and out</Badge> : null}
          </div>
          {zone.occupancy !== 'off' && zone.inNow !== null && zone.capacity ? (
            <div className="grid max-w-sm gap-1">
              <ProgressBar
                label={`Inside ${zone.name}`}
                value={zone.inNow}
                max={zone.capacity}
                tone={zone.inNow >= zone.capacity ? 'danger' : 'accent'}
              />
              <span className="text-xs tabular-nums text-fg-muted">
                {zone.inNow} of {zone.capacity} inside
              </span>
            </div>
          ) : zone.inNow !== null ? (
            <span className="text-xs tabular-nums text-fg-muted">{zone.inNow} inside</span>
          ) : null}
        </div>
      ) : (
        <span className="text-sm text-fg-muted">{tracks ? 'In and out, no zone' : 'No zone'}</span>
      )}
    </SetupRow>
  );
}
