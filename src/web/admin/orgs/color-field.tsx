import { cn } from '@/web/lib/cn.ts';
import { FormField, Input } from '@/web/ui/index.ts';
import { HEX, hexOf } from './branding.ts';

/** An unset colour: a dashed, struck-through swatch, so it never reads as a chosen one. */
const EMPTY = {
  backgroundImage:
    'linear-gradient(to top right, transparent calc(50% - 0.75px), var(--pk-border-strong) 50%, transparent calc(50% + 0.75px))',
};

/**
 * Swatch plus a w-40 hex field (ui-consistency.md "Forms"). Empty means a default colour: the
 * swatch shows no colour and the field names the default (`empty`).
 */
export function ColorField({
  label,
  value,
  fallback,
  onChange,
  error,
  help,
  empty,
}: {
  label: string;
  value: string;
  /** Placeholder while unset ("Template"). */
  empty: string;
  /** The picker starts from this while the hex is empty or partial. */
  fallback: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  help?: string | undefined;
}) {
  const set = HEX.test(value);
  return (
    <FormField label={label} error={error} help={help}>
      {(p) => (
        <div className="flex items-center gap-2">
          <span className="relative shrink-0">
            <input
              type="color"
              aria-label={`${label} picker`}
              value={set ? value : (hexOf(fallback) ?? '#000000')}
              onChange={(e) => onChange(e.target.value)}
              className={cn(
                'block size-9 cursor-pointer rounded-md border border-border-strong bg-transparent p-0.5 pointer-coarse:size-11',
                !set && 'opacity-0',
              )}
            />
            {set ? null : (
              <span
                aria-hidden
                style={EMPTY}
                className="pointer-events-none absolute inset-0 rounded-md border border-dashed border-border-strong"
              />
            )}
          </span>
          <Input
            {...p}
            className="w-40 font-mono placeholder:font-sans"
            placeholder={empty}
            spellCheck={false}
            autoCapitalize="off"
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
          />
        </div>
      )}
    </FormField>
  );
}
