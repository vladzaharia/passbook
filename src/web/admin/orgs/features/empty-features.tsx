import { useState } from 'react';
import type { OrgEntitlementsDto } from '@/shared/contracts/entitlement-admin.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import { firstPresetConfirm } from '@/web/lib/confirms-features.ts';
import { Button, Callout, Card, CardBody, CardHeader, ConfirmDialog } from '@/web/ui/index.ts';
import { PlanPicker } from './plan-picker.tsx';

/**
 * An organization with no features row (nothing is on until one exists): pick a plan and apply it. The
 * first save creates the row; there is nothing to compare, so the confirm only says so.
 */
export function EmptyFeatures({
  state,
  orgName,
  arrival,
  onApply,
}: {
  state: OrgEntitlementsDto;
  orgName: string;
  arrival?: false | 'rise' | 'quiet';
  onApply: (preset: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const target = state.presets.find((p) => p.preset === picked);
  return (
    <Card>
      <CardHeader title="Features" />
      <CardBody className="flex flex-col gap-4">
        <Callout tone="warning" title="No features set">
          Gated features stay off until a plan is applied.
        </Callout>
        <PlanPicker
          plans={state.presets}
          current={null}
          picked={picked}
          onPick={setPicked}
          arrival={arrival}
          orgName={orgName}
        />
        <div>
          <Button disabled={!target} onClick={() => setConfirming(true)}>
            {PLAN_COPY.apply}
          </Button>
        </div>
      </CardBody>
      {target ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          {...firstPresetConfirm(target.label, orgName)}
          onConfirm={() => onApply(target.preset)}
        />
      ) : null}
    </Card>
  );
}
