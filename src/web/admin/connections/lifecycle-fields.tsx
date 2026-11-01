import { CalendarClock, Combine, Hand, Layers, type LucideIcon, Radio } from 'lucide-react';
import {
  CheckboxField,
  FormField,
  Input,
  NumberField,
  OptionTile,
  Select,
  SwitchRow,
} from '../../ui/index.ts';
import { MODE_LABEL } from './labels.ts';

export interface Lifecycle {
  mode: 'poll' | 'webhook' | 'hybrid' | 'manual' | 'snapshot';
  /** Whole minutes; blank uses the connector default. */
  intervalMinutes: string;
  holderEmailField: string;
  /** Chosen on the Mapping step or tab. */
  defaultTemplateId: string;
  autoCreate: boolean;
  autoEmail: boolean;
  onMissing: 'keep' | 'flag' | 'void';
}

export interface ModeCapabilities {
  poll: boolean;
  webhook: boolean;
  snapshot: boolean;
}

const MODE: Record<Lifecycle['mode'], { icon: LucideIcon; description: string }> = {
  poll: { icon: CalendarClock, description: 'Checks the source on a schedule.' },
  webhook: { icon: Radio, description: 'The source sends changes as they happen.' },
  hybrid: { icon: Combine, description: 'Webhooks, plus a scheduled check.' },
  manual: { icon: Hand, description: 'Runs only on Sync now.' },
  snapshot: { icon: Layers, description: 'Reads the full list each run.' },
};

/** Modes the connector can run; always includes the current one. */
export function modeOptions(
  caps: ModeCapabilities | undefined,
  current: Lifecycle['mode'],
): Lifecycle['mode'][] {
  const ok: Record<Lifecycle['mode'], boolean> = {
    poll: !caps || caps.poll,
    webhook: !caps || caps.webhook,
    hybrid: !caps || (caps.poll && caps.webhook),
    manual: true,
    snapshot: Boolean(caps?.snapshot),
  };
  return (Object.keys(ok) as Lifecycle['mode'][]).filter((m) => ok[m] || m === current);
}

export const scheduled = (mode: Lifecycle['mode']) => mode === 'poll' || mode === 'hybrid';

export function lifecycleToPatch(l: Lifecycle) {
  const minutes = l.intervalMinutes.trim() ? Number(l.intervalMinutes) : undefined;
  return {
    mode: l.mode,
    ...(minutes !== undefined && scheduled(l.mode) ? { intervalSeconds: minutes * 60 } : {}),
    ...(l.holderEmailField.trim() ? { holderEmailField: l.holderEmailField.trim() } : {}),
    ...(l.defaultTemplateId ? { defaultTemplateId: l.defaultTemplateId } : {}),
    autoCreate: l.autoCreate,
    autoEmail: l.autoEmail,
    onMissing: l.onMissing,
  };
}

export function lifecycleError(l: Lifecycle): string | undefined {
  if (scheduled(l.mode) && l.intervalMinutes.trim()) {
    const n = Number(l.intervalMinutes);
    if (!Number.isInteger(n) || n < 1) return 'Interval must be a whole number of minutes.';
  }
  if (l.autoCreate && !l.defaultTemplateId) return 'Choose a template on Mapping to create passes.';
  return undefined;
}

/** Mode tiles, the interval (scheduled modes only), holder email and what happens to passes. */
export function LifecycleFields({
  value,
  onChange,
  disabled,
  error,
  capabilities,
  defaultMinutes,
  variant = 'wizard',
}: {
  capabilities?: ModeCapabilities | undefined;
  value: Lifecycle;
  onChange: (next: Lifecycle) => void;
  disabled?: boolean;
  error?: string | undefined;
  /** The connector's default, shown as the placeholder. */
  defaultMinutes?: number | undefined;
  /** Checkboxes in the wizard, switches for the saved settings. */
  variant?: 'wizard' | 'settings';
}) {
  const set = <K extends keyof Lifecycle>(key: K, v: Lifecycle[K]) =>
    onChange({ ...value, [key]: v });
  const bool = (label: string, field: 'autoCreate' | 'autoEmail', help?: string) =>
    variant === 'settings' ? (
      <SwitchRow
        label={label}
        help={help}
        disabled={disabled}
        checked={value[field]}
        onCheckedChange={(v) => set(field, v)}
      />
    ) : (
      <CheckboxField
        label={label}
        disabled={disabled}
        checked={value[field]}
        onCheckedChange={(v) => set(field, v === true)}
      />
    );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-medium text-fg">Mode</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {modeOptions(capabilities, value.mode).map((m) => (
            <OptionTile
              key={m}
              name="connection-mode"
              value={m}
              label={MODE_LABEL[m]}
              description={MODE[m].description}
              icon={MODE[m].icon}
              checked={value.mode === m}
              disabled={disabled}
              onSelect={(v) => set('mode', v as Lifecycle['mode'])}
            />
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        {scheduled(value.mode) ? (
          <FormField label="Interval" help="Blank uses the connector default.">
            {(c) => (
              <NumberField
                {...c}
                unit="min"
                min={1}
                step={1}
                inputMode="numeric"
                disabled={disabled}
                placeholder={defaultMinutes ? String(defaultMinutes) : undefined}
                value={value.intervalMinutes === '' ? null : Number(value.intervalMinutes)}
                onValueChange={(n) => set('intervalMinutes', n === null ? '' : String(n))}
              />
            )}
          </FormField>
        ) : null}
        <FormField label="Holder email" help="JSON pointer to the email in each record.">
          {(c) => (
            <Input
              {...c}
              className="font-mono"
              placeholder="/email"
              spellCheck={false}
              autoCapitalize="off"
              disabled={disabled}
              value={value.holderEmailField}
              onChange={(e) => set('holderEmailField', e.target.value)}
            />
          )}
        </FormField>
        <FormField label="When a record is missing">
          {(c) => (
            <Select
              {...c}
              disabled={disabled}
              value={value.onMissing}
              onValueChange={(v) => set('onMissing', v as Lifecycle['onMissing'])}
              options={[
                { value: 'keep', label: 'Keep the pass' },
                { value: 'flag', label: 'Flag the pass' },
                { value: 'void', label: 'Void the pass' },
              ]}
            />
          )}
        </FormField>
      </div>
      <div className="flex flex-col gap-2">
        {bool('Create passes for new records', 'autoCreate')}
        {bool('Email new passes', 'autoEmail', 'Off by default so a first sync cannot mass-email.')}
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
