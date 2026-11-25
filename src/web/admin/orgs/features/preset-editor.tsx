import { useState } from 'react';
import type { EntitlementPresetDto } from '@/shared/contracts/entitlement-presets.ts';
import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import { type EntitlementValues, entitlementImpact } from '@/shared/entitlement-impact.ts';
import { editPresetConfirm } from '@/web/lib/confirms-features.ts';
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogContent,
  ErrorState,
  FormField,
  Select,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import { usePresets, useSetPreset } from './preset-queries.ts';
import { draftOf, type ValueDraft, ValueField, valueFromDraft } from './value-field.tsx';
import { FEATURE_GROUPS, formatValue } from './values.ts';

const KEYS = FEATURE_GROUPS.flatMap((g) => g.keys);

/** Platform: changes a preset's values for every organization on it. */
/** `current` is the preset the page's organization is on: the one that opens. */
export function PresetEditor({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit presets
      </Button>
      {open ? <PresetDialog current={current} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PresetDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const query = usePresets();
  const [picked, setPicked] = useState(current);
  const presets = query.data?.presets ?? [];
  const preset = presets.find((p) => p.preset === picked) ?? presets[0];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="md"
        title="Edit presets"
        footer={
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        }
      >
        {query.isPending ? (
          <SkeletonRows label="Loading presets" />
        ) : !preset ? (
          <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <div className="flex flex-col gap-4">
            <FormField label="Preset">
              {(p) => (
                <Select
                  id={p.id}
                  value={preset.preset}
                  onValueChange={setPicked}
                  options={presets.map((x) => ({ value: x.preset, label: x.label }))}
                />
              )}
            </FormField>
            {preset.pendingOrgs > 0 ? (
              <Resume preset={preset} />
            ) : (
              <Change key={`${preset.preset}:${preset.revision}`} preset={preset} />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const orgs = (n: number) => `${n} ${n === 1 ? 'organization' : 'organizations'}`;

/** An earlier change has not reached every organization: the same call with no values carries on. */
function Resume({ preset }: { preset: EntitlementPresetDto }) {
  const save = useSetPreset();
  return (
    <Callout
      tone="warning"
      title={`${orgs(preset.pendingOrgs)} not moved yet`}
      actions={
        <Button
          size="sm"
          loading={save.isPending}
          onClick={async () => {
            const out = await save.mutateAsync({
              preset: preset.preset,
              expectedRevision: preset.revision,
              values: {},
            });
            toast.success(`${orgs(out.moved)} moved`);
          }}
        >
          Move the rest
        </Button>
      }
    >
      Change {preset.label} again once they have.
    </Callout>
  );
}

function Change({ preset }: { preset: EntitlementPresetDto }) {
  const save = useSetPreset();
  const [key, setKey] = useState<EntitlementKey>(KEYS[0] ?? 'api');
  const [draft, setDraft] = useState<ValueDraft>(() => draftOf(key, preset.values[key] ?? 0));
  const [confirming, setConfirming] = useState(false);
  const parsed = valueFromDraft(key, draft);
  const before = preset.values as EntitlementValues;
  const impact =
    'value' in parsed ? entitlementImpact(before, { ...before, [key]: parsed.value }) : undefined;
  return (
    <div className="flex flex-col gap-4">
      <FormField label="Feature">
        {(p) => (
          <Select
            id={p.id}
            value={key}
            onValueChange={(next) => {
              const k = next as EntitlementKey;
              setKey(k);
              setDraft(draftOf(k, preset.values[k] ?? 0));
            }}
            options={KEYS.map((k) => ({
              value: k,
              label: `${ENTITLEMENT_LABEL[k]}: ${formatValue(k, before[k])}`,
            }))}
          />
        )}
      </FormField>
      <ValueField
        featureKey={key}
        draft={draft}
        onChange={setDraft}
        error={'error' in parsed ? parsed.error : undefined}
      />
      <div>
        <Button
          disabled={!impact || impact.changes.length === 0}
          onClick={() => setConfirming(true)}
        >
          Continue
        </Button>
      </div>
      {impact && 'value' in parsed ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          {...editPresetConfirm(preset.label, preset.orgCount, impact)}
          onConfirm={async () => {
            const out = await save.mutateAsync({
              preset: preset.preset,
              expectedRevision: preset.revision,
              values: { [key]: parsed.value },
            });
            toast.success(
              out.preset.pendingOrgs > 0
                ? `${orgs(out.moved)} moved, ${out.preset.pendingOrgs} to go`
                : `${preset.label} changed`,
            );
          }}
        />
      ) : null}
    </div>
  );
}
