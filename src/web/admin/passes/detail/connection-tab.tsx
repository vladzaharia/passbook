import { useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Unplug } from 'lucide-react';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  EntityChip,
  ErrorState,
  IconButton,
  KeyValue,
  SkeletonKeyValue,
  toast,
} from '../../../ui/index.ts';
import { useConnection } from '../../connections/api.ts';
import { HealthPill } from '../../connections/health.tsx';
import { canMutatePass, passMutationPrincipal, usePassActions } from '../api.ts';
import { BindDialog } from './bind-dialog.tsx';

function Bound({
  pass,
  readOnly,
  onChange,
}: {
  pass: PassDetailDto;
  readOnly: boolean;
  onChange: () => void;
}) {
  const scope = useOrgScope();
  const canReadConnection = Boolean(
    scope.orgId === pass.orgId && scope.membership?.capabilities.includes('integrations:read'),
  );
  const connection = useConnection(
    canReadConnection ? (pass.connectionId ?? undefined) : undefined,
  );
  const actions = usePassActions(pass.id);
  const client = useQueryClient();
  const [unbind, setUnbind] = useState(false);
  if (canReadConnection && connection.isPending)
    return <SkeletonKeyValue label="Loading connection" />;
  if (canReadConnection && connection.isError)
    return <ErrorState inline error={connection.error} onRetry={() => void connection.refetch()} />;
  const c = connection.data;
  return (
    <Card>
      <CardHeader
        title="Connection"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              iconStart={<Pencil aria-hidden />}
              disabled={readOnly || !canReadConnection}
              onClick={onChange}
            >
              Change
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="sm"
                  label="More connection actions"
                  icon={<MoreHorizontal aria-hidden />}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem destructive disabled={readOnly} onSelect={() => setUnbind(true)}>
                  <Unplug aria-hidden />
                  Unbind
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <CardBody>
        <KeyValue
          items={[
            ...(c
              ? [
                  {
                    label: 'Connection',
                    value: (
                      <EntityChip
                        kind="connection"
                        id={c.id}
                        name={c.name}
                        to={`/admin/connections/${c.id}`}
                      />
                    ),
                  },
                  { label: 'Health', value: <HealthPill health={c.health} /> },
                ]
              : []),
            { label: 'Record id', value: pass.externalRef ?? null, mono: true },
            {
              label: 'Last pull',
              value: pass.lastRefreshedAt ? formatDateTime(pass.lastRefreshedAt) : null,
            },
            ...(pass.syncErrorCode
              ? [
                  {
                    label: 'Sync error',
                    value: SYNC_ERRORS[pass.syncErrorCode] ?? pass.syncErrorCode,
                    mono: !(pass.syncErrorCode in SYNC_ERRORS),
                  },
                ]
              : []),
          ]}
        />
      </CardBody>
      <ConfirmDialog
        open={!readOnly && unbind}
        onOpenChange={setUnbind}
        title="Unbind pass?"
        description="Fields stop syncing. Their current values stay."
        confirmLabel="Unbind"
        destructive
        onConfirm={async () => {
          if (readOnly) return;
          const principalId = passMutationPrincipal(client);
          if (!principalId || !canMutatePass(client, pass, principalId)) return;
          await actions.bindConnection.mutateAsync({ connectionId: null, externalRef: null });
          if (!canMutatePass(client, pass, principalId)) return;
          toast.success('Pass unbound from connection');
        }}
      />
    </Card>
  );
}

const SYNC_ERRORS: Record<string, string> = {
  PASS_REISSUE_REQUIRED: 'Needs a new copy',
};

export function ConnectionTab({ pass, readOnly }: { pass: PassDetailDto; readOnly: boolean }) {
  const [binding, setBinding] = useState(false);
  const [opened, setOpened] = useState(0);
  const open = () => {
    setOpened((n) => n + 1);
    setBinding(true);
  };
  return (
    <>
      {pass.connectionId ? (
        <Bound pass={pass} readOnly={readOnly} onChange={open} />
      ) : (
        <Card>
          <EmptyState
            inline
            art="plugs"
            title="Not bound to a connection"
            action={
              pass.status === 'voided' || readOnly ? undefined : (
                <Button variant="outline" size="sm" onClick={open}>
                  Bind to a connection
                </Button>
              )
            }
          />
        </Card>
      )}
      {readOnly ? null : (
        <BindDialog key={opened} pass={pass} open={binding} onOpenChange={setBinding} />
      )}
    </>
  );
}
