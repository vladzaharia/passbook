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
  KeyValue,
  PageHeader,
  SaveBarGroup,
  SkeletonDetail,
  TwoPane,
} from '@/web/ui/index.ts';
import { OrgSettingsSections } from '../settings/org-settings-page.tsx';
import { AccessCard } from './org-access.tsx';
import { CountsCard, OrgChecklist, OverviewCard, SigningCard } from './org-aside.tsx';
import { OrgForm } from './org-form.tsx';
import { OrgStatus } from './orgs-page.tsx';
import { useOrgWorkspace } from './queries.ts';
import { WalletAccountsPanel } from './wallet-accounts.tsx';

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
  if (query.isPending) {
    return (
      <>
        <PageHeader title="Settings" />
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
      header: <PageHeader title="Settings" />,
    });
  }
  const org = query.data;
  return (
    <SaveBarGroup>
      <PageHeader
        title="Settings"
        meta={
          <>
            <OrgStatus status={org.status} />
            <span className="font-mono text-xs">{org.slug}</span>
          </>
        }
        actions={
          isAdmin ? (
            <Button asChild variant="outline">
              <Link to="/admin/platform/orgs/$orgId" params={{ orgId: org.id }}>
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
        {canUseChecklist ? <OrgChecklist org={org} /> : null}
        {canManage ? (
          <OrgForm org={org} canChooseIdentity={isAdmin} />
        ) : (
          <ReadOnlyBranding org={org} />
        )}
        <OrgSettingsSections
          orgId={org.id}
          version={org.updatedAt}
          canManage={canManage}
          canPreviewTemplates={canPreviewTemplates}
        />
        {canManageMembers ? <AccessCard key={org.id} org={org} /> : null}
      </TwoPane>
    </SaveBarGroup>
  );
}
