import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { z } from 'zod';
import type { OrgExportSchema } from '@/shared/contracts/org-lifecycle.ts';
import { formatShortDateIn } from '@/web/lib/format.ts';
import { Button, Card, CardBody, CardHeader, toast } from '@/web/ui/index.ts';
import type { Operation } from '@/web/ui/operation/index.ts';
import {
  AdminOperation,
  AdminOperations,
  useOrgOperation,
} from '../operations/admin-operation.tsx';
import { useExportLink, useExports, useStartExport } from './data-queries.ts';
import { useOrgTimeZone } from './use-org-time-zone.ts';

type OrgExport = z.infer<typeof OrgExportSchema>;

const megabytes = (bytes: number) =>
  bytes < 1_048_576
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1_048_576).toFixed(1)} MB`;

/** The newest archive that can still be downloaded. */
const ready = (items: readonly OrgExport[] | undefined, now: number) =>
  items?.find((e) => e.state === 'ready' && (e.expiresAt === null || e.expiresAt > now));

function DataCardBody({ orgId }: { orgId: string }) {
  const zone = useOrgTimeZone(orgId);
  const exports = useExports(orgId);
  const start = useStartExport(orgId);
  const link = useExportLink(orgId);
  const client = useQueryClient();
  const { id, show, clear } = useOrgOperation('org.export', orgId);
  const download = useCallback(
    (exportId: string) =>
      link.mutate(exportId, {
        onSuccess: (got) => window.location.assign(got.url),
        onError: (error) => toast.error(error, 'Could not get the link'),
      }),
    [link],
  );
  const exportOf = (op: Operation) => op.result?.ids.exportId ?? op.target?.id;
  const latest = ready(exports.data?.items, Date.now());
  return (
    <Card>
      <CardHeader title="Data" />
      <CardBody className="flex flex-col gap-4">
        {id ? (
          <AdminOperation
            id={id}
            orgId={orgId}
            framing="plain"
            onClose={clear}
            onGone={clear}
            onSucceeded={() => void client.invalidateQueries({ queryKey: ['org-exports', orgId] })}
            doneNote={(op) =>
              op.finishedAt !== null && latest?.expiresAt
                ? `The archive stays until ${formatShortDateIn(latest.expiresAt, zone)}.`
                : null
            }
            next={(op) => {
              const exportId = exportOf(op);
              return exportId
                ? { label: 'Download', onClick: () => download(exportId) }
                : undefined;
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              loading={start.isPending}
              onClick={() =>
                start.mutate(undefined, {
                  onSuccess: (started) => {
                    if (started.operationId) show(started.operationId);
                    else toast.success('Export started');
                  },
                  onError: (error) => toast.error(error, 'Could not start the export'),
                })
              }
            >
              Export data
            </Button>
            {latest ? (
              <>
                <Button
                  variant="ghost"
                  loading={link.isPending}
                  onClick={() => download(latest.id)}
                >
                  Download last export
                </Button>
                <span className="text-sm text-fg-muted">
                  {latest.bytes === null ? '' : `${megabytes(latest.bytes)} · `}
                  until{' '}
                  {latest.expiresAt === null ? '—' : formatShortDateIn(latest.expiresAt, zone)}
                </span>
              </>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Settings > Data: start an archive of everything the org holds, watch it, download it when it is done. */
export function DataCard({ orgId }: { orgId: string }) {
  return (
    <AdminOperations>
      <DataCardBody orgId={orgId} />
    </AdminOperations>
  );
}
