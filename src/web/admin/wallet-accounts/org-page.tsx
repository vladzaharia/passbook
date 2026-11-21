import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonDetail,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { COPY } from './copy.ts';
import { OrgAppleCard } from './org-apple-card.tsx';
import { OrgProviderCard } from './org-provider-card.tsx';
import { useOrgCredentials, useOrgEnrolments } from './queries.ts';

function Providers({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const enrolments = useOrgEnrolments(orgId);
  const credentials = useOrgCredentials(orgId);
  if (enrolments.isPending || credentials.isPending)
    return <SkeletonRows rows={3} label="Loading wallet accounts" />;
  const failed = enrolments.isError ? enrolments : credentials.isError ? credentials : undefined;
  if (failed || !enrolments.data || !credentials.data)
    return (
      <ErrorState
        subject="wallet accounts"
        error={failed?.error}
        onRetry={() => {
          void enrolments.refetch();
          void credentials.refetch();
        }}
      />
    );
  const items = credentials.data.items;
  return (
    <>
      {enrolments.data.items.map((e) => (
        <OrgProviderCard
          key={`${e.mode}:${e.provider}`}
          orgId={orgId}
          enrolment={e}
          own={items.find(
            (c) =>
              c.provider === e.provider &&
              c.scope === 'org' &&
              c.mode === e.mode &&
              c.revokedAt === null,
          )}
          canManage={canManage}
        />
      ))}
    </>
  );
}

/** Mounted behind the org gate, which admits an org:read membership. */
export function OrgWalletAccountsPage() {
  const { membership } = useOrgScope();
  if (!membership) return <SkeletonDetail label="Loading wallet accounts" />;
  const caps = membership.capabilities;
  return (
    <>
      <PageHeader title="Wallet accounts" />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {caps.includes('integrations:read') ? (
          <>
            <div className="lg:col-span-2">
              <OrgAppleCard orgId={membership.orgId} canManage={caps.includes('org:manage')} />
            </div>
            <Providers orgId={membership.orgId} canManage={caps.includes('integrations:manage')} />
          </>
        ) : (
          <div className="lg:col-span-2">
            <EmptyState inline art="lock" title={COPY.noIntegrationAccess} />
          </div>
        )}
      </div>
    </>
  );
}
