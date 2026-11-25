import { type ReactElement, type ReactNode, useEffect, useId, useState } from 'react';
import { errorMessage, isApiError } from '../lib/errors.ts';
import { Button } from './button.tsx';
import { Dialog, DialogContent } from './dialog.tsx';
import { Form, useServerFields } from './form.tsx';
import type { SaveResult } from './save-bar.tsx';
import { type WizardResultProps, WizardResultTitle } from './wizard/wizard-result.tsx';

/** What the dialog's body gets: the server's field errors, and a way to clear one as it is fixed. */
export interface FormDialogFields {
  errors: Record<string, string | undefined>;
  clear: (field?: string) => void;
}

export interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One sentence, only when the title cannot say it. */
  description?: string;
  /** sm, md or lg. Never xl: that is WizardDialog. */
  size?: 'sm' | 'md' | 'lg';
  /** Unsaved input: Esc, an outside click and the X ask first. Cancel discards at once. */
  dirty?: boolean;
  /** `useFormErrors(found)`: a refused submit shows its errors and reset hides them again. */
  check?: {
    form: { invalid: boolean; onInvalid: () => void };
    reset: () => void;
  };
  /** Throw the ApiError: its `fields` land under the fields, any other error on one line. */
  onSubmit: () => Promise<unknown> | unknown;
  /** A verb and a noun: "Place hold". */
  submitLabel: string;
  /** The submit is hard to take back. */
  submitTone?: 'danger';
  busy?: boolean;
  /** At the top of the body: a warning Callout (a stale revision). */
  notice?: ReactNode;
  /** Left of Cancel: a secondary action ("Email new link to holder"). */
  extra?: ReactNode;
  /** What the submit handed back, shown in place of the form (a bundle link, a rotated key). */
  result?: ReactElement<WizardResultProps>;
  /** False: no X, and Esc and outside clicks do nothing (a reveal in progress). */
  dismissible?: boolean;
  /** Runs on every close, after the errors reset: clear the draft here. */
  onClose?: () => void;
  children: ReactNode | ((fields: FormDialogFields) => ReactNode);
}

/**
 * The shell for one-form dialogs: Cancel and the primary in the footer (stacked on phones, the
 * primary on top), field errors under their fields, one line for the rest, a close that resets.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  dirty,
  check,
  onSubmit,
  submitLabel,
  submitTone,
  busy,
  notice,
  extra,
  result,
  dismissible = true,
  onClose,
  children,
}: FormDialogProps) {
  const id = useId();
  const server = useServerFields();
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const { reset: resetServer } = server;
  const resetCheck = check?.reset;
  const working = Boolean(busy) || pending;

  function close() {
    onOpenChange(false);
    onClose?.();
  }
  useEffect(() => {
    if (open) return;
    resetServer();
    resetCheck?.();
    setFormError(undefined);
  }, [open, resetServer, resetCheck]);

  async function submit(): Promise<SaveResult> {
    setFormError(undefined);
    server.reset();
    setPending(true);
    try {
      await onSubmit();
      return 'saved';
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) {
        server.set(cause.fields);
        return 'refused';
      }
      setFormError(errorMessage(cause));
      return 'failed';
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return (
      <Dialog open={open} onOpenChange={() => undefined}>
        <DialogContent
          size="md"
          closeButton={false}
          title={<WizardResultTitle title={result.props.title} icon={result.props.icon} />}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {result}
        </DialogContent>
      </Dialog>
    );
  }
  const body =
    typeof children === 'function'
      ? children({ errors: server.fields, clear: server.clear })
      : children;
  return (
    <Dialog
      open={open}
      dirty={dirty}
      onOpenChange={(o) => (o ? onOpenChange(true) : dismissible && !working ? close() : undefined)}
    >
      <DialogContent
        size={size}
        title={title}
        description={description}
        closeButton={dismissible}
        {...(dismissible
          ? {}
          : {
              onInteractOutside: (e: Event) => e.preventDefault(),
              onEscapeKeyDown: (e: Event) => e.preventDefault(),
            })}
        footer={
          <>
            {extra}
            <Button variant="outline" disabled={working} onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={id}
              variant={submitTone === 'danger' ? 'danger' : undefined}
              loading={working}
            >
              {submitLabel}
            </Button>
          </>
        }
      >
        <Form
          id={id}
          invalid={check?.form.invalid ?? false}
          {...(check ? { onInvalid: check.form.onInvalid } : {})}
          onValid={submit}
          className="flex flex-col gap-4"
        >
          {notice}
          {body}
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
