import { SegmentedControl } from '@/web/ui/index.ts';
import { IpChips } from './ip-chips.tsx';
import type { KeyForm } from './use-key-form.ts';

const MODES = [
  { value: 'live', label: 'Live' },
  { value: 'test', label: 'Test' },
] as const;

/** Allowed IPs, and the key's mode: chosen for a platform key, the console's for an organization's. */
export function StepLimits({
  form,
  orgId,
  errors,
}: {
  form: KeyForm;
  orgId: string | null;
  errors: Record<string, string | undefined>;
}) {
  return (
    <>
      <IpChips
        value={form.ips}
        onChange={form.setIps}
        draft={form.draft}
        onDraft={form.setDraft}
        required={orgId === null}
        error={errors.ipAllow ?? (form.draft ? form.errors.limits?.ipAllow : undefined)}
      />
      {orgId === null ? (
        <div className="flex flex-col">
          <p className="mb-2 text-sm font-medium text-fg">Mode</p>
          <SegmentedControl
            label="Mode"
            options={MODES}
            value={form.keyMode}
            onValueChange={form.changeMode}
          />
          {errors.mode ? <p className="mt-1 text-xs text-danger">{errors.mode}</p> : null}
        </div>
      ) : (
        <div>
          <p className="text-sm font-medium text-fg">Mode</p>
          <p className="mt-2 text-sm text-fg-strong">{form.keyMode === 'test' ? 'Test' : 'Live'}</p>
          <p className="mt-1 text-xs text-fg-muted">
            {form.cap
              ? 'Test passes. Their emails stay in the Test inbox.'
              : form.keyMode === 'test'
                ? 'Test passes. Their emails stay in the Test inbox. Switch the console to Live for a Live key.'
                : 'Real passes and real emails. Switch the console to Test for a Test key.'}
          </p>
        </div>
      )}
    </>
  );
}
