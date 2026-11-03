import { Link, useNavigate } from '@tanstack/react-router';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  detailError,
  EntityAvatar,
  PageHeader,
  SkeletonDetail,
  TwoPane,
  TypedConfirmDialog,
  toast,
} from '@/web/ui/index.ts';
import { ORG_FIELDS } from '../settings/fields.ts';
import { SettingsForm } from '../settings/settings-form.tsx';
import { CountsCard, OrgChecklist, OverviewCard } from './org-aside.tsx';
import { OrgForm } from './org-form.tsx';
import { OrgStatus } from './orgs-page.tsx';
import { useDeleteOrg, useOrg, useSetOrgStatus } from './queries.ts';

// Accent lives in the org form; settings here cover support contacts.
const SUPPORT_FIELDS = ORG_FIELDS.filter((f) => f.key.startsWith('support.'));

export function OrgDetailPage({ orgId }: { orgId: string }) {
  const query = useOrg(orgId);
  const remove = useDeleteOrg(orgId);
  const setStatus = useSetOrgStatus(orgId);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<'status' | 'delete'>();
  const crumbs = [
    { label: 'Organizations', to: '/admin/orgs' },
    { label: query.data?.name ?? 'Organization' },
  ];

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Organization" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading organization" />
      </>
    );
  }
  if (query.isError) {
    return detailError(query, {
      entity: 'org',
      to: '/admin/orgs',
      header: <PageHeader title="Organization" breadcrumbs={crumbs} />,
    });
  }
  const org = query.data;
  const suspended = org.status === 'suspended';
  return (
    <>
      <PageHeader
        title={org.name}
        breadcrumbs={crumbs}
        avatar={
          <EntityAvatar
            kind="org"
            id={org.id}
            name={org.name}
            accent={org.branding.accent}
            size={40}
          />
        }
        meta={
          <>
            <OrgStatus status={org.status} />
            <span className="font-mono text-xs">{org.slug}</span>
            <Link
              to="/admin/audit"
              search={{ orgId: org.id }}
              className="inline-flex min-h-6 items-center gap-1.5 rounded-sm hover:text-fg-strong hover:underline"
            >
              <ENTITY.audit.icon aria-hidden className="size-4" />
              Audit log
            </Link>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              iconStart={suspended ? <Play aria-hidden /> : <Pause aria-hidden />}
              onClick={() => setConfirm('status')}
            >
              {suspended ? 'Reactivate' : 'Suspend'}
            </Button>
            <Button
              variant="outline"
              iconStart={<ACTION_ICON.delete aria-hidden />}
              onClick={() => setConfirm('delete')}
            >
              Delete
            </Button>
          </>
        }
      />
      <TwoPane
        aside={
          <>
            <CountsCard org={org} />
            <OverviewCard org={org} />
          </>
        }
      >
        {org.counts.passes === 0 ? <OrgChecklist org={org} /> : null}
        <OrgForm key={`${org.updatedAt}`} org={org} />
        <Card>
          <CardHeader title="Support contacts" />
          <CardBody>
            <SettingsForm scope={`org:${org.id}`} fields={SUPPORT_FIELDS} />
          </CardBody>
        </Card>
      </TwoPane>
      <ConfirmDialog
        open={confirm === 'status'}
        onOpenChange={(o) => !o && setConfirm(undefined)}
        title={suspended ? `Reactivate ${org.name}?` : `Suspend ${org.name}?`}
        description={
          suspended
            ? `Passes update and API keys work again for ${org.name}.`
            : `Passes stop updating and API keys stop working for ${org.name}.`
        }
        confirmLabel={suspended ? 'Reactivate' : 'Suspend'}
        destructive={!suspended}
        onConfirm={async () => {
          await setStatus.mutateAsync(suspended ? 'active' : 'suspended');
          toast.success(suspended ? 'Organization reactivated' : 'Organization suspended');
        }}
      />
      <TypedConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(undefined)}
        title={`Delete ${org.name}?`}
        description="Its templates, passes and connections stop working. This cannot be undone."
        word={org.slug}
        confirmLabel="Delete"
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('Organization deleted');
          await navigate({ to: '/admin/orgs' });
        }}
      />
    </>
  );
}
