import { Monitor, MonitorCheck, Smartphone, Sparkles, UserRound } from 'lucide-react';
import type {
  ScanDeviceCapabilities,
  ScanningDevice,
} from '@/shared/contracts/scanning-sessions.ts';
import { SCAN_SURFACE_LABELS } from '@/shared/scan-surfaces.ts';
import { FormField, Select } from '@/web/ui/index.ts';

export const SURFACE_ICON = {
  auto: Sparkles,
  phone: Smartphone,
  operator: MonitorCheck,
  desk: Monitor,
  customer: UserRound,
};
const HELP = {
  auto: 'Adapts the scanner to this screen.',
  phone: 'Camera and fast check-in.',
  operator: 'People, codes and activity. No camera required.',
  desk: 'Read-only session activity for staff.',
  customer: 'A private, simple result for the visitor.',
};
export function SurfacePicker({
  value,
  onChange,
  capabilities,
}: {
  value: ScanningDevice['surface'];
  onChange: (v: ScanningDevice['surface']) => void;
  capabilities?: ScanDeviceCapabilities | null;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium text-fg">Device layout</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(Object.keys(SCAN_SURFACE_LABELS) as ScanningDevice['surface'][]).map((key) => {
          const Icon = SURFACE_ICON[key];
          const disabled =
            key !== 'auto' &&
            !!capabilities &&
            !capabilities.surfaces.includes(key) &&
            value !== key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={value === key}
              disabled={disabled}
              onClick={() => onChange(key)}
              className={`flex min-h-20 items-start gap-3 rounded-lg border p-3 text-left transition-[background-color,border-color] disabled:opacity-50 ${value === key ? 'border-accent bg-accent-subtle' : 'border-border-strong bg-surface-raised hover:bg-state-hover-tint'}`}
            >
              <Icon className="mt-0.5 size-5 shrink-0 text-fg-muted" aria-hidden />
              <span>
                <span className="block text-sm font-medium text-fg-strong">
                  {SCAN_SURFACE_LABELS[key]}
                </span>
                <span className="block text-xs text-fg-muted">
                  {disabled ? 'Unavailable on this device.' : HELP[key]}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {!capabilities ? (
        <p className="text-xs text-fg-muted">
          Available layouts will be confirmed when the device connects.
        </p>
      ) : null}
    </fieldset>
  );
}
export function InheritSelect({
  label,
  value,
  onChange,
  options,
  sessionLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  sessionLabel: string;
}) {
  return (
    <FormField label={label}>
      {(p) => (
        <Select
          {...p}
          value={value}
          onValueChange={onChange}
          options={[{ value: 'inherit', label: `Session: ${sessionLabel}` }, ...options]}
        />
      )}
    </FormField>
  );
}
