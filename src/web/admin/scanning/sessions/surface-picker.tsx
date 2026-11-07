import {
  Check,
  Monitor,
  MonitorCheck,
  ScanLine,
  Smartphone,
  Sparkles,
  UserRound,
} from 'lucide-react';
import type {
  ScanDeviceCapabilities,
  ScanningDevice,
} from '@/shared/contracts/scanning-sessions.ts';
import { SCAN_SURFACE_LABELS } from '@/shared/scan-surfaces.ts';
import { cn } from '@/web/lib/cn.ts';
import { FormField, Select } from '@/web/ui/index.ts';

export const SURFACE_ICON = {
  auto: Sparkles,
  phone: Smartphone,
  operator: MonitorCheck,
  desk: Monitor,
  customer: UserRound,
};
type SurfaceChoice = Exclude<ScanningDevice['surface'], 'desk'>;
const HELP: Record<SurfaceChoice, string> = {
  auto: 'Chooses Scanner or Operator for this screen size.',
  phone: 'Camera-first check-in for a handheld device.',
  operator: 'Look up passes, check in by code, and review session activity.',
  customer: 'Show a simple scan result to the visitor. No check-in controls.',
};

function SurfacePreview({ surface }: { surface: SurfaceChoice }) {
  const Icon = SURFACE_ICON[surface];
  if (surface === 'auto') {
    return (
      <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-sunken">
        <Icon className="size-5 text-fg-muted" />
      </span>
    );
  }
  return (
    <span className="flex h-16 w-20 shrink-0 items-center justify-center rounded-md bg-surface-sunken">
      {surface === 'phone' ? (
        <span className="flex h-12 w-7 items-center justify-center rounded border border-border-strong bg-surface-raised">
          <ScanLine className="size-4 text-fg-muted" />
        </span>
      ) : (
        <span className="flex h-10 w-16 overflow-hidden rounded border border-border-strong bg-surface-raised">
          {surface === 'operator' ? (
            <>
              <span className="flex w-5 flex-col gap-1 border-r border-border p-1">
                <span className="h-1 rounded bg-border-strong" />
                <span className="h-1 rounded bg-border" />
                <span className="h-1 rounded bg-border" />
              </span>
              <span className="flex flex-1 items-center justify-center">
                <ScanLine className="size-4 text-fg-muted" />
              </span>
            </>
          ) : (
            <span className="flex flex-1 items-center justify-center">
              <Check className="size-5 rounded-full border border-border-strong p-0.5 text-fg-muted" />
            </span>
          )}
        </span>
      )}
    </span>
  );
}
export function SurfacePicker({
  value,
  onChange,
  capabilities,
}: {
  value: ScanningDevice['surface'];
  onChange: (v: ScanningDevice['surface']) => void;
  capabilities?: ScanDeviceCapabilities | null;
}) {
  const choice = (key: SurfaceChoice) => {
    const selectedSurface = value === 'desk' ? 'operator' : value;
    const selected = selectedSurface === key;
    return (
      <button
        key={key}
        type="button"
        aria-pressed={selected}
        onClick={() => onChange(key)}
        className={cn(
          'flex min-w-0 items-center gap-3 rounded-lg border p-3 text-left wl-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          selected
            ? 'border-accent bg-accent-subtle'
            : 'border-border-strong bg-surface-raised hover:bg-state-hover-tint',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
            {SCAN_SURFACE_LABELS[key]}
            {selected ? <Check className="size-4 shrink-0 text-accent-fg" aria-hidden /> : null}
          </span>
          <span className="mt-1 block text-xs text-fg-muted">{HELP[key]}</span>
        </span>
        <span aria-hidden>
          <SurfacePreview surface={key} />
        </span>
      </button>
    );
  };
  return (
    <fieldset className="@container grid min-w-0 gap-3">
      <legend className="mb-2 text-sm font-medium text-fg">Device layout</legend>
      <p className="text-sm text-fg-muted">
        Choose how this device will be used. Admission rules remain shared by the session.
      </p>
      {choice('auto')}
      <div className="grid min-w-0 gap-3 @[34rem]:grid-cols-2">
        <div className="grid min-w-0 content-start gap-2">
          <p className="text-xs font-semibold text-fg-muted">CHECK-IN</p>
          {choice('phone')}
          {choice('operator')}
        </div>
        <div className="grid min-w-0 content-start gap-2">
          <p className="text-xs font-semibold text-fg-muted">CUSTOMER DISPLAY</p>
          {choice('customer')}
        </div>
      </div>
      {!capabilities ? (
        <p className="text-xs text-fg-muted">
          Screen size and inputs are reported when the device connects. All three views remain
          available.
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
