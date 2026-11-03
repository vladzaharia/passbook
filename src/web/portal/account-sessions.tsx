import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { MySessionListSchema } from '@/shared/contracts/me.ts';
import { prefersReducedMotion, removeWithTransition } from '../lib/motion.ts';
import { endSession, leaveSignedOut, useSession } from '../lib/session.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  SessionList,
  SkeletonRows,
  toast,
} from '../ui/index.ts';
import { mySessionsKey, mySessionsQuery, revokeSession } from './api.ts';

type Sessions = z.infer<typeof MySessionListSchema>;

/** Signed-in devices (kit SessionList). Revoked rows leave through a view transition. */
export function SessionsSection() {
  const client = useQueryClient();
  const { authed } = useSession();
  const query = useQuery(mySessionsQuery);
  const [confirmAll, setConfirmAll] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const revoke = useMutation({
    mutationFn: revokeSession,
    onSuccess: (_res, id) => {
      removeWithTransition(() =>
        client.setQueryData<Sessions>(mySessionsKey, (old) =>
          old ? { ...old, items: old.items.filter((s) => s.id !== id) } : old,
        ),
      );
      toast.success('Session revoked');
    },
    onError: (e) => toast.error(e, 'Revoke failed'),
  });

  // The other rows leave 30 ms apart, then the browser signs out (at most 320 ms of motion).
  function signOutEverywhere(target: string) {
    const others = query.data?.items.filter((s) => !s.current).length ?? 0;
    setLeaving(true);
    const wait = prefersReducedMotion() ? 0 : Math.min(160 + Math.min(others, 6) * 30, 320);
    setTimeout(() => leaveSignedOut(target), wait);
  }

  return (
    <Card>
      <CardHeader
        title="Sessions"
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconStart={<LogOut aria-hidden />}
            onClick={() => setConfirmAll(true)}
          >
            Sign out everywhere
          </Button>
        }
      />
      <CardBody>
        {query.isPending ? <SkeletonRows rows={2} /> : null}
        {query.isError ? (
          <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? (
          <div className="wl-sessions" data-leaving={leaving || undefined}>
            <SessionList
              items={query.data.items}
              onRevoke={(id) => revoke.mutate(id)}
              {...(revoke.isPending && revoke.variables ? { revoking: revoke.variables } : {})}
            />
          </div>
        ) : null}
      </CardBody>
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out everywhere?"
        description="Every session, including this one, ends."
        confirmLabel="Sign out"
        destructive
        onConfirm={async () => {
          // One call ends every session and leaves through Pocket ID like a single sign-out.
          signOutEverywhere(await endSession(authed?.csrfToken, { everywhere: true }));
        }}
      />
    </Card>
  );
}
