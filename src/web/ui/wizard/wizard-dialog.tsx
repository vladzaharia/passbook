import { type ReactElement, type ReactNode, useEffect, useRef } from 'react';
import { Dialog, DialogContent } from '../dialog.tsx';
import { Form } from '../form.tsx';
import type { WizardModel } from './use-wizard.ts';
import { WizardActions } from './wizard-actions.tsx';
import { type WizardResultProps, WizardResultTitle } from './wizard-result.tsx';
import { WizardStep } from './wizard-step.tsx';
import { WizardStepper } from './wizard-stepper.tsx';

export interface WizardDialogProps<Id extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Constant: it names the job, and the dialog, on every step. */
  title: string;
  wizard: WizardModel<Id>;
  /** Unsaved input: Esc, an outside click and the X ask first. Cancel discards at once. */
  dirty?: boolean;
  /** A verb and a noun: "Create key". */
  finishLabel: string;
  /** The finish is hard to take back. */
  finishTone?: 'danger';
  busy?: boolean;
  /** Runs on every close, after the wizard has reset. */
  onClose?: () => void;
  /**
   * What the finish handed back. The dialog narrows to md, takes the result's title, drops the X,
   * and ignores Esc and outside clicks until the result's own Done.
   */
  result?: ReactElement<WizardResultProps>;
  /** The current step's body. */
  children: ReactNode;
}

/**
 * The wizard in an xl dialog: steps on a rail beside the step (compact above it when the frame is
 * narrow), a footer of Cancel, Back and Next, and a result in place of the steps when one arrives.
 */
export function WizardDialog<Id extends string>({
  open,
  onOpenChange,
  title,
  wizard,
  dirty,
  finishLabel,
  finishTone,
  busy,
  onClose,
  result,
  children,
}: WizardDialogProps<Id>) {
  const heading = useRef<HTMLSpanElement>(null);
  const showing = Boolean(result);
  const working = Boolean(busy) || wizard.finishing;
  useEffect(() => {
    if (showing) heading.current?.focus({ preventScroll: true });
  }, [showing]);
  function close() {
    onOpenChange(false);
    wizard.reset();
    onClose?.();
  }
  if (result) {
    return (
      <Dialog open={open} onOpenChange={() => undefined}>
        <DialogContent
          size="md"
          closeButton={false}
          title={
            <span ref={heading} tabIndex={-1} className="outline-none">
              <WizardResultTitle title={result.props.title} icon={result.props.icon} />
            </span>
          }
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {result}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Dialog
      open={open}
      dirty={dirty}
      onOpenChange={(o) => (o ? onOpenChange(true) : working ? undefined : close())}
    >
      <DialogContent
        size="xl"
        title={title}
        footer={
          <WizardActions
            wizard={wizard}
            finishLabel={finishLabel}
            {...(finishTone ? { finishTone } : {})}
            busy={Boolean(busy)}
            onCancel={close}
          />
        }
      >
        <div className="@container">
          <div className="flex flex-col gap-5 @[43.5rem]:flex-row @[43.5rem]:gap-8">
            <div className="@[43.5rem]:sticky @[43.5rem]:top-0 @[43.5rem]:self-start">
              <WizardStepper wizard={wizard} />
            </div>
            <Form {...wizard.form} className="@container min-w-0 flex-1 @[43.5rem]:min-h-[24rem]">
              {/* Enter in a field presses this; the footer button sits outside the form. */}
              <button type="submit" hidden tabIndex={-1} aria-hidden />
              <WizardStep wizard={wizard}>{children}</WizardStep>
            </Form>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
