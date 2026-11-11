import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { ScanOutcomeSchema } from '@/shared/contracts/scan.ts';
import type { ScanRecordDto } from '@/shared/contracts/scanners.ts';
import { TemplateReleaseListSchema } from '@/shared/contracts/template-releases.ts';
import { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { api } from '@/web/lib/api.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { scanId } from '@/web/scan/platform/id.ts';
import {
  Button,
  ConfirmDialog,
  KeyValue,
  Sheet,
  SheetContent,
  StatusPill,
  TechnicalDetails,
} from '@/web/ui/index.ts';

export function ScanDetail({
  row,
  orgId,
  mode,
  canOperate,
  onClose,
}: {
  row: ScanRecordDto;
  orgId: string;
  mode: Mode;
  canOperate: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const undo = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/scans/${encodeURIComponent(row.id)}/undo`, ScanOutcomeSchema, {
        idempotencyKey: scanId(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'scanning'] });
      onClose();
    },
  });
  const canUndo = canOperate && !row.undoneAt && row.kind === 'check_in' && row.outcome === 'ok';
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent title="Scan" className="sm:w-[440px]">
          <div className="flex flex-col gap-5 p-5">
            <h2 className="text-lg font-semibold">{row.passTitle ?? 'Pass details unavailable'}</h2>
            <StatusPill status={row.undoneAt ? 'undone' : row.outcome} />
            <KeyValue
              items={[
                { label: 'Time', value: formatDateTime(row.at) },
                { label: 'What', value: row.actionLabel ?? row.reason },
                {
                  label: 'Pass',
                  value: row.passId ? (
                    <a
                      className="text-accent-fg"
                      href={`/admin/passes/${encodeURIComponent(row.passId)}`}
                    >
                      {row.passTitle ?? row.passId}
                    </a>
                  ) : (
                    'Unavailable'
                  ),
                },
                { label: 'Template', value: row.templateName },
                { label: 'Event', value: row.eventName },
                { label: 'Scanner', value: row.scannerName ?? 'Admin console' },
                { label: 'Staff', value: row.staffName },
                { label: 'Approved by', value: row.approvedBy },
                { label: 'How', value: row.method },
                { label: 'Amount', value: row.amount },
                {
                  label: 'Before → after',
                  value:
                    row.before !== null || row.after !== null
                      ? `${JSON.stringify(row.before)} → ${JSON.stringify(row.after)}`
                      : null,
                },
                { label: 'Pass version at scan', value: row.passVersion },
                {
                  label: 'Current Apple Wallet release',
                  value: row.templateId ? (
                    <CurrentRelease templateId={row.templateId} orgId={orgId} mode={mode} />
                  ) : (
                    'Unavailable'
                  ),
                },
                { label: 'Override', value: row.override ? 'Yes' : 'No' },
                ...(row.undoneAt
                  ? [
                      {
                        label: 'Undone',
                        value: `${formatDateTime(row.undoneAt)} · ${row.undoneBy ?? 'Admin console'}`,
                      },
                    ]
                  : []),
              ]}
            />
            {row.templateId && row.passVersion !== null ? (
              <p className="text-xs text-fg-muted">
                Release status is current when loaded and is separate from the pass version recorded
                at the scan.
              </p>
            ) : null}
            <TechnicalDetails
              items={[
                { label: 'Reason', value: row.reason },
                { label: 'Scan ID', value: row.id },
              ]}
            />
            {canUndo ? (
              <Button variant="secondary" onClick={() => setConfirm(true)}>
                Undo check-in
              </Button>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={canUndo && confirm}
        onOpenChange={setConfirm}
        title="Undo check-in?"
        description="The pass can be checked in again."
        confirmLabel="Undo check-in"
        onConfirm={() => undo.mutateAsync().then(() => undefined)}
      />
    </>
  );
}

function CurrentRelease({
  templateId,
  orgId,
  mode,
}: {
  templateId: string;
  orgId: string;
  mode: Mode;
}) {
  const scope = useOrgScope();
  const allowed = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      scope.orgId === orgId &&
      scope.membership?.capabilities.includes('scanning:read') &&
      scope.membership.capabilities.includes('templates:read'),
  );
  const template = useQuery({
    queryKey: [
      'admin',
      'templates',
      'scan-release-template',
      allowed ? orgId : null,
      allowed ? templateId : null,
      mode,
    ],
    queryFn: ({ signal }) => {
      if (!allowed) throw new Error('Choose an authorized organization and template.');
      return api.get(`/api/v1/templates/${encodeURIComponent(templateId)}`, TemplateDetailSchema, {
        query: { orgId },
        signal,
      });
    },
    enabled: allowed,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const detail =
    allowed &&
    template.isFetchedAfterMount &&
    !template.isError &&
    !template.isFetching &&
    template.data?.id === templateId &&
    (template.data.orgId === orgId || template.data.orgId === null)
      ? template.data
      : undefined;
  const releases = useQuery({
    queryKey: [
      'admin',
      'templates',
      'current-template-release',
      detail ? orgId : null,
      detail ? templateId : null,
      mode,
      'apple',
    ],
    queryFn: ({ signal }) => {
      if (!allowed || !detail) throw new Error('Choose an authorized organization and template.');
      return api.get(
        `/api/v1/templates/${encodeURIComponent(templateId)}/releases`,
        TemplateReleaseListSchema,
        { query: { orgId, mode, provider: 'apple' }, signal },
      );
    },
    enabled: Boolean(detail),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  if (scope.isLoading) return 'Checking access…';
  if (!allowed) {
    return scope.orgId === orgId && !scope.membership?.capabilities.includes('templates:read')
      ? 'Unavailable — template access required'
      : 'Unavailable';
  }
  if (template.isFetching || template.isPending || !template.isFetchedAfterMount) return 'Loading…';
  if (template.isError) {
    return (
      <>
        Unavailable{' '}
        <Button variant="link" size="sm" onClick={() => void template.refetch()}>
          Retry
        </Button>
      </>
    );
  }
  if (!detail) return 'Unavailable';
  if (releases.isFetching || releases.isPending || !releases.isFetchedAfterMount) return 'Loading…';
  if (releases.isError) {
    return (
      <>
        Unavailable{' '}
        <Button variant="link" size="sm" onClick={() => void releases.refetch()}>
          Retry
        </Button>
      </>
    );
  }
  const active = releases.data?.active;
  if (!active) return 'No active approved release';
  if (
    active.templateId !== templateId ||
    active.mode !== mode ||
    active.provider !== 'apple' ||
    !active.version.trim() ||
    !(
      active.orgId === orgId ||
      (active.orgId === null &&
        detail.orgId === null &&
        detail.origin === 'baked' &&
        active.source === 'system')
    )
  ) {
    return 'Unavailable';
  }
  return `Active · ${active.version}`;
}
