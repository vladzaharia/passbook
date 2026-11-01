import { MoreHorizontal, Pencil, Unplug } from 'lucide-react';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { formatDateTime } from '../../../lib/format.ts';
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
import { usePassActions } from '../api.ts';

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
  const connections = useConnections({ orgId: pass.orgId });
  const [connectionId, setConnectionId] = useState(pass.connectionId ?? undefined);
  const [ref, setRef] = useState(pass.externalRef ?? '');
  const [takeOver, setTakeOver] = useState(false);
  const [error, setError] = useState<string>();

  async function bind() {
    const externalRef = ref.trim();
    if (!connectionId) return setError('Choose a connection.');
    if (!externalRef) return setError('Enter the record id in the source.');
    setError(undefined);
    try {
      await actions.bindConnection.mutateAsync({
        connectionId,
        externalRef,
        ...(takeOver ? { resetFieldSources: true } : {}),
      });
      toast.success('Bound');
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={pass.connectionId ? 'Change connection' : 'Bind to a connection'}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
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

function Bound({ pass, onChange }: { pass: PassDetailDto; onChange: () => void }) {
  const connection = useConnection(pass.connectionId ?? undefined);
  const actions = usePassActions(pass.id);
  const [unbind, setUnbind] = useState(false);
  if (connection.isPending) return <SkeletonKeyValue label="Loading connection" />;
  if (connection.isError)
    return <ErrorState error={connection.error} onRetry={() => void connection.refetch()} />;
  const c = connection.data;
  return (
    <Card>
      <CardHeader
        title="Connection"
        actions={
          <>
            <Button variant="ghost" size="sm" iconStart={<Pencil aria-hidden />} onClick={onChange}>
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
                <DropdownMenuItem destructive onSelect={() => setUnbind(true)}>
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
            { label: 'Record id', value: pass.externalRef ?? null, mono: true },
            {
              label: 'Last pull',
              value: pass.lastRefreshedAt ? formatDateTime(pass.lastRefreshedAt) : null,
            },
            ...(pass.syncErrorCode
              ? [{ label: 'Sync error', value: pass.syncErrorCode, mono: true }]
              : []),
          ]}
        />
      </CardBody>
      <ConfirmDialog
        open={unbind}
        onOpenChange={setUnbind}
        title="Unbind pass?"
        description="Fields stop syncing. Their current values stay."
        confirmLabel="Unbind"
        destructive
        onConfirm={async () => {
          await actions.bindConnection.mutateAsync({ connectionId: null, externalRef: null });
          toast.success('Unbound');
        }}
      />
    </Card>
  );
}

export function ConnectionTab({ pass }: { pass: PassDetailDto }) {
  const [binding, setBinding] = useState(false);
  const [opened, setOpened] = useState(0);
  const open = () => {
    setOpened((n) => n + 1);
    setBinding(true);
  };
  return (
    <>
      {pass.connectionId ? (
        <Bound pass={pass} onChange={open} />
      ) : (
        <Card>
          <EmptyState
            inline
            art="plugs"
            title="Not bound to a connection"
            action={
              pass.status === 'voided' ? undefined : (
                <Button variant="outline" size="sm" onClick={open}>
                  Bind to a connection
                </Button>
              )
            }
          />
        </Card>
      )}
      <BindDialog key={opened} pass={pass} open={binding} onOpenChange={setBinding} />
    </>
  );
}
