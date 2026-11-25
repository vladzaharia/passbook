import { useState } from 'react';
import type { OrgEntitlementsDto } from '@/shared/contracts/entitlement-admin.ts';
import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import { type EntitlementValues, entitlementImpact } from '@/shared/entitlement-impact.ts';
import { useOrgTimeZone } from '@/web/admin/settings/use-org-time-zone.ts';
import { overrideConfirm, resetOverrideConfirm } from '@/web/lib/confirms-features.ts';
import { useArrivalMode } from '@/web/lib/motion.ts';
import { ConfirmDialog, ErrorState, SkeletonRows, toast } from '@/web/ui/index.ts';
import { PlatformAppleCard } from './apple-card.tsx';
import { PlatformChannels } from './channels-card.tsx';
import { EmptyFeatures } from './empty-features.tsx';
import { FeatureList } from './feature-list.tsx';
import { OverrideDialog } from './override-dialog.tsx';
import { PresetCard } from './preset-card.tsx';
import { useOrgFeatures, useSetFeatures } from './queries.ts';
import { type OverrideDraft, type OverrideMap, overridesOf, resolved, valuesOf } from './values.ts';

/** A change to one override awaiting its confirm: `draft` null removes it. */
interface Pending {
  key: EntitlementKey;
  draft: OverrideDraft | null;
}

/** The platform org page's Features tab: the preset, then every feature with its override. */
export function FeaturesTab({ orgId, orgName }: { orgId: string; orgName: string }) {
  const query = useOrgFeatures(orgId);
  const arrival = useArrivalMode(query.isPending);
  if (query.isPending) return <SkeletonRows label="Loading features" />;
  if (!query.data)
    return <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />;
  return <FeaturesBody orgId={orgId} orgName={orgName} state={query.data} arrival={arrival} />;
}

function FeaturesBody({
  orgId,
  orgName,
  state,
  arrival,
}: {
  orgId: string;
  orgName: string;
  state: OrgEntitlementsDto;
  arrival: false | 'rise' | 'quiet';
}) {
  const save = useSetFeatures(orgId, state.revision);
  const timeZone = useOrgTimeZone(orgId);
  const overrides = overridesOf(state.items);
  const presetValues = state.presets.find((p) => p.preset === state.preset)?.values ?? {};
  const [editing, setEditing] = useState<EntitlementKey | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const withOverride = (p: Pending): OverrideMap => {
    const { [p.key]: _gone, ...rest } = overrides;
    return p.draft ? { ...rest, [p.key]: p.draft } : rest;
  };
  const impact = pending
    ? entitlementImpact(
        valuesOf(state.items),
        resolved(presetValues as EntitlementValues, withOverride(pending)),
      )
    : undefined;
  const label = pending ? ENTITLEMENT_LABEL[pending.key] : '';
  const item = editing ? state.items.find((i) => i.key === editing) : undefined;

  const { preset, presetLabel } = state;
  if (preset === null || presetLabel === null)
    return (
      <EmptyFeatures
        state={state}
        orgName={orgName}
        arrival={arrival}
        onApply={async (chosen) => {
          const next = await save.mutateAsync({ preset: chosen, overrides: {} });
          toast.success(`${next.presetLabel} applied`);
        }}
      />
    );
  const ready = { ...state, preset, presetLabel };

  return (
    <div className="flex flex-col gap-6">
      <PresetCard
        state={ready}
        orgName={orgName}
        overrides={overrides}
        arrival={arrival}
        onApply={async (preset) => {
          const next = await save.mutateAsync({ preset, overrides });
          toast.success(`${next.presetLabel} applied`);
        }}
      />
      <PlatformChannels orgId={orgId} orgName={orgName} onInclude={setEditing} />
      <PlatformAppleCard orgId={orgId} />
      <FeatureList
        items={state.items}
        presetLabel={presetLabel}
        busy={save.isPending}
        onEdit={setEditing}
        onReset={(key) => setPending({ key, draft: null })}
      />
      {item ? (
        <OverrideDialog
          item={item}
          presetLabel={presetLabel}
          now={Date.now()}
          timeZone={timeZone}
          onClose={() => setEditing(null)}
          onContinue={(draft) => {
            setEditing(null);
            setPending({ key: item.key, draft });
          }}
        />
      ) : null}
      {pending && impact ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          {...(pending.draft
            ? overrideConfirm(label, impact)
            : resetOverrideConfirm(label, presetLabel, impact))}
          onConfirm={async () => {
            await save.mutateAsync({ preset, overrides: withOverride(pending) });
            toast.success(pending.draft ? `${label} overridden` : `${label} reset`);
          }}
        />
      ) : null}
    </div>
  );
}
