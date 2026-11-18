import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { FileDrop, FormField, IconButton, Select } from '../../ui/index.ts';
import { MAX_ASSET_BYTES, TOO_BIG } from '../passes/png.ts';
import { parseColor, type Rgb, toHex } from '../templates/designer/contrast.ts';
import type { DraftAsset } from '../templates/designer/model.ts';
import './blueprints.css';
import { type Choices, logoColors, placeLogo } from './quick-setup.ts';

/** A preview address for the chosen file; empty where the browser has none. */
const objectUrl = (file: Blob) =>
  typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';

export interface QuickState {
  goal: number | undefined;
  currency: string | undefined;
  setGoal: (goal: number | undefined) => void;
  setCurrency: (code: string | undefined) => void;
  logo: { asset: DraftAsset; url: string; name: string } | null;
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
  const [swatches, setSwatches] = useState<Rgb[]>([]);
  const [problem, setProblem] = useState<string>();
  const [goal, setGoal] = useState<number>();
  const [currency, setCurrency] = useState<string>();
  const url = logo?.url;
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  async function takeLogo(file: File) {
    setProblem(undefined);
    if (file.size > MAX_ASSET_BYTES) return setProblem(TOO_BIG);
    const placed = await placeLogo(file);
    if (!placed.ok) return setProblem(placed.message);
    const found = await logoColors(file);
    setLogo({ asset: placed.asset, url: objectUrl(file), name: file.name });
    setSwatches(found);
    if (found[0]) setColor(found[0]);
  }

  return {
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
      setSwatches([]);
      setProblem(undefined);
    },
    pick: setColor,
  };
}

const same = (a: Rgb | undefined, b: Rgb) => a?.r === b.r && a.g === b.g && a.b === b.b;

export function QuickFields({ state, choices }: { state: QuickState; choices: Choices }) {
  const { logo, color, swatches } = state;
  return (
    <div className="flex flex-col gap-4">
      <FormField label="Logo" error={state.problem}>
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
      <FormField label="Colour">
        {() => (
          <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
            <legend className="sr-only">Card colour</legend>
            {swatches.map((s) => (
              <button
                key={toHex(s)}
                type="button"
                aria-pressed={same(color, s)}
                aria-label={toHex(s)}
                onClick={() => state.pick(s)}
                style={{ background: toHex(s) }}
                className={cn(
                  'size-8 rounded-full border border-border-strong wl-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
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
      <p className="text-xs text-fg-muted">Change anything later in the designer.</p>
    </div>
  );
}
