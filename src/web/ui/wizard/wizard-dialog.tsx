import type { ReactNode } from 'react';
import { Dialog, DialogContent } from '../dialog.tsx';
import { useOnClose } from '../dialog-close.ts';
import { Form } from '../form.tsx';
import { WizardActions } from './wizard-actions.tsx';
import { ResultDialogContent, type ResultSpec } from './wizard-result.tsx';
import { WizardStep } from './wizard-step.tsx';
import { WizardStepper } from './wizard-stepper.tsx';
import type { WizardModel } from './wizard-types.ts';

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
  /** At the top of the current step: a warning Callout (a stale revision). */
  notice?: ReactNode;
  /** Runs each time the dialog closes, however it closed. */
  onClose?: () => void;
  /**
   * What the finish handed back. The dialog narrows to md, takes the result's title, drops the X,
   * and ignores Esc and outside clicks until the body's own Done.
   */
  result?: ResultSpec | undefined;
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
  notice,
  onClose,
  result,
  children,
}: WizardDialogProps<Id>) {
  const working = Boolean(busy) || wizard.finishing;
  const afterClose = useOnClose(open, onClose);
  if (result) {
    return (
      <Dialog open={open} onOpenChange={() => undefined}>
        <ResultDialogContent result={result} onCloseAutoFocus={afterClose} />
      </Dialog>
    );
  }
  const close = () => onOpenChange(false);
  return (
    <Dialog
      open={open}
      dirty={dirty}
      onOpenChange={(o) => (o ? onOpenChange(true) : working ? undefined : close())}
    >
      <DialogContent
        size="xl"
        title={title}
        onCloseAutoFocus={afterClose}
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
            {/* Enter in a field presses the footer's Next: it is the form's default button. */}
            <Form {...wizard.form} className="@container min-w-0 flex-1 @[43.5rem]:min-h-[24rem]">
              <WizardStep wizard={wizard} notice={notice}>
                {children}
              </WizardStep>
            </Form>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
