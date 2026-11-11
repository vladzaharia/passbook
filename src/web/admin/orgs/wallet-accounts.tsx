import { useQuery } from '@tanstack/react-query';
import type { Mode } from '@/shared/contracts/common.ts';
import { OrgMembershipListSchema } from '@/shared/contracts/org-membership.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Card, CardBody, CardHeader } from '@/web/ui/index.ts';
import { headers, Retry, safeError } from './wallet-accounts-shared.tsx';
import { ProviderAccount } from './wallet-provider-account.tsx';

function ScopedWalletAccounts({ orgId, mode }: { orgId: string; mode: Mode }) {
  const access = useQuery({
    queryKey: ['wallet-accounts-access', orgId, mode],
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs/memberships/me', OrgMembershipListSchema, {
        headers: headers(mode),
        signal,
      }),
  });
  const membership = access.data?.items.find(
    (item) => item.orgId === orgId && item.revokedAt === null,
  );
  const canRead = membership?.capabilities.includes('integrations:read') === true;
  const canManage = membership?.capabilities.includes('integrations:manage') === true;
  return (
    <Card>
      <CardHeader title="Wallet accounts" />
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          Google and Samsung accounts are separate for each organization and mode. You are viewing{' '}
          <strong>{mode === 'live' ? 'Live' : 'Test'}</strong> mode.
        </p>
        {access.isPending ? (
          <p role="status" className="text-sm text-fg-muted">
            Checking organization access…
          </p>
        ) : access.isError ? (
          <Retry message={safeError(access.error)} onRetry={() => void access.refetch()} />
        ) : !canRead ? (
          <p className="text-sm text-fg-muted">
            An organization membership with wallet integration read access is required to view these
            accounts.
          </p>
        ) : (
          <>
            <ProviderAccount
              key={`google:${canManage}`}
              scope={{ orgId, mode, provider: 'google' }}
              canManage={canManage}
            />
            <ProviderAccount
              key={`samsung:${canManage}`}
              scope={{ orgId, mode, provider: 'samsung' }}
              canManage={canManage}
            />
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** Mount in the organization workspace; the mode and effective membership are resolved here. */
export function WalletAccountsPanel({ orgId }: { orgId: string }) {
  const mode = useMode();
  return <ScopedWalletAccounts key={JSON.stringify([orgId, mode])} orgId={orgId} mode={mode} />;
}
