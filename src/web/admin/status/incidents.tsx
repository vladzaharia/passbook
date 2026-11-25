import { useState } from 'react';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  FormDialog,
  FormField,
  Input,
  Select,
  SkeletonRows,
  Textarea,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useIncidents, useOpenIncident, useResolveIncident } from './queries.ts';

const COMPONENTS = [
  { value: 'all', label: 'Whole service' },
  { value: 'api', label: 'API' },
  { value: 'apple_push', label: 'Apple push' },
  { value: 'email', label: 'Email' },
  { value: 'webhooks', label: 'Webhooks' },
  { value: 'google', label: 'Google Wallet' },
  { value: 'samsung', label: 'Samsung Wallet' },
];
const IMPACTS = [
  { value: 'notice', label: 'Notice' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'outage', label: 'Outage' },
];
const TONE = { notice: 'info', degraded: 'warning', outage: 'danger' } as const;
type Impact = keyof typeof TONE;
type Component = (typeof COMPONENTS)[number]['value'];

const EMPTY = { title: '', note: '', component: 'all' as Component, impact: 'notice' as Impact };

function OpenIncidentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useOpenIncident();
  const [f, setF] = useState(EMPTY);
  const check = useFormErrors({
    ...(f.title.trim() ? {} : { title: 'Required.' }),
    ...(f.note.trim() ? {} : { note: 'Required.' }),
  });
  async function submit() {
    await create.mutateAsync({
      title: f.title.trim(),
      note: f.note.trim(),
      component: f.component === 'all' ? null : (f.component as never),
      impact: f.impact,
    });
    toast.success('Note published. The public page updates within 30 s');
    onOpenChange(false);
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Open incident note"
      dirty={f.title.trim() !== '' || f.note.trim() !== ''}
      check={check}
      onSubmit={submit}
      submitLabel="Publish"
      busy={create.isPending}
      onClose={() => setF(EMPTY)}
    >
      {({ errors: server }) => (
        <>
          <FormField label="Title" required error={check.errors.title ?? server.title}>
            {(p) => (
              <Input
                {...p}
                data-autofocus
                autoComplete="off"
                value={f.title}
                maxLength={120}
                onChange={(e) => setF({ ...f, title: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Note" required error={check.errors.note ?? server.note}>
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={f.note}
                maxLength={600}
                onChange={(e) => setF({ ...f, note: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Affects">
            {(p) => (
              <Select
                {...p}
                value={f.component}
                options={COMPONENTS}
                onValueChange={(v) => setF({ ...f, component: v })}
              />
            )}
          </FormField>
          <FormField label="Impact">
            {(p) => (
              <Select
                {...p}
                value={f.impact}
                options={IMPACTS}
                onValueChange={(v) => setF({ ...f, impact: v as Impact })}
              />
            )}
          </FormField>
        </>
      )}
    </FormDialog>
  );
}

export function Incidents() {
  const list = useIncidents();
  const resolve = useResolveIncident();
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Public incident notes"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Open note
          </Button>
        }
      />
      {list.isPending ? (
        <CardBody>
          <SkeletonRows rows={2} label="Loading incident notes" />
        </CardBody>
      ) : list.isError ? (
        <CardBody>
          <ErrorState inline error={list.error} onRetry={() => list.refetch()} />
        </CardBody>
      ) : list.data.items.length === 0 ? (
        <EmptyState inline art="pulse" title="No incident notes" />
      ) : (
        <ul className="divide-y divide-border">
          {list.data.items.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium text-fg-strong">{n.title}</p>
                <p className="text-sm text-fg-muted">{n.note}</p>
                <p className="text-xs text-fg-muted">
                  {n.resolvedAt ? `${n.impact}, ` : ''}
                  {formatDateTime(n.startedAt)}
                  {n.resolvedAt ? `, resolved ${formatDateTime(n.resolvedAt)}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {n.resolvedAt ? (
                  <Badge tone="neutral">Resolved</Badge>
                ) : (
                  <Badge tone={TONE[n.impact]}>{n.impact}</Badge>
                )}
                {n.resolvedAt ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={resolve.isPending && resolve.variables === n.id}
                    onClick={() =>
                      resolve.mutate(n.id, {
                        onError: (cause) => toast.error(cause, 'Could not resolve'),
                      })
                    }
                  >
                    Resolve
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <OpenIncidentDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}
