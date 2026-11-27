import { type FormEvent, type ReactNode, useId, useState } from 'react';
import type { OverlapHours } from '@/shared/contracts/webhook-secrets.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Callout } from '../callout.tsx';
import { RadioGroup } from '../radio-group.tsx';
import { SecretReveal } from '../secret-reveal.tsx';

export const OVERLAP_CHOICES = [
  { value: '0', label: 'Now' },
  { value: '1', label: '1 hour' },
  { value: '24', label: '24 hours' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
] as const satisfies readonly { value: `${OverlapHours}`; label: string }[];

/**
 * The state of a rotation: the overlap chosen, the call in flight, the new secret (shown once) or
 * the error. The wrapper (a dialog, the Workbench's sheet) owns the buttons: Rotate is a submit
 * button with `form={state.formId}`.
 */
export function useRotateSecret(
  rotate: (overlapHours: OverlapHours) => Promise<{ secret?: string | undefined }>,
) {
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [overlap, setOverlap] = useState<`${OverlapHours}`>('24');
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  async function submit() {
    setError(undefined);
    setBusy(true);
    try {
      setSecret((await rotate(Number(overlap) as OverlapHours)).secret);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return {
    formId,
    busy,
    overlap,
    setOverlap,
    secret,
    error,
    submit,
    reset() {
      setSecret(undefined);
      setError(undefined);
    },
  };
}
export type RotateSecretState = ReturnType<typeof useRotateSecret>;

/**
 * Rotate the signing secret. The old one keeps signing for the chosen time (each request carries a
 * signature per live secret), so receivers switch without a gap. The new one shows once.
 */
export function RotateSecretForm({
  state,
  onDone,
  choices = OVERLAP_CHOICES,
  extra,
}: {
  state: RotateSecretState;
  /** The new secret was saved: close the host. */
  onDone: () => void;
  /** The overlaps the receiver of the call accepts. */
  choices?: readonly (typeof OVERLAP_CHOICES)[number][];
  /** Above the overlap: a field to paste the new secret into. */
  extra?: ReactNode;
}) {
  if (state.secret)
    return (
      <SecretReveal
        fields={[
          { label: 'Signing secret', value: state.secret, copyLabel: 'Copy signing secret' },
        ]}
        onDone={onDone}
      />
    );
  return (
    <form
      id={state.formId}
      className="flex flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void state.submit();
      }}
    >
      {state.error ? <Callout tone="danger">{state.error}</Callout> : null}
      {extra}
      <RadioGroup
        legend="Keep the old secret for"
        orientation="horizontal"
        options={choices}
        value={state.overlap}
        onValueChange={(v) => state.setOverlap(choices.find((o) => o.value === v)?.value ?? '24')}
      />
      <p className="text-xs text-fg-muted">
        {state.overlap === '0'
          ? 'The old secret stops working now. Update your receiver first.'
          : 'Both secrets sign each request until the old one expires. If it leaked, choose Now.'}
      </p>
    </form>
  );
}
