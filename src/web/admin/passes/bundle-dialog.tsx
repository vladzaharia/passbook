import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { BundleDto } from '@/shared/contracts/bundles.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { strictEmail } from '@/shared/email.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { errorMessage, isApiError } from '../../lib/errors.ts';
import { sessionQuery } from '../../lib/session.ts';
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

/** The created link, with the email request beside it. */
function Result({ bundle, emailRequested }: { bundle: BundleDto; emailRequested: string | null }) {
  const url = absoluteUrl(bundle.url);
  const test = bundle.mode === 'test';
  return (
    <div className="wl-rise flex min-w-0 flex-col gap-4">
      <Callout tone="success" title="Bundle created">
        <span className="flex flex-wrap items-center gap-x-2">
          {plural(bundle.passes.length)} in one link.
          <ModePill mode={bundle.mode} />
        </span>
      </Callout>
      {emailRequested ? (
        <Callout tone="success" title={`Email requested for ${emailRequested}.`}>
          {test ? (
            <Link to="/admin/test-inbox" className="underline-offset-2 hover:underline">
              Open Test inbox
            </Link>
          ) : null}
        </Callout>
      ) : null}
      <Scan
        url={url}
        label={`QR code for ${bundle.name}`}
        buddy={emailRequested ? undefined : (p) => <Buddy {...p} />}
      >
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
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [made, setMade] = useState<{ bundle: BundleDto; emailRequested: string | null } | null>(
    null,
  );
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
    const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!before?.authenticated) return;
    const userId = before.user.id;
    setFormError(undefined);
    const address = email.trim();
    try {
      const bundle = await create.mutateAsync({
        orgId,
        passIds,
        name: name.trim(),
        ...(address ? { holderEmail: address, sendEmail: true } : {}),
      });
      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      if (!current?.authenticated || current.user.id !== userId) return;
      setMade({ bundle, emailRequested: address || null });
    } catch (cause) {
      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      if (!current?.authenticated || current.user.id !== userId) return;
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
          <Result bundle={made.bundle} emailRequested={made.emailRequested} />
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
            <FormField
              label="Email"
              error={errors.email}
              help="Optional. Requests an email with the link."
            >
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
