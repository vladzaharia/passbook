import { MINTABLE_SCOPES } from '@/shared/contracts/api-keys.ts';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { adminPresets, holdableScopes, selectedPreset } from '@/shared/developers-keys.ts';
import { OptionTile, SegmentedControl } from '@/web/ui/index.ts';
import { ROLE_LABELS, ROLES } from '../orgs/org-roles.ts';
import { offeredPlatformScopes } from './key-kind-fields.ts';
import { PRESET_FACT } from './key-presets.ts';
import { ScopePicker } from './scope-picker.tsx';
import { TerminalRows } from './scope-rows.tsx';
import type { KeyForm } from './use-key-form.ts';

const FLAVOURS = [
  { value: 'platform', label: 'Platform' },
  { value: 'all', label: 'All organizations' },
] as const;
const TILE = 'min-h-0 p-3';
const GRID = 'grid grid-cols-2 gap-3 @xl:grid-cols-3';

/** What the key may do: a preset, a role, or scopes picked one by one. */
export function StepAccess({
  form,
  orgId,
  capabilities,
  developerOrg,
  errors,
}: {
  form: KeyForm;
  orgId: string | null;
  capabilities: readonly OrgCapability[] | null;
  developerOrg: boolean;
  errors: Record<string, string | undefined>;
}) {
  const platform = orgId === null;
  const holdable = holdableScopes(
    platform ? 'platform' : form.kind,
    capabilities,
    form.keyMode,
    developerOrg,
  ).filter((s) => !form.cap || form.cap.scopes.includes(s));
  const presets = adminPresets(holdable, form.keyMode);
  const preset = selectedPreset(presets, form.scopes);
  const current = form.role ?? (form.custom || !preset ? 'custom' : preset.id);
  const scopeCount = form.scopes.length;
  const choosePreset = (scopes: readonly string[]) => {
    form.setAccess('scopes');
    form.setCustom(false);
    form.set([...scopes]);
  };
  const platformScopes = offeredPlatformScopes();
  const switcher =
    platform && platformScopes.length > 0 ? (
      <div className="flex flex-col">
        <p className="mb-2 text-sm font-medium text-fg">Reaches</p>
        <SegmentedControl
          label="Reaches"
          options={FLAVOURS}
          value={form.flavour}
          onValueChange={form.changeFlavour}
        />
      </div>
    ) : null;
  if (form.onPlatform)
    return (
      <>
        {switcher}
        {form.idpSession ? (
          <ScopePicker
            offered={platformScopes}
            value={form.scopes}
            onChange={form.set}
            note={form.note}
            error={errors.scopes}
          />
        ) : (
          <p role="alert" className="text-sm text-danger">
            {form.errors.access && 'scopes' in form.errors.access
              ? form.errors.access.scopes
              : null}
          </p>
        )}
      </>
    );
  return (
    <>
      {switcher}
      <fieldset className="flex min-w-0 flex-col">
        <legend className="mb-2 text-sm font-medium text-fg">Presets</legend>
        <div className={GRID}>
          {presets.map((p) => (
            <OptionTile
              key={p.id}
              name="key-access"
              value={p.id}
              label={p.label}
              description={PRESET_FACT[p.id]}
              className={TILE}
              checked={current === p.id}
              onSelect={() => choosePreset(p.scopes)}
            />
          ))}
          <OptionTile
            name="key-access"
            value="custom"
            label="Custom"
            description={scopeCount ? `${scopeCount} picked.` : 'Pick scopes one by one.'}
            className={TILE}
            checked={current === 'custom'}
            onSelect={() => {
              form.setAccess('scopes');
              form.setCustom(true);
            }}
          />
        </div>
      </fieldset>
      {current !== 'custom' ? null : (
        <ScopePicker
          offered={MINTABLE_SCOPES.filter((s) => holdable.includes(s))}
          value={form.scopes}
          onChange={form.set}
          note={form.note}
          error={errors.scopes}
        />
      )}
      {form.scansWrite && !platform ? (
        <TerminalRows
          orgId={orgId}
          value={form.terminalIds}
          onChange={form.setTerminalIds}
          error={errors.terminalIds}
        />
      ) : null}
      {platform || form.cap ? null : (
        <fieldset className="flex min-w-0 flex-col">
          <legend className="mb-2 text-sm font-medium text-fg">Or a role</legend>
          <div className={GRID}>
            {ROLES.map((r) => (
              <OptionTile
                key={r}
                name="key-access"
                value={r}
                label={ROLE_LABELS[r]}
                className={TILE}
                checked={current === r}
                onSelect={() => form.setAccess(r)}
              />
            ))}
          </div>
          {errors.roles ? <p className="mt-1 text-xs text-danger">{errors.roles}</p> : null}
        </fieldset>
      )}
    </>
  );
}
