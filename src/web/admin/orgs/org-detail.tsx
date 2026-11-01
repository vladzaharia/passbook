import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { useOrgFilter } from '@/web/lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogContent,
  ErrorState,
  FormField,
  Input,
  KeyValue,
  PageHeader,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { ORG_FIELDS } from '../settings/fields.ts';
import { SettingsForm } from '../settings/settings-form.tsx';
import { OrgForm } from './org-form.tsx';
import { OrgStatus } from './orgs-page.tsx';
import { useDeleteOrg, useOrg } from './queries.ts';

// Accent lives in the org branding form; settings here cover support contacts.
const SUPPORT_FIELDS = ORG_FIELDS.filter((f) => f.key.startsWith('support.'));

function DeleteOrg({ id, slug, name }: { id: string; slug: string; name: string }) {
  const remove = useDeleteOrg(id);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();

  async function confirm() {
    setError(undefined);
    try {
      await remove.mutateAsync();
      toast.success('Organization deleted');
      await navigate({ to: '/admin/orgs' });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setTyped('');
            setError(undefined);
          }
        }}
      >
        <DialogContent
          title={`Delete ${name}?`}
          description="Its templates, passes and connections stop working. This cannot be undone."
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={typed !== slug}
                loading={remove.isPending}
                onClick={() => void confirm()}
              >
                Delete
              </Button>
            </>
          }
        >
          <FormField label={`Type ${slug} to confirm`} error={error}>
            {(p) => <Input {...p} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          </FormField>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function OrgDetailPage({ orgId }: { orgId: string }) {
  const query = useOrg(orgId);
  const { setOrgId } = useOrgFilter();
  const navigate = useNavigate();
  const crumbs = [
    { label: 'Organizations', to: '/admin/orgs' },
    { label: query.data?.name ?? 'Organization' },
  ];

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Organization" breadcrumbs={crumbs} />
        <SkeletonRows label="Loading organization" />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title="Organization" breadcrumbs={crumbs} />
        <ErrorState
          error={query.error}
          title={
            isApiError(query.error) && query.error.isNotFound ? 'Organization not found' : undefined
          }
          onRetry={() => query.refetch()}
        />
      </>
    );
  }
  const org = query.data;
  const counts: [string, number][] = [
    ['Passes', org.counts.passes],
    ['Templates', org.counts.templates],
    ['Connections', org.counts.connections],
    ['API keys', org.counts.apiKeys],
  ];
  return (
    <>
      <PageHeader
        width="detail"
        title={org.name}
        breadcrumbs={crumbs}
        actions={<DeleteOrg id={org.id} slug={org.slug} name={org.name} />}
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <CardHeader title="Overview" actions={<OrgStatus status={org.status} />} />
          <CardBody className="flex flex-col gap-4">
            <KeyValue
              items={[
                { label: 'Slug', value: org.slug, mono: true },
                { label: 'ID', value: org.id, mono: true },
                { label: 'Created', value: formatDateTime(org.createdAt) },
                { label: 'Updated', value: formatDateTime(org.updatedAt) },
              ]}
            />
            <ul aria-label="Counts" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {counts.map(([label, n]) => (
                <li key={label} className="rounded-md border border-border p-3">
                  <p className="text-2xl font-semibold text-fg-strong">{n}</p>
                  <p className="text-xs text-fg-muted">{label}</p>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOrgId(org.id);
                  void navigate({ to: '/admin/passes' });
                }}
              >
                View passes
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOrgId(org.id);
                  void navigate({ to: '/admin/templates' });
                }}
              >
                View templates
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOrgId(org.id);
                  void navigate({ to: '/admin/connections' });
                }}
              >
                View connections
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOrgId(org.id);
                  void navigate({ to: '/admin/api-keys' });
                }}
              >
                View API keys
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/audit" search={{ orgId: org.id }}>
                  Audit log
                </Link>
              </Button>
            </div>
          </CardBody>
        </Card>
        <OrgForm key={`${org.updatedAt}`} org={org} />
        <Card>
          <CardHeader title="Support contacts" />
          <CardBody>
            <SettingsForm scope={`org:${org.id}`} fields={SUPPORT_FIELDS} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
