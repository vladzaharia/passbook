import { useState } from 'react';
import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import { type EntitlementValues, entitlementImpact } from '@/shared/entitlement-impact.ts';
import { editPresetConfirm } from '@/web/lib/confirms-features.ts';
import { UserMessageError } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  ConfirmDialog,
  ErrorState,
  FormDialog,
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

const orgs = (n: number) => `${n} ${n === 1 ? 'organization' : 'organizations'}`;

interface Edit {
  /** The preset and revision the draft was made for: another one starts a new draft. */
  id: string;
  key: EntitlementKey;
  draft: ValueDraft;
}

function PresetDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const query = usePresets();
  const save = useSetPreset();
  const [picked, setPicked] = useState(current);
  const [confirming, setConfirming] = useState(false);
  const [made, setMade] = useState<Edit>();
  const presets = query.data?.presets ?? [];
  const preset = presets.find((p) => p.preset === picked) ?? presets[0];
  const id = preset ? `${preset.preset}:${preset.revision}` : '';
  const first = KEYS[0] ?? 'api';
  const edit: Edit | undefined =
    made?.id === id
      ? made
      : preset && { id, key: first, draft: draftOf(first, preset.values[first] ?? 0) };
  const parsed = edit ? valueFromDraft(edit.key, edit.draft) : undefined;
  const before = (preset?.values ?? {}) as EntitlementValues;
  const impact =
    edit && parsed && 'value' in parsed
      ? entitlementImpact(before, { ...before, [edit.key]: parsed.value })
      : undefined;
  // Saving moves the revision, so a draft made for the old one no longer counts.
  const dirty = made?.id === id && impact !== undefined && impact.changes.length > 0;
  const pending = preset !== undefined && preset.pendingOrgs > 0;

  async function submit() {
    if (!preset) return void (await query.refetch());
    if (pending) {
      const out = await save.mutateAsync({
        preset: preset.preset,
        expectedRevision: preset.revision,
        values: {},
      });
      toast.success(`${orgs(out.moved)} moved`);
      return;
    }
    if (!impact || impact.changes.length === 0) throw new UserMessageError('Change a value first.');
    setConfirming(true);
  }

  return (
    <>
      <FormDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title="Edit presets"
        dirty={dirty}
        cancelLabel={dirty ? 'Cancel' : 'Close'}
        busy={query.isPending}
        submitLabel={!preset ? 'Retry' : pending ? 'Move the rest' : 'Continue'}
        onSubmit={submit}
      >
        {query.isPending ? (
          <SkeletonRows label="Loading presets" />
        ) : !preset || !edit ? (
          <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
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
            {pending ? (
              <Callout tone="warning" title={`${orgs(preset.pendingOrgs)} not moved yet`}>
                Change {preset.label} again once they have.
              </Callout>
            ) : (
              <>
                <FormField label="Feature">
                  {(p) => (
                    <Select
                      id={p.id}
                      value={edit.key}
                      onValueChange={(next) => {
                        const k = next as EntitlementKey;
                        setMade({ id, key: k, draft: draftOf(k, preset.values[k] ?? 0) });
                      }}
                      options={KEYS.map((k) => ({
                        value: k,
                        label: `${ENTITLEMENT_LABEL[k]}: ${formatValue(k, before[k])}`,
                      }))}
                    />
                  )}
                </FormField>
                <ValueField
                  featureKey={edit.key}
                  draft={edit.draft}
                  onChange={(draft) => setMade({ ...edit, draft })}
                  error={parsed && 'error' in parsed ? parsed.error : undefined}
                />
              </>
            )}
          </>
        )}
      </FormDialog>
      {preset && edit && impact && parsed && 'value' in parsed ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          {...editPresetConfirm(preset.label, preset.orgCount, impact)}
          onConfirm={async () => {
            const out = await save.mutateAsync({
              preset: preset.preset,
              expectedRevision: preset.revision,
              values: { [edit.key]: parsed.value },
            });
            toast.success(
              out.preset.pendingOrgs > 0
                ? `${orgs(out.moved)} moved, ${out.preset.pendingOrgs} to go`
                : `${preset.label} changed`,
            );
          }}
        />
      ) : null}
    </>
  );
}
