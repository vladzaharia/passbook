import { Link, useNavigate } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  DataTable,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDay } from '../overview/format.ts';
import { useCreateOrg, useOrgList } from './queries.ts';

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function OrgStatus({ status }: { status: 'active' | 'suspended' | 'deleted' }) {
  return (
    <StatusPill
      status={status}
      tone={status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'neutral'}
    >
      {status[0]?.toUpperCase()}
      {status.slice(1)}
    </StatusPill>
  );
}

function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateOrg();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  function close() {
    onOpenChange(false);
    setName('');
    setSlug('');
    setSlugEdited(false);
    setErrors({});
    setFormError(undefined);
  }

  async function submit() {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = 'Required.';
    if (!SLUG.test(slug)) found.slug = 'Use 2 to 64 lowercase letters, digits or hyphens.';
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;
    try {
      const org = await create.mutateAsync({ name: name.trim(), slug });
      toast.success('Organization created');
      close();
      await navigate({ to: '/admin/orgs/$orgId', params: { orgId: org.id } });
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setErrors(cause.fields);
      setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        title="New organization"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button loading={create.isPending} onClick={() => void submit()}>
              Create
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormField label="Name" required error={errors.name}>
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugEdited) setSlug(slugify(e.target.value));
                }}
              />
            )}
          </FormField>
          <FormField label="Slug" required error={errors.slug}>
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                }}
              />
            )}
          </FormField>
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OrgsPage() {
  const list = useOrgList();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Organizations"
        actions={
          <Button iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            New organization
          </Button>
        }
      />
      {list.isPending ? (
        <SkeletonRows label="Loading organizations" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="Organizations"
          data={list.data.items}
          getRowId={(o) => o.id}
          empty={
            <EmptyState
              icon={Building2}
              title="No organizations"
              action={<Button onClick={() => setCreating(true)}>New organization</Button>}
            />
          }
          columns={[
            {
              header: 'Name',
              id: 'name',
              cell: ({ row }) => (
                <Link
                  to="/admin/orgs/$orgId"
                  params={{ orgId: row.original.id }}
                  className="font-medium text-accent-fg hover:underline"
                >
                  {row.original.name}
                </Link>
              ),
            },
            {
              header: 'Slug',
              id: 'slug',
              cell: ({ row }) => <code className="font-mono text-xs">{row.original.slug}</code>,
            },
            {
              header: 'Status',
              id: 'status',
              cell: ({ row }) => <OrgStatus status={row.original.status} />,
            },
            { header: 'Passes', id: 'passes', cell: ({ row }) => row.original.counts.passes },
            {
              header: 'Templates',
              id: 'templates',
              cell: ({ row }) => row.original.counts.templates,
            },
            {
              header: 'Connections',
              id: 'connections',
              cell: ({ row }) => row.original.counts.connections,
            },
            {
              header: 'Created',
              id: 'created',
              cell: ({ row }) => formatDay(row.original.createdAt),
            },
          ]}
        />
      )}
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
