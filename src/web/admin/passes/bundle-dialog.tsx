import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { BundleDto } from '@/shared/contracts/bundles.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { strictEmail } from '@/shared/email.ts';
import { ENTITY } from '../../lib/entities.ts';
import { sessionQuery } from '../../lib/session.ts';
import { Scan } from '../../portal/add/scan.tsx';
import {
  Buddy,
  Callout,
  CopyButton,
  FormDialog,
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
  const url = bundle.url ? absoluteUrl(bundle.url) : '';
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
      {bundle.passes[0] ? (
        <p className="text-sm">
          <Link
            to="/admin/passes/$passId"
            params={{ passId: bundle.passes[0].id }}
            search={{ tab: 'delivery' }}
            className="font-medium text-accent-fg underline-offset-4 hover:underline"
          >
            See this bundle on its first pass
          </Link>
        </p>
      ) : null}
      <Scan
        url={url}
        label={`QR code for ${bundle.name}`}
        buddy={emailRequested ? undefined : (p) => <Buddy {...p} />}
      >
        <div className="flex w-full min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-surface-sunken py-1 pr-1 pl-3">
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
  const [made, setMade] = useState<{ bundle: BundleDto; emailRequested: string | null } | null>(
    null,
  );
  const check = useFormErrors(validate(name, email));

  async function submit() {
    const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!before?.authenticated) return;
    const userId = before.user.id;
    const current = () => {
      const now = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      return now?.authenticated === true && now.user.id === userId;
    };
    const address = email.trim();
    try {
      const bundle = await create.mutateAsync({
        orgId,
        passIds,
        name: name.trim(),
        ...(address ? { holderEmail: address, sendEmail: true } : {}),
      });
      if (current()) setMade({ bundle, emailRequested: address || null });
    } catch (cause) {
      // A different person's session never sees this one's refusal.
      if (current()) throw cause;
    }
  }

  const done = () => {
    onOpenChange(false);
    onDone();
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Share as bundle"
      description={plural(passIds.length)}
      dirty={name.trim() !== '' || email.trim() !== ''}
      check={check}
      onSubmit={submit}
      submitLabel={email.trim() ? 'Create and email' : 'Create link'}
      busy={create.isPending}
      onClose={() => {
        setName('');
        setEmail('');
        setMade(null);
      }}
      result={
        made
          ? {
              title: made.bundle.name,
              icon: <ENTITY.bundle.icon aria-hidden />,
              body: <Result bundle={made.bundle} emailRequested={made.emailRequested} />,
              onDone: done,
            }
          : undefined
      }
    >
      {({ errors: server }) => (
        <>
          <FormField label="Name" required error={check.errors.name ?? server.name}>
            {(p) => (
              <Input
                {...p}
                name="name"
                data-autofocus
                autoComplete="off"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="Email"
            error={check.errors.email ?? server.email}
            help="Optional. Requests an email with the link."
          >
            {(p) => (
              <Input
                {...p}
                name="email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
