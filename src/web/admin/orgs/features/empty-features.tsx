import { useState } from 'react';
import type { OrgEntitlementsDto } from '@/shared/contracts/entitlement-admin.ts';
import { PRESET_NOTE } from '@/shared/copy/entitlement-admin.ts';
import { firstPresetConfirm } from '@/web/lib/confirms-features.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  OptionTile,
} from '@/web/ui/index.ts';

/**
 * An organization with no features row (nothing is on until one exists): pick a preset and apply it. The
 * first save creates the row; there is nothing to compare, so the confirm only says so.
 */
export function EmptyFeatures({
  state,
  orgName,
  onApply,
}: {
  state: OrgEntitlementsDto;
  orgName: string;
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
          Gated features stay off until a preset is applied.
        </Callout>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="sr-only">Preset</legend>
          {state.presets.map((p) => (
            <OptionTile
              key={p.preset}
              name="preset"
              value={p.preset}
              label={p.label}
              description={PRESET_NOTE[p.preset]}
              checked={picked === p.preset}
              onSelect={setPicked}
            />
          ))}
        </fieldset>
        <div>
          <Button disabled={!target} onClick={() => setConfirming(true)}>
            Apply preset
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
