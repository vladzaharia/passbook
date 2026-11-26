import { ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import { formatCount } from '@/web/lib/format.ts';
import {
  FormDialog,
  FormField,
  KeyValue,
  Select,
  Skeleton,
  useFormErrors,
} from '@/web/ui/index.ts';
import { AdminOperation, AdminOperations } from '../../operations/admin-operation.tsx';
import { useOrgList } from '../../orgs/queries.ts';
import { platformName } from './platform-card.tsx';
import { KEPT_REASON } from './platform-moves.tsx';
import { type PlatformIdentity, useMovePreview, useStartMove } from './platform-queries.ts';

/**
 * Move an org's passes off an identity: pick the org, read the dry run (what moves, what stays and
 * why), start. The result is the operation, live; the section then lists the moves.
 */
export function MovePassesDialog({
  from,
  identities,
  onOpenChange,
  onStarted,
}: {
  from: PlatformIdentity | null;
  identities: readonly PlatformIdentity[];
  onOpenChange: (open: boolean) => void;
  onStarted: (orgId: string) => void;
}) {
  const orgs = useOrgList();
  const [orgId, setOrgId] = useState('');
  const [operationId, setOperationId] = useState<string>();
  const start = useStartMove();
  const request = from && orgId ? { orgId, fromIdentityId: from.id } : null;
  const preview = useMovePreview(request);
  const data = preview.data;
  const target = identities.find((i) => i.id === data?.toIdentityId);
  const check = useFormErrors({
    ...(orgId ? {} : { org: 'Choose an organization.' }),
    ...(data && data.passes === 0 ? { org: 'Nothing to move.' } : {}),
    ...(orgId && !data && !preview.isError ? { org: 'Reading the passes.' } : {}),
  });
  const kept = Object.entries(data?.kept ?? {}).filter(([, n]) => n > 0);
  return (
    <FormDialog
      open={from !== null}
      onOpenChange={onOpenChange}
      title={from ? `Move passes off ${platformName(from)}` : 'Move passes'}
      dirty={Boolean(orgId)}
      check={check}
      submitLabel="Move passes"
      busy={start.isPending}
      onSubmit={async () => {
        if (!request) return;
        const op = await start.mutateAsync(request);
        setOperationId(op.id);
        onStarted(orgId);
      }}
      onClose={() => {
        setOrgId('');
        setOperationId(undefined);
      }}
      result={
        operationId
          ? {
              title: 'Moving passes',
              icon: <ArrowRightLeft aria-hidden />,
              body: (
                <AdminOperations>
                  <AdminOperation id={operationId} orgId={orgId} framing="plain" buddy={false} />
                </AdminOperations>
              ),
              onDone: () => onOpenChange(false),
            }
          : undefined
      }
    >
      <FormField label="Organization" required error={check.errors.org}>
        {(p) => (
          <Select
            {...p}
            data-autofocus
            value={orgId}
            onValueChange={setOrgId}
            options={(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
          />
        )}
      </FormField>
      {orgId && preview.isPending ? <Skeleton className="h-24 w-full" /> : null}
      {preview.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not read the passes. Pick the organization again.
        </p>
      ) : null}
      {data ? (
        <div className="wl-rise flex flex-col gap-3" aria-live="polite">
          <KeyValue
            items={[
              ...(target ? [{ label: 'To', value: platformName(target) }] : []),
              { label: 'Move', value: formatCount(data.passes) },
              { label: 'Registered', value: formatCount(data.registered) },
              { label: 'Holders', value: formatCount(data.holders) },
              ...kept.map(([reason, n]) => ({
                label: `Kept: ${KEPT_REASON[reason] ?? reason}`,
                value: formatCount(n),
              })),
            ]}
          />
        </div>
      ) : null}
    </FormDialog>
  );
}
