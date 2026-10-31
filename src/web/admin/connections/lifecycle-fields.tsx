import { FormField, Input, Select, Switch } from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';

export interface Lifecycle {
  mode: 'poll' | 'webhook' | 'hybrid' | 'manual' | 'snapshot';
  intervalSeconds: string;
  holderEmailField: string;
  defaultTemplateId: string;
  autoCreate: boolean;
  autoEmail: boolean;
  onMissing: 'keep' | 'flag' | 'void';
}

export const NO_TEMPLATE = '__none__';

export function lifecycleToPatch(l: Lifecycle) {
  const interval = l.intervalSeconds.trim() ? Number(l.intervalSeconds) : undefined;
  return {
    mode: l.mode,
    ...(interval !== undefined ? { intervalSeconds: interval } : {}),
    ...(l.holderEmailField.trim() ? { holderEmailField: l.holderEmailField.trim() } : {}),
    ...(l.defaultTemplateId ? { defaultTemplateId: l.defaultTemplateId } : {}),
    autoCreate: l.autoCreate,
    autoEmail: l.autoEmail,
    onMissing: l.onMissing,
  };
}

export function lifecycleError(l: Lifecycle): string | undefined {
  if (l.intervalSeconds.trim()) {
    const n = Number(l.intervalSeconds);
    if (!Number.isInteger(n) || n < 60)
      return 'Interval must be a whole number of at least 60 seconds.';
  }
  if (l.autoCreate && !l.defaultTemplateId) return 'Auto create needs a default template.';
  return undefined;
}

export function LifecycleFields({
  orgId,
  value,
  onChange,
  disabled,
  error,
}: {
  orgId: string;
  value: Lifecycle;
  onChange: (next: Lifecycle) => void;
  disabled?: boolean;
  error?: string | undefined;
}) {
  const templates = useTemplates({ orgId });
  const set = <K extends keyof Lifecycle>(key: K, v: Lifecycle[K]) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="grid max-w-xl gap-4">
      <FormField label="Mode">
        {(c) => (
          <Select
            {...c}
            disabled={disabled}
            value={value.mode}
            onValueChange={(v) => set('mode', v as Lifecycle['mode'])}
            options={[
              { value: 'poll', label: 'Poll' },
              { value: 'webhook', label: 'Webhook' },
              { value: 'hybrid', label: 'Hybrid' },
              { value: 'manual', label: 'Manual' },
              { value: 'snapshot', label: 'Snapshot' },
            ]}
          />
        )}
      </FormField>
      <FormField label="Interval (seconds)" help="Minimum 60.">
        {(c) => (
          <Input
            {...c}
            type="number"
            inputMode="numeric"
            disabled={disabled}
            value={value.intervalSeconds}
            onChange={(e) => set('intervalSeconds', e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Default template">
        {(c) => (
          <Select
            {...c}
            disabled={disabled}
            value={value.defaultTemplateId || NO_TEMPLATE}
            onValueChange={(v) => set('defaultTemplateId', v === NO_TEMPLATE ? '' : v)}
            options={[
              { value: NO_TEMPLATE, label: 'None' },
              ...(templates.data?.items ?? []).map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        )}
      </FormField>
      <FormField label="Holder email field" help="Upstream pointer for the holder email.">
        {(c) => (
          <Input
            {...c}
            disabled={disabled}
            value={value.holderEmailField}
            onChange={(e) => set('holderEmailField', e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Create passes for new records">
        {(c) => (
          <Switch
            id={c.id}
            disabled={disabled}
            checked={value.autoCreate}
            onCheckedChange={(v) => set('autoCreate', v)}
          />
        )}
      </FormField>
      <FormField label="Email new passes" help="Off by default so a first sync cannot mass-email.">
        {(c) => (
          <Switch
            id={c.id}
            disabled={disabled}
            checked={value.autoEmail}
            onCheckedChange={(v) => set('autoEmail', v)}
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
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
