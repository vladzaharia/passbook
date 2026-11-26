import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ACCENT_PRESETS } from '@/shared/accent-presets.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { cn } from '../../lib/cn.ts';
import { Button, FileDrop, FormField, IconButton, Select } from '../../ui/index.ts';
import { SourceTag } from '../brand/source-tag.tsx';
import { MAX_ASSET_BYTES, TOO_BIG } from '../passes/png.ts';
import { parseColor, type Rgb, toHex } from '../templates/designer/contrast.ts';
import type { DraftAsset } from '../templates/designer/model.ts';
import './blueprints.css';
import { type Choices, logoColors, placeLogo } from './quick-setup.ts';

/** A preview address for the chosen file; empty where the browser has none. */
const objectUrl = (file: Blob) =>
  typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';

const COPY = TEMPLATE_BRAND_COPY.designer;

/** Offered until a logo brings its own. */
export const PRESETS: { name: string; rgb: Rgb }[] = ACCENT_PRESETS.map((p) => ({
  name: p.name,
  rgb: parseColor(p.hex) as Rgb,
}));
const presetName = (c: Rgb) => PRESETS.find((p) => toHex(p.rgb) === toHex(c))?.name;

/** What the organization already sets, and whether this person may write the organization's brand. */
export interface OrgBrandInfo {
  logoUrl: string | null;
  colors: Rgb | null;
  canWrite: boolean;
}

export interface QuickState {
  /** The part is the template's own although the organization sets one. */
  override: { logo: boolean; colors: boolean };
  setOverride: (part: 'logo' | 'colors', on: boolean) => void;
  goal: number | undefined;
  currency: string | undefined;
  setGoal: (goal: number | undefined) => void;
  setCurrency: (code: string | undefined) => void;
  logo: { asset: DraftAsset; url: string; name: string; file: File } | null;
  color: Rgb | undefined;
  swatches: Rgb[];
  problem: string | undefined;
  touched: boolean;
  takeLogo: (file: File) => Promise<void>;
  clearLogo: () => void;
  pick: (color: Rgb | undefined) => void;
}

/** Logo and colour: a dropped logo offers its own colours, and the first one is taken. */
export function useQuickFields(): QuickState {
  const [logo, setLogo] = useState<QuickState['logo']>(null);
  const [color, setColor] = useState<Rgb | undefined>(undefined);
  const [swatches, setSwatches] = useState<Rgb[]>(PRESETS.map((p) => p.rgb));
  const [problem, setProblem] = useState<string>();
  const [goal, setGoal] = useState<number>();
  const [currency, setCurrency] = useState<string>();
  const [override, setOverrides] = useState({ logo: false, colors: false });
  const url = logo?.url;
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  async function takeLogo(file: File) {
    setProblem(undefined);
    if (file.size > MAX_ASSET_BYTES) return setProblem(TOO_BIG);
    const placed = await placeLogo(file);
    if (!placed.ok) return setProblem(placed.message);
    const found = await logoColors(file);
    setLogo({ asset: placed.asset, url: objectUrl(file), name: file.name, file });
    if (found.length > 0) setSwatches(found);
    if (found[0]) setColor(found[0]);
  }

  return {
    override,
    setOverride: (part, on) => {
      setOverrides((o) => ({ ...o, [part]: on }));
      if (!on && part === 'logo') setLogo(null);
      if (!on && part === 'colors') setColor(undefined);
    },
    logo,
    color,
    swatches,
    problem,
    goal,
    currency,
    setGoal,
    setCurrency,
    touched: logo !== null || color !== undefined || goal !== undefined || currency !== undefined,
    takeLogo,
    clearLogo: () => {
      setLogo(null);
      setSwatches(PRESETS.map((p) => p.rgb));
      setProblem(undefined);
    },
    pick: setColor,
  };
}

const same = (a: Rgb | undefined, b: Rgb) => a?.r === b.r && a.g === b.g && a.b === b.b;

/** A part the organization sets: shown as it is, with the way to keep the template's own. */
function FromOrg({
  label,
  children,
  onOverride,
}: {
  label: string;
  children: React.ReactNode;
  onOverride: () => void;
}) {
  return (
    <FormField label={label}>
      {() => (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-sunken p-2">
          {children}
          <SourceTag source="org" label={COPY.fromOrg} />
          <Button variant="link" size="sm" className="ml-auto" onClick={onOverride}>
            {COPY.override}
          </Button>
        </div>
      )}
    </FormField>
  );
}

/** Under a part the organization could own: where it is saved, or the way back to the organization's. */
function orgHelp(
  state: QuickState,
  part: 'logo' | 'colors',
  orgSets: boolean,
  canWrite: boolean,
): React.ReactNode {
  if (orgSets)
    return (
      <Button variant="link" size="sm" onClick={() => state.setOverride(part, false)}>
        {COPY.useOrg}
      </Button>
    );
  return canWrite ? (part === 'logo' ? COPY.logoToOrg : COPY.colorsToOrg) : undefined;
}

export function QuickFields({
  state,
  choices,
  org,
}: {
  state: QuickState;
  choices: Choices;
  org: OrgBrandInfo;
}) {
  const { logo, color, swatches } = state;
  const logoFromOrg = org.logoUrl !== null && !state.override.logo;
  const colorFromOrg = org.colors !== null && !state.override.colors;
  return (
    <div className="flex flex-col gap-4">
      {logoFromOrg ? (
        <FromOrg label="Logo" onOverride={() => state.setOverride('logo', true)}>
          <img src={org.logoUrl ?? ''} alt="" className="h-10 max-w-24 object-contain" />
        </FromOrg>
      ) : (
        <FormField
          label="Logo"
          error={state.problem}
          help={orgHelp(state, 'logo', org.logoUrl !== null, org.canWrite)}
        >
          {(c) =>
            logo ? (
              <div className="flex items-center gap-3 rounded-md border border-border bg-surface-sunken p-2">
                {logo.url ? (
                  <img src={logo.url} alt="" className="h-10 max-w-24 object-contain" />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{logo.name}</span>
                <IconButton
                  label="Remove logo"
                  icon={<X aria-hidden />}
                  variant="ghost"
                  onClick={state.clearLogo}
                />
              </div>
            ) : (
              <FileDrop
                accept=".png,image/png"
                maxBytes={MAX_ASSET_BYTES}
                label="Choose a PNG logo"
                invalid={c['aria-invalid'] === true}
                className="[&_.wl-file-drop]:py-4"
                onFiles={([file]) => file && void state.takeLogo(file)}
              />
            )
          }
        </FormField>
      )}
      {colorFromOrg ? (
        <FromOrg label="Colour" onOverride={() => state.setOverride('colors', true)}>
          <span
            aria-hidden
            className="size-8 rounded-full border border-border-strong"
            style={{ background: org.colors ? toHex(org.colors) : undefined }}
          />
        </FromOrg>
      ) : (
        <FormField
          label="Colour"
          help={orgHelp(state, 'colors', org.colors !== null, org.canWrite)}
        >
          {() => (
            <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
              <legend className="sr-only">Card colour</legend>
              {swatches.map((s) => (
                <button
                  key={toHex(s)}
                  type="button"
                  aria-pressed={same(color, s)}
                  aria-label={presetName(s) ?? toHex(s)}
                  onClick={() => state.pick(s)}
                  style={{ background: toHex(s) }}
                  className={cn(
                    'size-8 pointer-coarse:size-11 rounded-full border border-border-strong wl-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    same(color, s) && 'outline-2 outline-offset-2 outline-fg-strong',
                  )}
                />
              ))}
              <input
                type="color"
                aria-label="Custom colour"
                className="bp-swatch"
                value={color ? toHex(color) : '#1d3aba'}
                onChange={(e) => state.pick(parseColor(e.target.value) ?? undefined)}
              />
              {color ? (
                <button
                  type="button"
                  className="text-xs text-fg-muted underline underline-offset-2 hover:text-fg-strong"
                  onClick={() => state.pick(undefined)}
                >
                  Keep blueprint colours
                </button>
              ) : null}
            </fieldset>
          )}
        </FormField>
      )}
      {choices.goal ? (
        <FormField label="Stamps for a reward">
          {(c) => (
            <Select
              {...c}
              value={String(state.goal ?? choices.goal?.value)}
              onValueChange={(v) => state.setGoal(Number(v))}
              options={Array.from(
                { length: (choices.goal?.max ?? 0) - (choices.goal?.min ?? 0) + 1 },
                (_, i) => {
                  const n = (choices.goal?.min ?? 0) + i;
                  return { value: String(n), label: String(n) };
                },
              )}
            />
          )}
        </FormField>
      ) : null}
      {choices.currency ? (
        <FormField label="Currency">
          {(c) => (
            <Select
              {...c}
              value={state.currency ?? choices.currency?.value}
              onValueChange={state.setCurrency}
              options={(choices.currency?.options ?? []).map((o) => ({ value: o, label: o }))}
            />
          )}
        </FormField>
      ) : null}
    </div>
  );
}
