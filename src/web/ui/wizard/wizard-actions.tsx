import { useId } from 'react';
import { Button } from '../button.tsx';
import type { WizardModel } from './use-wizard.ts';

/**
 * The dialog footer's buttons: Cancel (ghost, pushed left) and the hint while Next is blocked,
 * then Back and the primary. Under 640 only Back and the primary show, one row of equal buttons.
 * Next is never hard-disabled for an incomplete step: it carries `aria-disabled` and its hint, and
 * a press shows the errors. `busy` is the only hard-disabled state.
 */
export function WizardActions<Id extends string>({
  wizard,
  finishLabel,
  finishTone,
  busy,
  onCancel,
}: {
  wizard: WizardModel<Id>;
  /** A verb and a noun: "Create key". */
  finishLabel: string;
  /** The finish is hard to take back. */
  finishTone?: 'danger';
  busy?: boolean;
  onCancel: () => void;
}) {
  const hintId = useId();
  const working = Boolean(busy) || wizard.finishing;
  const label =
    wizard.primary === 'finish'
      ? wizard.mode === 'edit'
        ? 'Save'
        : finishLabel
      : wizard.primary === 'review'
        ? 'Review'
        : 'Next';
  return (
    <>
      <Button
        variant="ghost"
        disabled={working}
        className="max-sm:hidden sm:mr-auto"
        onClick={onCancel}
      >
        Cancel
      </Button>
      {wizard.blocked && wizard.hint ? (
        <span id={hintId} className="self-center text-xs text-fg-muted max-sm:hidden">
          {wizard.hint}
        </span>
      ) : null}
      <div className="flex gap-2 max-sm:[&>*]:flex-1">
        {wizard.first ? null : (
          <Button variant="outline" disabled={working} onClick={wizard.back}>
            Back
          </Button>
        )}
        <Button
          type="submit"
          form={wizard.form.id}
          variant={wizard.primary === 'finish' && finishTone === 'danger' ? 'danger' : undefined}
          loading={working}
          aria-disabled={wizard.blocked || undefined}
          aria-describedby={wizard.blocked && wizard.hint ? hintId : undefined}
        >
          {label}
        </Button>
      </div>
    </>
  );
}
