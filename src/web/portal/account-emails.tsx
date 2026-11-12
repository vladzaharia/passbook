import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { strictEmail } from '@/shared/email.ts';
import { errorMessage } from '../lib/errors.ts';
import { removeWithTransition } from '../lib/motion.ts';
import { sessionQuery, useInvalidateSession } from '../lib/session.ts';
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

type Confirm = { kind: 'remove' | 'primary'; email: string } | null;

/** Emails on the account (kit EmailList). Pending addresses live in this tab only. */
export function EmailsSection({
  focusAdd = false,
  userId,
}: {
  focusAdd?: boolean;
  userId: string | undefined;
}) {
  const client = useQueryClient();
  const isCurrentPrincipal = useCallback(
    (expected: string | undefined) => {
      const state = client.getQueryState(sessionQuery.queryKey);
      return (
        expected !== undefined &&
        state?.status === 'success' &&
        state.data?.authenticated === true &&
        state.data.user.id === expected
      );
    },
    [client],
  );
  const invalidateSession = useInvalidateSession();
  const pending = usePendingEmails(userId);
  const query = useQuery({
    ...myEmailsQuery,
    // A pending address flips to verified when the user comes back from the email.
    refetchOnWindowFocus: pending.list.length ? 'always' : false,
  });
  const [addError, setAddError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const root = useRef<HTMLDivElement>(null);
  const listedAll = query.data?.items ?? [];
  const verified = listedAll.filter((v) => v.verifiedAt !== null);

  // Drop pending rows once the server lists them as verified (the pill fades with the swap).
  const { list, drop } = pending;
  const listed = query.data?.items;
  useEffect(() => {
    const done = list.filter((e) => listed?.some((v) => v.email === e && v.verifiedAt !== null));
    if (done.length && isCurrentPrincipal(userId)) {
      removeWithTransition(() => {
        if (isCurrentPrincipal(userId)) drop(done);
      });
    }
  }, [list, listed, drop, userId, isCurrentPrincipal]);

  useEffect(() => {
    if (!focusAdd || !query.data) return;
    root.current?.querySelector<HTMLInputElement>('input[type="email"]')?.focus();
  }, [focusAdd, query.data]);

  const send = useMutation({
    mutationFn: (request: { email: string; userId: string }) => addEmail(request.email),
    onMutate: (request) => {
      if (isCurrentPrincipal(request.userId)) setBusy(request.email);
    },
    onSettled: (_data, _error, request) => {
      if (isCurrentPrincipal(request.userId)) setBusy(undefined);
    },
  });

  /** EmailList has checked the format; false keeps a refused address in the field. */
  async function add(raw: string): Promise<boolean> {
    if (!userId || !isCurrentPrincipal(userId)) return false;
    setAddError(undefined);
    const email = strictEmail(raw) ?? raw;
    if (verified.some((v) => v.email === email)) {
      setAddError('That email is already on your account.');
      return false;
    }
    try {
      await send.mutateAsync({ email, userId });
      if (!isCurrentPrincipal(userId)) return false;
      pending.add(email);
      return true;
    } catch (error) {
      if (isCurrentPrincipal(userId)) setAddError(errorMessage(error));
      return false;
    }
  }

  async function resend(email: string) {
    if (!userId || !isCurrentPrincipal(userId)) return;
    try {
      const again = pending.list.includes(email);
      await send.mutateAsync({ email, userId });
      if (!isCurrentPrincipal(userId)) return;
      pending.add(email);
      if (again) toast.success('Sent again');
    } catch (error) {
      if (isCurrentPrincipal(userId)) toast.error(error, 'Could not send');
    }
  }

  const items = [
    ...listedAll.map((v) => ({
      email: v.email,
      primary: v.primary,
      verified: v.verifiedAt !== null,
      pending: v.verifiedAt === null && pending.list.includes(v.email),
    })),
    ...pending.list
      .filter((e) => !listedAll.some((v) => v.email === e))
      .map((email) => ({ email, primary: false, verified: false, pending: true })),
  ];

  return (
    <Card>
      <CardHeader title="Email addresses" />
      <CardBody>
        <div ref={root} className="wl-account-emails">
          {query.isPending ? <SkeletonRows rows={2} /> : null}
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : null}
          {query.data ? (
            <EmailList
              items={items}
              onAdd={add}
              onResend={(email) => void resend(email)}
              onCancelPending={(email) =>
                removeWithTransition(() => {
                  if (isCurrentPrincipal(userId)) pending.drop([email]);
                })
              }
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
        description={`${confirm?.email ?? ''}. Passes already assigned to you may remain in your collection.`}
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!confirm || !userId || !isCurrentPrincipal(userId)) return;
          await removeEmail(confirm.email);
          if (!isCurrentPrincipal(userId)) return;
          const next = await fetchMyEmails();
          if (!isCurrentPrincipal(userId)) return;
          removeWithTransition(() => {
            if (isCurrentPrincipal(userId)) client.setQueryData(myEmailsKey, next);
          });
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
          if (!confirm || !userId || !isCurrentPrincipal(userId)) return;
          const next = await makePrimaryEmail(confirm.email);
          if (!isCurrentPrincipal(userId)) return;
          client.setQueryData(myEmailsKey, next);
          await invalidateSession();
          if (isCurrentPrincipal(userId)) toast.success('Primary email changed');
        }}
      />
    </Card>
  );
}
