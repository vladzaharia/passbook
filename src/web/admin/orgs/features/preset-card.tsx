import {
  BadgeCheck,
  Hourglass,
  Layers,
  type LucideIcon,
  Infinity as Unlimited,
} from 'lucide-react';
import { useState } from 'react';
import type { OrgEntitlementsDto, PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { PRESET_NOTE } from '@/shared/copy/entitlement-admin.ts';
import { entitlementImpact, reducing } from '@/shared/entitlement-impact.ts';
import { applyPresetConfirm } from '@/web/lib/confirms-features.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  OptionTile,
} from '@/web/ui/index.ts';
import { ImpactList, ImpactSummary } from './impact-view.tsx';
import { PresetEditor } from './preset-editor.tsx';
import { type OverrideMap, resolved, valuesOf } from './values.ts';

const ICON: Record<string, LucideIcon> = {
  legacy: Unlimited,
  trial: Hourglass,
  standard: BadgeCheck,
};

// A non-breaking space keeps the count with its noun when the line wraps.
const orgs = (n: number) => `${n}\u00a0${n === 1 ? 'organization' : 'organizations'}`;

/**
 * Picks the org's preset. A different pick shows what it would change (against the values the org has now,
 * overrides included) before anything is saved, and Apply asks once more with the same counts.
 */
export function PresetCard({
  state,
  orgName,
  overrides,
  onApply,
}: {
  state: OrgEntitlementsDto & { preset: string; presetLabel: string };
  orgName: string;
  overrides: OverrideMap;
  onApply: (preset: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState(state.preset);
  const [confirming, setConfirming] = useState(false);
  const target: PresetOptionDto | undefined = state.presets.find((p) => p.preset === picked);
  const moving = target !== undefined && picked !== state.preset;
  const impact = target
    ? entitlementImpact(valuesOf(state.items), resolved(target.values, overrides))
    : undefined;
  return (
    <Card>
      <CardHeader
        title="Preset"
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-fg-muted">Updated {formatDateTime(state.updatedAt)}</span>
            <PresetEditor />
          </div>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="sr-only">Preset</legend>
          {state.presets.map((p) => (
            <OptionTile
              key={p.preset}
              name="preset"
              value={p.preset}
              icon={ICON[p.preset] ?? Layers}
              label={
                <>
                  {p.label}
                  {p.preset === state.preset ? (
                    <Badge tone="accent" className="ml-2 align-middle">
                      Current
                    </Badge>
                  ) : null}
                </>
              }
              description={`${PRESET_NOTE[p.preset] ?? ''} ${orgs(p.orgCount)}.`.trim()}
              checked={picked === p.preset}
              onSelect={setPicked}
            />
          ))}
        </fieldset>
        {moving && target && impact ? (
          <Callout
            tone={reducing(impact) > 0 ? 'warning' : 'info'}
            title={`${target.label} instead of ${state.presetLabel}`}
            actions={
              <>
                <Button variant="outline" size="sm" onClick={() => setPicked(state.preset)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => setConfirming(true)}>
                  Apply {target.label}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <ImpactSummary impact={impact} />
              <ImpactList impact={impact} />
            </div>
          </Callout>
        ) : null}
      </CardBody>
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
    </Card>
  );
}
