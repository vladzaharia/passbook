import { FormField, Input } from '@/web/ui/index.ts';
import { HEX } from './branding.ts';

/** Swatch plus a w-40 hex field (ui-consistency.md "Forms"). */
export function ColorField({
  label,
  value,
  fallback,
  onChange,
  error,
  help,
}: {
  label: string;
  value: string;
  /** The swatch shows this while the hex is empty or partial. */
  fallback: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  help?: string | undefined;
}) {
  return (
    <FormField label={label} error={error} help={help}>
      {(p) => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} picker`}
            value={HEX.test(value) ? value : fallback}
            onChange={(e) => onChange(e.target.value)}
            className="size-9 shrink-0 cursor-pointer rounded-md border border-border-strong bg-transparent p-0.5 pointer-coarse:size-11"
          />
          <Input
            {...p}
            className="w-40 font-mono"
            placeholder={fallback}
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
