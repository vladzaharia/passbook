import { Link } from '@tanstack/react-router';
import type { z } from 'zod';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  detailError,
  EntityAvatar,
  ErrorState,
  KeyValue,
  PageHeader,
  SaveBarGroup,
  SkeletonDetail,
  SkeletonRows,
  TwoPane,
} from '@/web/ui/index.ts';
import { ORG_FIELDS } from '../settings/fields.ts';
import { useSettings } from '../settings/queries.ts';
import { SettingsForm } from '../settings/settings-form.tsx';
import { AccessCard } from './org-access.tsx';
import { CountsCard, OrgChecklist, OverviewCard, SigningCard } from './org-aside.tsx';
import { OrgForm } from './org-form.tsx';
import { OrgStatus } from './orgs-page.tsx';
import { PassEmailPreview } from './pass-email-preview.tsx';
import { useOrgWorkspace } from './queries.ts';
import { WalletAccountsPanel } from './wallet-accounts.tsx';

const SUPPORT_FIELDS = ORG_FIELDS.filter((f) => f.key.startsWith('support.'));
const EMAIL_FIELDS = ORG_FIELDS.filter((f) => f.key.startsWith('email.'));
type Workspace = z.infer<typeof OrgSummarySchema>;

function ReadOnlyBranding({ org }: { org: Workspace }) {
  const colors = org.branding.passColors;
  return (
    <Card>
      <CardHeader title="Pass branding" />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Accent colour', value: org.branding.accent ?? 'Not set' },
            { label: 'Background', value: colors?.background ?? 'Not set' },
            { label: 'Foreground', value: colors?.foreground ?? 'Not set' },
            { label: 'Label colour', value: colors?.label ?? 'Not set' },
            { label: 'Logo', value: org.branding.logo ? 'Uploaded' : 'Not uploaded' },
            { label: 'Icon', value: org.branding.icon ? 'Uploaded' : 'Not uploaded' },
            { label: 'Logo includes name', value: org.branding.logoHasName ? 'Yes' : 'No' },
          ]}
        />
      </CardBody>
    </Card>
  );
}

function ReadOnlySettings({ orgId }: { orgId: string }) {
  const query = useSettings(`org:${orgId}`);
  const value = (key: string) => {
    const entry = query.data?.items.find((item) => item.key === key);
    const current = entry?.value ?? entry?.default;
    if (typeof current === 'boolean') return current ? 'On' : 'Off';
    return current == null || current === '' ? 'Not set' : String(current);
  };
  return (
    <Card>
      <CardHeader title="Pass email and support" />
      <CardBody>
        {query.isPending ? (
          <SkeletonRows rows={3} label="Loading settings" />
        ) : query.isError ? (
          <ErrorState subject="settings" error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <KeyValue
            items={[
              { label: 'Buddy in pass emails', value: value('email.buddy') },
              { label: 'Support email', value: value('support.email') },
              { label: 'Support URL', value: value('support.url') },
            ]}
          />
        )}
      </CardBody>
    </Card>
  );
}

/** Mounted only after the URL and actual org:read membership have been validated. */
export function OrgWorkspacePage({
  orgId,
  membership,
  isAdmin,
}: {
  orgId: string;
  membership: OrgMembership;
  isAdmin: boolean;
}) {
  const query = useOrgWorkspace(orgId);
  const selectedOrgId = membership.orgId;
  const canManage = membership.capabilities.includes('org:manage');
  const canManageMembers = membership.capabilities.includes('members:manage');
  const canPreviewTemplates = membership.capabilities.includes('templates:read');
  const canUseChecklist =
    canManage &&
    canPreviewTemplates &&
    membership.capabilities.includes('templates:author') &&
    membership.capabilities.includes('passes:operate') &&
    membership.capabilities.includes('integrations:manage');
  const crumbs = isAdmin
    ? [{ label: 'Organizations', to: '/admin/orgs' }, { label: query.data?.name ?? 'Organization' }]
    : [{ label: 'Account', to: '/admin/account' }, { label: query.data?.name ?? 'Organization' }];
  if (query.isPending) {
    return (
      <>
        <PageHeader title="Organization workspace" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading organization" />
      </>
    );
  }
  if (
    !query.data ||
    (query.isError &&
      isApiError(query.error) &&
      (query.error.isUnauthorized || query.error.isForbidden || query.error.isNotFound))
  ) {
    return detailError(query, {
      entity: 'org',
      to: isAdmin ? '/admin/orgs' : '/admin/account',
      header: <PageHeader title="Organization workspace" breadcrumbs={crumbs} />,
    });
  }
  const org = query.data;
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
          </>
        }
        actions={
          isAdmin ? (
            <Button asChild variant="outline">
              <Link to="/admin/orgs/$orgId" params={{ orgId: org.id }} search={{ view: undefined }}>
                Platform provisioning
              </Link>
            </Button>
          ) : undefined
        }
      />
      {query.isRefetchError ? (
        <Callout
          tone="warning"
          className="mb-6"
          title="Organization refresh failed"
          actions={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry organization
            </Button>
          }
        >
          The displayed organization details may be out of date. Your unsaved changes are kept.
        </Callout>
      ) : null}
      <TwoPane
        aside={
          <>
            <CountsCard org={org} showApiKeys={isAdmin} />
            <OverviewCard org={org} />
          </>
        }
      >
        {org.status === 'suspended' ? (
          <Callout tone="warning">
            Suspended: passes do not update and its API keys do not work.
          </Callout>
        ) : null}
        {isAdmin ? (
          <SigningCard org={org} />
        ) : (
          <Card>
            <CardHeader title="Apple signing identity" />
            <CardBody>
              <KeyValue
                items={[
                  {
                    label: 'Organization default',
                    value: org.defaultIdentityId ?? 'No organization default selected',
                    mono: org.defaultIdentityId !== null,
                  },
                ]}
              />
            </CardBody>
          </Card>
        )}
        <WalletAccountsPanel orgId={selectedOrgId} />
        {canUseChecklist && org.counts.passes === 0 ? <OrgChecklist org={org} /> : null}
        {canManage ? (
          <>
            <OrgForm key={org.id} org={org} canChooseIdentity={isAdmin} />
            <Card>
              <CardHeader title="Pass email" />
              <CardBody className="flex flex-col gap-4">
                <SettingsForm
                  scope={`org:${org.id}`}
                  fields={EMAIL_FIELDS}
                  aside={
                    canPreviewTemplates
                      ? (draft) => (
                          <PassEmailPreview
                            orgId={org.id}
                            buddy={draft['email.buddy'] === true}
                            version={org.updatedAt}
                          />
                        )
                      : undefined
                  }
                />
                {!canPreviewTemplates ? (
                  <p className="text-sm text-fg-muted">
                    The email preview requires template read access.
                  </p>
                ) : null}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Support contacts" />
              <CardBody className="flex flex-col gap-4">
                <p className="text-sm text-fg-muted">
                  These contacts appear in the pass email preview.
                </p>
                <SettingsForm scope={`org:${org.id}`} fields={SUPPORT_FIELDS} />
              </CardBody>
            </Card>
          </>
        ) : (
          <>
            <ReadOnlyBranding org={org} />
            <ReadOnlySettings orgId={org.id} />
          </>
        )}
        {canManageMembers ? <AccessCard key={org.id} org={org} /> : null}
      </TwoPane>
    </SaveBarGroup>
  );
}
