import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  ConfirmDialog,
  ErrorState,
  FormField,
  Input,
  KeyValue,
  Select,
  Spinner,
  toast,
} from '../../../ui/index.ts';
import { useConnection, useConnections } from '../../connections/api.ts';
import { HealthPill } from '../../connections/health.tsx';
import { usePassActions } from '../api.ts';
import { formatDate } from '../format.ts';

type Pass = z.infer<typeof PassDetailSchema>;

function BindForm({ pass }: { pass: Pass }) {
  const actions = usePassActions(pass.id);
  const connections = useConnections({ orgId: pass.orgId });
  const [connectionId, setConnectionId] = useState<string | undefined>(
    pass.connectionId ?? undefined,
  );
  const [ref, setRef] = useState('');
  const [reset, setReset] = useState(false);
  const [error, setError] = useState<string>();
  const [unbind, setUnbind] = useState(false);

  async function bind() {
    const externalRef = ref.trim();
    if (!connectionId) return setError('Choose a connection.');
    if (!externalRef) return setError('Enter the connection ref.');
    setError(undefined);
    try {
      await actions.bindConnection.mutateAsync({
        connectionId,
        externalRef,
        ...(reset ? { resetFieldSources: true } : {}),
      });
      setRef('');
      toast.success('Bound');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader title={pass.connectionId ? 'Rebind' : 'Bind to a connection'} />
      <CardBody className="grid gap-4">
        <FormField label="Connection" required>
          {(c) => (
            <Select
              {...c}
              value={connectionId}
              onValueChange={setConnectionId}
              options={(connections.data?.items ?? []).map((x) => ({ value: x.id, label: x.name }))}
            />
          )}
        </FormField>
        <FormField label="Ref" required help="The record id in the source." error={error}>
          {(c) => (
            <Input {...c} autoComplete="off" value={ref} onChange={(e) => setRef(e.target.value)} />
          )}
        </FormField>
        <CheckboxField
          label="Let the connection take over all fields"
          checked={reset}
          onCheckedChange={(c) => setReset(c === true)}
        />
        <div className="flex flex-wrap gap-2">
          <Button loading={actions.bindConnection.isPending} onClick={() => void bind()}>
            {pass.connectionId ? 'Rebind' : 'Bind'}
          </Button>
          {pass.connectionId ? (
            <Button variant="outline" onClick={() => setUnbind(true)}>
              Unbind
            </Button>
          ) : null}
        </div>
      </CardBody>
      <ConfirmDialog
        open={unbind}
        onOpenChange={setUnbind}
        title="Unbind pass?"
        description="The connection stops updating this pass. Field values stay."
        confirmLabel="Unbind"
        destructive
        onConfirm={async () => {
          await actions.bindConnection.mutateAsync({ connectionId: null, externalRef: null });
          setConnectionId(undefined);
          toast.success('Unbound');
        }}
      />
    </Card>
  );
}

function Bound({ pass }: { pass: Pass }) {
  const connection = useConnection(pass.connectionId ?? undefined);
  const actions = usePassActions(pass.id);
  if (connection.isPending) return <Spinner />;
  if (connection.isError) {
    return <ErrorState error={connection.error} onRetry={() => void connection.refetch()} />;
  }
  const c = connection.data;
  const lastRun = c.runs[0];
  return (
    <Card className="max-w-3xl">
      <CardHeader
        title="Connection"
        actions={
          <Button
            size="sm"
            loading={actions.refreshFromSource.isPending}
            onClick={() =>
              actions.refreshFromSource
                .mutateAsync()
                .then(() => toast.success('Refresh requested'))
                .catch((error: unknown) => toast.error(error))
            }
          >
            Refresh now
          </Button>
        }
      />
      <CardBody>
        <KeyValue
          items={[
            {
              label: 'Connection',
              value: (
                <Link
                  to={`/admin/connections/${c.id}` as never}
                  className="text-accent-fg hover:underline"
                >
                  {c.name}
                </Link>
              ),
            },
            { label: 'Health', value: <HealthPill health={c.health} /> },
            { label: 'External ID', value: pass.externalId, mono: true },
            { label: 'Last refreshed', value: formatDate(pass.lastRefreshedAt) },
            {
              label: 'Last run',
              value: lastRun ? `${lastRun.outcome} · ${formatDate(lastRun.startedAt)}` : null,
            },
            { label: 'Sync error', value: pass.syncErrorCode, mono: true },
          ]}
        />
      </CardBody>
    </Card>
  );
}

export function ConnectionTab({ pass }: { pass: Pass }) {
  return (
    <div className="grid gap-4">
      {pass.connectionId ? <Bound pass={pass} /> : null}
      <BindForm key={pass.connectionId ?? ''} pass={pass} />
    </div>
  );
}
