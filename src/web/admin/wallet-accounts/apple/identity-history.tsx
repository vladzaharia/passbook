import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type {
  IdentityCertificateSchema,
  IdentityRunSchema,
} from '@/shared/contracts/identities.ts';
import { formatDay } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  RelTime,
  StatusPill,
  TypedConfirmDialog,
  toast,
} from '@/web/ui/index.ts';
import {
  useIdentityCertificates,
  useIdentityRuns,
  useRevokeCertificate,
  useRunAction,
} from './managed-queries.ts';

type Run = z.infer<typeof IdentityRunSchema>;
type Cert = z.infer<typeof IdentityCertificateSchema>;

const RUN_PILL: Record<Run['state'], { status: string; label: string }> = {
  queued: { status: 'queued', label: 'Queued' },
  running: { status: 'running', label: 'Running' },
  waiting: { status: 'pending', label: 'Waiting' },
  succeeded: { status: 'complete', label: 'Done' },
  failed: { status: 'failed', label: 'Failed' },
  cancelled: { status: 'cancelled', label: 'Cancelled' },
};
const CERT_PILL: Record<Cert['state'], { status: string; label: string }> = {
  pending: { status: 'pending', label: 'Pending' },
  active: { status: 'verified', label: 'Active' },
  superseded: { status: 'disabled', label: 'Replaced' },
  revoked: { status: 'revoked', label: 'Revoked' },
  failed: { status: 'failed', label: 'Failed' },
};

function RunActions({ run, canCancel }: { run: Run; canCancel: boolean }) {
  const retry = useRunAction(run.id, 'retry');
  const cancel = useRunAction(run.id, 'cancel');
  const open = ['queued', 'running', 'waiting'].includes(run.state);
  const go = (m: typeof retry, done: string) =>
    m.mutate(undefined, {
      onSuccess: () => toast.success(done),
      onError: (e) => toast.error(e, 'Could not complete the action'),
    });
  if (open)
    return canCancel ? (
      <Button
        size="sm"
        variant="outline"
        loading={cancel.isPending}
        onClick={() => go(cancel, 'Run cancelled')}
      >
        Cancel
      </Button>
    ) : null;
  return run.state === 'failed' || run.state === 'cancelled' ? (
    <Button
      size="sm"
      variant="outline"
      loading={retry.isPending}
      onClick={() => go(retry, 'Run started')}
    >
      Retry
    </Button>
  ) : null;
}

/** Setup and renewal runs, newest first. */
export function RunsTable({
  orgId,
  targetId,
  canCancel,
}: {
  orgId?: string;
  targetId?: string;
  canCancel: boolean;
}) {
  const query = useIdentityRuns({ ...(orgId ? { orgId } : {}), ...(targetId ? { targetId } : {}) });
  const now = Date.now();
  const columns = useMemo<DataColumnDef<Run, never>[]>(
    () => [
      {
        header: 'Run',
        id: 'kind',
        cell: ({ row }) => (row.original.kind === 'provision' ? 'Setup' : 'Renewal'),
      },
      {
        header: 'Step',
        id: 'step',
        meta: { hideBelow: 'md' },
        cell: ({ row }) => row.original.step ?? '—',
      },
      {
        header: 'State',
        id: 'state',
        cell: ({ row }) => {
          const p = RUN_PILL[row.original.state];
          return (
            <span className="flex flex-col items-start gap-0.5">
              <StatusPill status={p.status}>{p.label}</StatusPill>
              {row.original.errorCode ? (
                <span className="font-mono text-xs text-fg-muted">{row.original.errorCode}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        header: 'Started',
        id: 'at',
        meta: { nowrap: true },
        cell: ({ row }) => <RelTime at={row.original.createdAt} now={now} />,
      },
      {
        header: () => <span className="sr-only">Actions</span>,
        id: 'actions',
        meta: { stackNoLabel: true },
        cell: ({ row }) => <RunActions run={row.original} canCancel={canCancel} />,
      },
    ],
    [canCancel, now],
  );
  if (query.isError)
    return <ErrorState subject="runs" error={query.error} onRetry={() => query.refetch()} />;
  return (
    <DataTable
      caption="Runs"
      bare
      loading={query.isPending}
      data={query.data?.items ?? []}
      getRowId={(r) => r.id}
      empty={<EmptyState inline art="certificate" title="No runs" />}
      columns={columns}
    />
  );
}

/** Certificate history, newest first. A replaced one can be revoked after a compromise. */
export function CertificatesTable({
  identityId,
  identifier,
  canRevoke,
}: {
  identityId: string;
  identifier: string;
  canRevoke: boolean;
}) {
  const query = useIdentityCertificates(identityId);
  const revoke = useRevokeCertificate(identityId);
  const [target, setTarget] = useState<Cert>();
  const columns = useMemo<DataColumnDef<Cert, never>[]>(
    () => [
      {
        header: 'State',
        id: 'state',
        cell: ({ row }) => {
          const p = CERT_PILL[row.original.state];
          return <StatusPill status={p.status}>{p.label}</StatusPill>;
        },
      },
      {
        header: 'Issued',
        id: 'issued',
        cell: ({ row }) => formatDay(row.original.notBefore ?? row.original.createdAt),
      },
      {
        header: 'Expires',
        id: 'expires',
        cell: ({ row }) => formatDay(row.original.notAfter, '—'),
      },
      {
        header: () => <span className="sr-only">Actions</span>,
        id: 'actions',
        meta: { stackNoLabel: true },
        cell: ({ row }) =>
          canRevoke && row.original.state === 'superseded' ? (
            <Button size="sm" variant="outline" onClick={() => setTarget(row.original)}>
              Revoke certificate
            </Button>
          ) : null,
      },
    ],
    [canRevoke],
  );
  if (query.isError)
    return (
      <ErrorState subject="certificates" error={query.error} onRetry={() => query.refetch()} />
    );
  return (
    <>
      <DataTable
        caption="Certificates"
        bare
        loading={query.isPending}
        data={query.data?.items ?? []}
        getRowId={(c) => c.id}
        empty={<EmptyState inline art="certificate" title="No certificates" />}
        columns={columns}
      />
      <TypedConfirmDialog
        open={target !== undefined}
        onOpenChange={(o) => !o && setTarget(undefined)}
        title="Revoke certificate"
        description="Passes signed with it stop validating on devices. This can't be undone."
        word={identifier}
        confirmLabel="Revoke certificate"
        onConfirm={async () => {
          if (!target) return;
          await revoke.mutateAsync({ certificateId: target.id, confirm: identifier });
          toast.success('Certificate revoked');
        }}
      />
    </>
  );
}

export function HistoryCards({
  identityId,
  identifier,
  canAdmin,
}: {
  identityId: string;
  identifier: string;
  canAdmin: boolean;
}) {
  return (
    <>
      <Card>
        <CardHeader title="Certificates" />
        <CardBody>
          <CertificatesTable identityId={identityId} identifier={identifier} canRevoke={canAdmin} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Runs" />
        <CardBody>
          <RunsTable targetId={identityId} canCancel={canAdmin} />
        </CardBody>
      </Card>
    </>
  );
}
