import { useState } from 'react';
import type { ScanZone } from '@/shared/contracts/scan-access.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { zoneOptions } from '@/web/lib/timezones.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  FormField,
  Input,
  Select,
  toast,
} from '@/web/ui/index.ts';
import { OccupancyFields } from './occupancy-fields.tsx';
import {
  createBody,
  emptyZoneDraft,
  ROOT,
  SESSION_CLOCK,
  updateBody,
  withName,
  type ZoneDraft,
  zoneDraft,
  zoneErrors,
} from './zone-draft.ts';
import { MAX_DEPTH, zoneNodes } from './zone-tree.ts';
import { useCreateZone, useUpdateZone } from './zones-api.ts';

interface Props {
  orgId: string;
  /** Every active zone: the Inside choices and the clock a child inherits. */
  zones: readonly ScanZone[];
  /** Edit this zone; absent creates one. */
  zone?: ScanZone;
  /** Create inside this zone. */
  parentId?: string;
  onClose: () => void;
}

/** Zones a zone may sit inside: not itself or below it, and with room for what hangs under it. */
function parentOptions(zones: readonly ScanZone[], zone: ScanZone | undefined) {
  const nodes = zoneNodes(zones);
  const own = zone ? nodes.findIndex((n) => n.zone.id === zone.id) : -1;
  const self = own >= 0 ? nodes[own] : undefined;
  let height = 0;
  const blocked = new Set<string>(zone ? [zone.id] : []);
  if (self) {
    for (const n of nodes.slice(own + 1)) {
      if (n.level <= self.level) break;
      blocked.add(n.zone.id);
      height = Math.max(height, n.level - self.level);
    }
  }
  return nodes
    .filter((n) => !blocked.has(n.zone.id))
    .map((n) => ({
      value: n.zone.id,
      label: `${'– '.repeat(n.level - 1)}${n.zone.name}`,
      disabled: n.level + height > MAX_DEPTH,
    }));
}

export function ZoneDialog({ orgId, zones, zone, parentId, onClose }: Props) {
  const create = useCreateZone();
  const update = useUpdateZone(zone?.id ?? '');
  const [draft, setDraft] = useState<ZoneDraft>(() =>
    zone ? zoneDraft(zone) : emptyZoneDraft(parentId),
  );
  const [error, setError] = useState('');
  const [shown, setShown] = useState(false);
  const parent = zones.find((z) => z.id === draft.parentId);
  const root = draft.parentId === ROOT;
  // Every org has a clock, so a root always has one.
  const clock = root ? true : Boolean(parent?.effectiveTimeZone ?? parent?.timeZone);
  const errors = zoneErrors(draft, !zone, clock);
  const invalid = Object.keys(errors).length > 0;
  const dirty = zone
    ? JSON.stringify(draft) !== JSON.stringify(zoneDraft(zone))
    : !!draft.name || !!parentId;
  const busy = create.isPending || update.isPending;
  const shownErrors = shown ? errors : {};

  async function submit() {
    setShown(true);
    if (invalid) return;
    setError('');
    try {
      if (zone) await update.mutateAsync(updateBody(draft, zone));
      else await create.mutateAsync(createBody(draft, orgId));
      toast.success(zone ? 'Saved' : 'Zone created');
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open dirty={dirty} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={zone ? `Edit ${zone.name}` : parentId ? 'Add a zone inside' : 'New zone'}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} disabled={zone ? !dirty : false} onClick={() => void submit()}>
              {zone ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        {error ? (
          <Callout tone="danger" className="mb-4">
            {error}
          </Callout>
        ) : null}
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormField label="Name" required error={shownErrors.name}>
            {(p) => (
              <Input
                {...p}
                autoComplete="off"
                maxLength={40}
                placeholder="Pool"
                value={draft.name}
                onChange={(e) => setDraft(withName(draft, e.target.value))}
              />
            )}
          </FormField>
          <FormField
            label="Key"
            required={!zone}
            error={shownErrors.key}
            help={zone ? 'Cannot change.' : undefined}
          >
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                autoComplete="off"
                maxLength={40}
                readOnly={!!zone}
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value, keyEdited: true })}
              />
            )}
          </FormField>
          <FormField label="Inside">
            {(p) => (
              <Select
                {...p}
                value={draft.parentId}
                options={[{ value: ROOT, label: 'None' }, ...parentOptions(zones, zone)]}
                onValueChange={(parentId) => setDraft({ ...draft, parentId })}
              />
            )}
          </FormField>
          {root ? (
            <FormField label="Time zone">
              {(p) => (
                <Select
                  {...p}
                  value={draft.timeZone}
                  options={[
                    {
                      value: SESSION_CLOCK,
                      label: 'Organization’s clock',
                    },
                    ...zoneOptions(),
                  ]}
                  onValueChange={(timeZone) => setDraft({ ...draft, timeZone })}
                />
              )}
            </FormField>
          ) : null}
          <OccupancyFields
            draft={draft}
            set={setDraft}
            errors={shownErrors}
            inNow={zone?.inNow ?? null}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
