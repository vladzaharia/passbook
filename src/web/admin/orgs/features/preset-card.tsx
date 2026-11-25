import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { OrgEntitlementsDto, PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import { entitlementImpact, reducing } from '@/shared/entitlement-impact.ts';
import { applyPresetConfirm } from '@/web/lib/confirms-features.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  SaveBar,
} from '@/web/ui/index.ts';
import { ImpactList, ImpactSummary } from './impact-view.tsx';
import { PlanCompareSheet } from './plan-compare-sheet.tsx';
import { PlanPicker } from './plan-picker.tsx';
import { PresetEditor } from './preset-editor.tsx';
import { type OverrideMap, resolved, valuesOf } from './values.ts';

/**
 * Picks the org's plan. A different pick shows what it would change (against the values the org has now,
 * overrides included) in the save bar and below the cards before anything is saved; Apply asks once more
 * with the same counts.
 */
export function PresetCard({
  state,
  orgName,
  overrides,
  arrival,
  onApply,
}: {
  state: OrgEntitlementsDto & { preset: string; presetLabel: string };
  orgName: string;
  overrides: OverrideMap;
  arrival?: false | 'rise' | 'quiet';
  onApply: (preset: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState(state.preset);
  const [confirming, setConfirming] = useState(false);
  const [comparing, setComparing] = useState(false);
  const target: PresetOptionDto | undefined = state.presets.find((p) => p.preset === picked);
  const moving = target !== undefined && picked !== state.preset;
  const impact = target
    ? entitlementImpact(valuesOf(state.items), resolved(target.values, overrides))
    : undefined;
  return (
    <Card>
      <CardHeader
        title={PLAN_COPY.title}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              iconEnd={<ChevronRight aria-hidden />}
              onClick={() => setComparing(true)}
            >
              {PLAN_COPY.compare}
            </Button>
            <PresetEditor current={state.preset} />
          </div>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <PlanPicker
          plans={state.presets}
          current={state.preset}
          picked={picked}
          onPick={setPicked}
          arrival={arrival}
          orgName={orgName}
        />
        {moving && target && impact ? (
          <Callout
            tone={reducing(impact) > 0 ? 'warning' : 'info'}
            title={PLAN_COPY.insteadOf(target.label, state.presetLabel)}
          >
            <ImpactList impact={impact} />
          </Callout>
        ) : null}
        <p className="text-right text-xs text-fg-muted">
          {PLAN_COPY.updated(formatDateTime(state.updatedAt))}
        </p>
      </CardBody>
      <SaveBar
        dirty={moving}
        label={target ? PLAN_COPY.insteadOf(target.label, state.presetLabel) : undefined}
        saveLabel={target ? PLAN_COPY.applyTarget(target.label) : undefined}
        extra={impact ? <ImpactSummary impact={impact} /> : undefined}
        onSave={() => setConfirming(true)}
        onDiscard={() => setPicked(state.preset)}
      />
      {moving && target && impact ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          {...applyPresetConfirm(target.label, orgName, impact)}
          onConfirm={async () => {
            await onApply(target.preset);
          }}
        />
      ) : null}
      {comparing ? (
        <PlanCompareSheet
          plans={state.presets}
          current={state.preset}
          picked={picked}
          onClose={() => setComparing(false)}
        />
      ) : null}
    </Card>
  );
}
