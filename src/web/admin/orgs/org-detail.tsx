import { useNavigate } from '@tanstack/react-router';
import { Palette, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { deleteConfirm } from '@/web/lib/confirms.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { prefersReducedMotion } from '@/web/lib/motion.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  detailError,
  EntityAvatar,
  MetaLink,
  PageHeader,
  SaveBarGroup,
  SkeletonDetail,
  TwoPane,
  TypedConfirmDialog,
  toast,
} from '@/web/ui/index.ts';
import { CreatedCallout, useCreated } from '../passes/created.tsx';
import { ORG_FIELDS } from '../settings/fields.ts';
import { SettingsForm } from '../settings/settings-form.tsx';
import { CountsCard, OrgChecklist, OverviewCard } from './org-aside.tsx';
import { OrgForm } from './org-form.tsx';
import { OrgStatus } from './orgs-page.tsx';
import { PASS_BRANDING_ID } from './pass-branding.tsx';
import { PassEmailPreview } from './pass-email-preview.tsx';
import { useDeleteOrg, useOrg, useSetOrgStatus } from './queries.ts';

// Accent lives in the org form; settings here cover support contacts and the pass email.
const SUPPORT_FIELDS = ORG_FIELDS.filter((f) => f.key.startsWith('support.'));
const EMAIL_FIELDS = ORG_FIELDS.filter((f) => f.key.startsWith('email.'));

/** Suspend is undone from its toast; Reactivate just runs. Neither asks first. */
function useStatusToggle(orgId: string) {
  const setStatus = useSetOrgStatus(orgId);
  const suspend = async () => {
    try {
      await setStatus.mutateAsync('suspended');
      toast.undo('Organization suspended', () => setStatus.mutateAsync('active'));
    } catch (cause) {
      toast.error(cause, 'Could not suspend');
    }
  };
  const reactivate = async () => {
    try {
      await setStatus.mutateAsync('active');
      toast.success('Organization reactivated');
    } catch (cause) {
      toast.error(cause, 'Could not reactivate');
    }
  };
  return { suspend, reactivate, pending: setStatus.isPending };
}

export function OrgDetailPage({ orgId }: { orgId: string }) {
  const query = useOrg(orgId);
  const remove = useDeleteOrg(orgId);
  const status = useStatusToggle(orgId);
  const created = useCreated(`org:${orgId}`);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
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
  const { typed: _typed, ...confirmCopy } = deleteConfirm('org', org.name);
  // Details, pass email and support contacts are separate forms under one Save.
  return (
    <SaveBarGroup>
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
            <MetaLink to="/admin/audit" search={{ orgId: org.id }} icon={ENTITY.audit.icon}>
              Audit log
            </MetaLink>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              loading={status.pending}
              iconStart={suspended ? <Play aria-hidden /> : <Pause aria-hidden />}
              onClick={() => void (suspended ? status.reactivate() : status.suspend())}
            >
              {suspended ? 'Reactivate' : 'Suspend'}
            </Button>
            <Button
              variant="outline"
              iconStart={<ACTION_ICON.delete aria-hidden />}
              onClick={() => setDeleting(true)}
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
        {created.shown ? (
          // Branding first; the Get started checklist below carries template, pass and source.
          <CreatedCallout
            title="Organization created"
            onDismiss={created.dismiss}
            actions={
              <Button
                size="sm"
                iconStart={<Palette aria-hidden />}
                onClick={() => {
                  const card = document.getElementById(PASS_BRANDING_ID);
                  card?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
                  card?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
                }}
              >
                Add branding
              </Button>
            }
          />
        ) : null}
        {suspended ? (
          <Callout tone="warning">
            Suspended: passes do not update and its API keys do not work.
          </Callout>
        ) : null}
        {org.counts.passes === 0 ? <OrgChecklist org={org} /> : null}
        <OrgForm key={`${org.updatedAt}`} org={org} />
        <Card>
          <CardHeader title="Pass email" />
          <CardBody>
            <SettingsForm
              scope={`org:${org.id}`}
              fields={EMAIL_FIELDS}
              aside={(draft) => (
                <PassEmailPreview
                  orgId={org.id}
                  buddy={draft['email.buddy'] === true}
                  version={org.updatedAt}
                />
              )}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Support contacts" />
          <CardBody>
            <SettingsForm scope={`org:${org.id}`} fields={SUPPORT_FIELDS} />
          </CardBody>
        </Card>
      </TwoPane>
      <TypedConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        {...confirmCopy}
        word={org.slug}
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('Organization deleted');
          // The deleted org's page leaves history: Back lands on the list, not on Not found.
          await navigate({ to: '/admin/orgs', replace: true });
        }}
      />
    </SaveBarGroup>
  );
}
