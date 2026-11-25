import { ACCENT_PRESETS } from '@/shared/accent-presets.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { cn } from '@/web/lib/cn.ts';

/** Fixed accent swatches, the same set the blueprint quick setup offers. */
export function AccentChips({
  value,
  onPick,
  disabled,
}: {
  value: string;
  onPick: (hex: string) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">{PASS_SETUP_COPY.brand.accentPresets}</legend>
      <span aria-hidden className="text-xs text-fg-muted">
        {PASS_SETUP_COPY.brand.accentPresets}
      </span>
      {ACCENT_PRESETS.map((p) => {
        const on = value.toLowerCase() === p.hex;
        return (
          <button
            key={p.hex}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={p.name}
            title={p.name}
            onClick={() => onPick(p.hex)}
            style={{ background: p.hex }}
            className={cn(
              'size-7 rounded-full border border-border-strong pointer-coarse:size-11',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50',
              on && 'outline-2 outline-offset-2 outline-fg-strong',
            )}
          />
        );
      })}
    </fieldset>
  );
}
