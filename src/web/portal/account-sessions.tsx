import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  SkeletonRows,
  StatusPill,
  toast,
} from '../ui/index.ts';
import { mySessionsKey, mySessionsQuery, revokeAllSessions, revokeSession } from './api.ts';
import { formatWhen } from './pass-view.ts';

/** Short device label from a user agent; the raw string is not useful in a list. */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  return [browser, os].filter(Boolean).join(' on ') || 'Unknown device';
}

export function SessionsSection({ onSignedOutEverywhere }: { onSignedOutEverywhere: () => void }) {
  const client = useQueryClient();
  const query = useQuery(mySessionsQuery);
  const [confirmAll, setConfirmAll] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: mySessionsKey });
  const revoke = useMutation({
    mutationFn: revokeSession,
    onSuccess: async () => {
      toast.success('Session revoked');
      await refresh();
    },
    onError: (e) => toast.error(e, 'Revoke failed'),
  });

  return (
    <Card>
      <CardHeader
        title="Sessions"
        actions={
          <Button variant="outline" size="sm" onClick={() => setConfirmAll(true)}>
            Sign out everywhere
          </Button>
        }
      />
      <CardBody>
        {query.isPending ? <SkeletonRows rows={2} /> : null}
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? (
          <ul className="divide-y divide-border">
            {query.data.items.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-fg-strong">
                    {deviceLabel(s.userAgent)}
                    {s.current ? <StatusPill status="this_device" /> : null}
                  </p>
                  <p className="text-xs text-fg-muted">
                    Last active {formatWhen(s.lastSeenAt)} · signed in {formatWhen(s.createdAt)}
                  </p>
                </div>
                {s.current ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Revoke ${deviceLabel(s.userAgent)} session`}
                    loading={revoke.isPending && revoke.variables === s.id}
                    onClick={() => revoke.mutate(s.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
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
          await revokeAllSessions();
          onSignedOutEverywhere();
        }}
      />
    </Card>
  );
}
