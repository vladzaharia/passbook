import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { BundleDto } from '@/shared/contracts/bundles.ts';
import { strictEmail } from '@/shared/email.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { errorMessage, isApiError } from '../../lib/errors.ts';
import { Scan } from '../../portal/add/scan.tsx';
import {
  Buddy,
  Button,
  Callout,
  CopyButton,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  toast,
  useFormErrors,
} from '../../ui/index.ts';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import '../../portal/add/add.css';
import { useCreateBundle } from './bundle-api.ts';
import { absoluteUrl } from './format.ts';

const plural = (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`;

function validate(name: string, email: string): Record<string, string> {
  const found: Record<string, string> = {};
  if (!name.trim()) found.name = 'Required.';
  if (email.trim() && !strictEmail(email)) found.email = 'Enter a valid email address.';
  return found;
}

/**
 * The link on the shared QR sign, with Copy. In Test mode nothing was sent: the mail sits in the
 * Test inbox.
 */
function Result({ bundle, emailed }: { bundle: BundleDto; emailed: boolean }) {
  const url = absoluteUrl(bundle.url);
  const test = bundle.mode === 'test';
  return (
    <div className="wl-rise flex min-w-0 flex-col gap-4">
      <Callout tone="success" title="Bundle ready">
        <span className="flex flex-wrap items-center gap-x-2">
          {emailed
            ? test
              ? 'Link captured in the Test inbox.'
              : `Link emailed to ${bundle.holderEmail}.`
            : `${plural(bundle.passes.length)} in one link.`}
          {emailed && test ? (
            <Link to="/admin/test-inbox" className="underline-offset-2 hover:underline">
              Open Test inbox
            </Link>
          ) : null}
          <ModePill mode={bundle.mode} />
        </span>
      </Callout>
      <Scan url={url} label={`QR code for ${bundle.name}`} buddy={(p) => <Buddy {...p} />}>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-sunken py-1 pr-1 pl-3">
          <span
            data-autofocus
            tabIndex={-1}
            className="min-w-0 flex-1 truncate font-mono text-xs text-fg outline-none"
          >
            {url}
          </span>
          <CopyButton value={url} label="Copy link" />
        </div>
      </Scan>
    </div>
  );
}

/**
 * Share as bundle: names the selected passes' bundle, optionally emails it, then shows the link
 * with its QR. One to ten passes of one org (the selection bar checks).
 */
export function BundleDialog({
  open,
  onOpenChange,
  orgId,
  passIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  passIds: string[];
  onDone: () => void;
}) {
  const create = useCreateBundle();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [made, setMade] = useState<{ bundle: BundleDto; emailed: boolean } | null>(null);
  const check = useFormErrors(validate(name, email));
  const errors = { ...serverErrors, ...check.errors };

  function close() {
    const finished = made !== null;
    onOpenChange(false);
    setName('');
    setEmail('');
    setMade(null);
    setServerErrors({});
    setFormError(undefined);
    check.reset();
    if (finished) onDone();
  }

  async function submit() {
    setFormError(undefined);
    const address = email.trim();
    try {
      const bundle = await create.mutateAsync({
        orgId,
        passIds,
        name: name.trim(),
        ...(address ? { holderEmail: address, sendEmail: true } : {}),
      });
      setMade({ bundle, emailed: Boolean(address) });
      if (address && bundle.mode !== 'test') toast.sent(`Link emailed to ${address}`);
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServerErrors(cause.fields);
      setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      dirty={made === null && (name.trim() !== '' || email.trim() !== '')}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title={made ? made.bundle.name : 'Share as bundle'}
        description={made ? undefined : `${plural(passIds.length)} behind one link.`}
        footer={
          made ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="new-bundle"
                loading={create.isPending}
                iconStart={email.trim() ? <ACTION_ICON.sendEmail aria-hidden /> : undefined}
              >
                {email.trim() ? 'Create and email' : 'Create link'}
              </Button>
            </>
          )
        }
      >
        {made ? (
          <Result bundle={made.bundle} emailed={made.emailed} />
        ) : (
          <Form
            id="new-bundle"
            className="flex flex-col gap-4"
            {...check.form}
            onValid={() => void submit()}
          >
            <FormField label="Name" required error={errors.name}>
              {(p) => (
                <Input
                  {...p}
                  data-autofocus
                  autoComplete="off"
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setServerErrors(({ name: _gone, ...rest }) => rest);
                  }}
                />
              )}
            </FormField>
            <FormField label="Email" error={errors.email} help="Optional. Sends the link.">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </FormField>
            {formError ? <p className="text-sm text-danger">{formError}</p> : null}
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
