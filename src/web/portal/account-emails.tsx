import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors.ts';
import { removeWithTransition } from '../lib/motion.ts';
import { useInvalidateSession } from '../lib/session.ts';
import {
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmailList,
  ErrorState,
  SkeletonRows,
  toast,
} from '../ui/index.ts';
import {
  addEmail,
  fetchMyEmails,
  makePrimaryEmail,
  myEmailsKey,
  myEmailsQuery,
  removeEmail,
} from './api.ts';
import { usePendingEmails } from './pending-emails.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Confirm = { kind: 'remove' | 'primary'; email: string } | null;

/** Emails on the account (kit EmailList). Pending addresses live in this tab only. */
export function EmailsSection({ focusAdd = false }: { focusAdd?: boolean }) {
  const client = useQueryClient();
  const invalidateSession = useInvalidateSession();
  const pending = usePendingEmails();
  const query = useQuery({
    ...myEmailsQuery,
    // A pending address flips to verified when the user comes back from the email.
    refetchOnWindowFocus: pending.list.length ? 'always' : false,
  });
  const [addError, setAddError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const root = useRef<HTMLDivElement>(null);
  const verified = query.data?.items ?? [];

  // Drop pending rows once the server lists them as verified (the pill fades with the swap).
  const { list, drop } = pending;
  useEffect(() => {
    const done = list.filter((e) => verified.some((v) => v.email === e));
    if (done.length) removeWithTransition(() => drop(done));
  }, [list, verified, drop]);

  useEffect(() => {
    if (!focusAdd || !query.data) return;
    root.current?.querySelector<HTMLInputElement>('input[type="email"]')?.focus();
  }, [focusAdd, query.data]);

  const send = useMutation({
    mutationFn: (email: string) => addEmail(email),
    onMutate: (email) => setBusy(email),
    onSettled: () => setBusy(undefined),
  });

  async function add(raw: string) {
    setAddError(undefined);
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return setAddError('Enter a valid email.');
    if (verified.some((v) => v.email === email)) {
      return setAddError('That email is already on your account.');
    }
    try {
      await send.mutateAsync(email);
      pending.add(email);
    } catch (error) {
      setAddError(errorMessage(error));
    }
  }

  async function resend(email: string) {
    try {
      await send.mutateAsync(email);
      toast.success('Sent again');
    } catch (error) {
      toast.error(error, 'Could not send');
    }
  }

  const items = [
    ...verified.map((v) => ({
      email: v.email,
      primary: v.primary,
      verified: v.verifiedAt !== null,
      pending: false,
    })),
    ...pending.list
      .filter((e) => !verified.some((v) => v.email === e))
      .map((email) => ({ email, primary: false, verified: false, pending: true })),
  ];

  return (
    <Card>
      <CardHeader title="Emails" />
      <CardBody>
        <div ref={root} className="wl-account-emails">
          {query.isPending ? <SkeletonRows rows={2} /> : null}
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : null}
          {query.data ? (
            <EmailList
              items={items}
              onAdd={(email) => void add(email)}
              onResend={(email) => void resend(email)}
              onCancelPending={(email) => removeWithTransition(() => pending.drop([email]))}
              onRemove={(email) => setConfirm({ kind: 'remove', email })}
              onMakePrimary={(email) => setConfirm({ kind: 'primary', email })}
              busyEmail={busy}
              addError={addError}
            />
          ) : null}
        </div>
      </CardBody>
      <ConfirmDialog
        open={confirm?.kind === 'remove'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Remove email?"
        description={`Passes sent to ${confirm?.email ?? ''} stop showing here.`}
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!confirm) return;
          await removeEmail(confirm.email);
          const next = await fetchMyEmails();
          removeWithTransition(() => client.setQueryData(myEmailsKey, next));
          toast.success('Email removed');
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === 'primary'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Make primary?"
        description={`Sign-in emails go to ${confirm?.email ?? ''}.`}
        confirmLabel="Make primary"
        onConfirm={async () => {
          if (!confirm) return;
          const next = await makePrimaryEmail(confirm.email);
          client.setQueryData(myEmailsKey, next);
          await invalidateSession();
          toast.success('Primary email changed');
        }}
      />
    </Card>
  );
}
