import { useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Unplug } from 'lucide-react';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  EntityChip,
  ErrorState,
  FormField,
  IconButton,
  Input,
  KeyValue,
  Select,
  SkeletonKeyValue,
  toast,
} from '../../../ui/index.ts';
import { useConnection, useConnections } from '../../connections/api.ts';
import { HealthPill } from '../../connections/health.tsx';
import { canMutatePass, passMutationPrincipal, usePassActions } from '../api.ts';

function BindDialog({
  pass,
  open,
  onOpenChange,
}: {
  pass: PassDetailDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = usePassActions(pass.id);
  const client = useQueryClient();
  const connections = useConnections({ orgId: pass.orgId });
  const [connectionId, setConnectionId] = useState(pass.connectionId ?? undefined);
  const [ref, setRef] = useState(pass.externalRef ?? '');
  const [takeOver, setTakeOver] = useState(false);
  const [error, setError] = useState<string>();

  async function bind() {
    const principalId = passMutationPrincipal(client);
    if (!principalId || !canMutatePass(client, pass, principalId)) return;
    const externalRef = ref.trim();
    if (!connectionId) return setError('Choose a connection.');
    if (!externalRef) return setError('Enter the record id in the source.');
    setError(undefined);
    try {
      await actions.bindConnection.mutateAsync({
        connectionId,
        externalRef,
        resetFieldSources: takeOver,
      });
      if (!canMutatePass(client, pass, principalId)) return;
      toast.success('Pass bound to connection');
      onOpenChange(false);
    } catch (cause) {
      if (canMutatePass(client, pass, principalId)) setError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      dirty={
        connectionId !== (pass.connectionId ?? undefined) ||
        ref !== (pass.externalRef ?? '') ||
        takeOver
      }
      onOpenChange={(next) => !actions.bindConnection.isPending && onOpenChange(next)}
    >
      <DialogContent
        title={pass.connectionId ? 'Change connection' : 'Bind to a connection'}
        footer={
          <>
            <Button
              variant="outline"
              disabled={actions.bindConnection.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button loading={actions.bindConnection.isPending} onClick={() => void bind()}>
              Bind
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Connection" required>
            {(c) => (
              <Select
                {...c}
                value={connectionId}
                onValueChange={setConnectionId}
                options={(connections.data?.items ?? []).map((x) => ({
                  value: x.id,
                  label: x.name,
                }))}
              />
            )}
          </FormField>
          <FormField label="Record id" required help="The record's id in the source." error={error}>
            {(c) => (
              <Input
                {...c}
                autoComplete="off"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
            )}
          </FormField>
          <CheckboxField
            label="Let the connection take over every field"
            checked={takeOver}
            onCheckedChange={(c) => setTakeOver(c === true)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
