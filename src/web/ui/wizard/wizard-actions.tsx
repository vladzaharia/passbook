import { useId } from 'react';
import { Button } from '../button.tsx';
import type { WizardModel } from './wizard-types.ts';

/**
 * Cancel (ghost, pushed left) and the hint while Next is blocked, then Back and the primary.
 * Under 640 only Back and the primary show, one row of equal buttons, unless `keepCancel` (a page
 * has no X). Next is never hard-disabled for an incomplete step: it carries `aria-disabled` and its
 * hint, and a press shows the errors. `busy` is the only hard-disabled state.
 */
export function WizardButtons({
  first,
  label,
  tone,
  blocked,
  hint,
  working,
  formId,
  keepCancel,
  onCancel,
  onBack,
  onNext,
  onBlocked,
}: {
  first: boolean;
  label: string;
  tone?: 'danger' | undefined;
  blocked?: boolean | undefined;
  hint?: string | undefined;
  working?: boolean | undefined;
  /** The primary submits this form. */
  formId?: string | undefined;
  keepCancel?: boolean;
  onCancel: () => void;
  onBack?: (() => void) | undefined;
  /** Without formId. */
  onNext?: (() => void) | undefined;
  /** A press while blocked runs this instead of submitting or calling onNext. */
  onBlocked?: (() => void) | undefined;
}) {
  const hintId = useId();
  const why = blocked && hint ? hint : undefined;
  return (
    <>
      <Button
        variant="ghost"
        disabled={working}
        className={keepCancel ? 'mr-auto max-sm:order-2 max-sm:w-full' : 'max-sm:hidden sm:mr-auto'}
        onClick={onCancel}
      >
        Cancel
      </Button>
      {why ? (
        <span id={hintId} className="self-center text-xs text-fg-muted max-sm:hidden">
          {why}
        </span>
      ) : null}
      <div className="flex gap-2 max-sm:min-w-0 max-sm:flex-1 max-sm:basis-full max-sm:[&>*]:min-w-0 max-sm:[&>*]:flex-1 max-sm:[&>*]:whitespace-normal max-sm:[&>*]:leading-tight">
        {first ? null : (
          <Button variant="outline" disabled={working} onClick={onBack}>
            Back
          </Button>
        )}
        <Button
          type={formId ? 'submit' : 'button'}
          form={formId}
          variant={tone}
          loading={working}
          aria-disabled={blocked || undefined}
          aria-describedby={why ? hintId : undefined}
          onClick={(event) => {
            if (blocked && onBlocked) {
              event.preventDefault();
              onBlocked();
            } else if (!formId) onNext?.();
          }}
        >
          {label}
        </Button>
      </div>
    </>
  );
}

/** The dialog footer: the model's buttons, labelled by `primary`. */
export function WizardActions<Id extends string>({
  wizard,
  finishLabel,
  finishTone,
  busy,
  onCancel,
}: {
  wizard: WizardModel<Id>;
  /** A verb and a noun ("Create key"); in edit mode "Save" or "Save and resume". */
  finishLabel: string;
  /** The finish is hard to take back. */
  finishTone?: 'danger';
  busy?: boolean;
  onCancel: () => void;
}) {
  const label =
    wizard.primary === 'finish' ? finishLabel : wizard.primary === 'review' ? 'Review' : 'Next';
  return (
    <WizardButtons
      first={wizard.first}
      label={label}
      tone={wizard.primary === 'finish' ? finishTone : undefined}
      blocked={wizard.blocked}
      hint={wizard.hint}
      working={Boolean(busy) || wizard.finishing}
      formId={wizard.form.id}
      onCancel={onCancel}
      onBack={wizard.back}
    />
  );
}
