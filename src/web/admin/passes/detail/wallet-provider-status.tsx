import { useQuery } from '@tanstack/react-query';
import { RefreshCw, WalletCards } from 'lucide-react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import {
  type WalletProviderInstanceStatus,
  WalletProviderPassStatusSchema,
} from '@/shared/contracts/wallet-provider-status.ts';
import { api } from '../../../lib/api.ts';
import { useMode } from '../../../lib/mode.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { useSession } from '../../../lib/session.ts';
import {
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  IconButton,
  ListRow,
  ListRows,
  SkeletonRows,
  StatusPill,
} from '../../../ui/index.ts';

const LIFECYCLE: Record<WalletProviderInstanceStatus['lifecycle'], string> = {
  absent: 'No instance observed',
  blocked: 'Blocked locally',
  ready: 'Prepared locally',
  active: 'Active locally',
  revoking: 'Revocation in progress',
  revoked: 'Revoked locally',
  retired: 'Retired locally',
};
const OPERATION: Record<
  NonNullable<WalletProviderInstanceStatus['desiredOperation']>['state'],
  string
> = {
  pending: 'Pending',
  claimed: 'In progress',
  retry: 'Retry scheduled',
  succeeded: 'Succeeded',
  failed: 'Failed',
  superseded: 'Superseded',
  uncertain: 'Outcome uncertain',
};
const REASON: Record<
  NonNullable<NonNullable<WalletProviderInstanceStatus['desiredOperation']>['reason']>,
  string
> = {
  ok: 'provider accepted',
  not_issued: 'not issued',
  rate_limited: 'rate limited',
  unavailable: 'provider unavailable',
  timeout: 'timed out',
  unauthorized: 'authorization rejected',
  rejected: 'request rejected',
  invalid_response: 'invalid response',
  provider_error: 'provider error',
};

function ProviderRow({ status }: { status: WalletProviderInstanceStatus }) {
  const operation = status.desiredOperation;
  return (
    <ListRow
      leading={<WalletCards aria-hidden />}
      title={status.provider === 'google' ? 'Google Wallet' : 'Samsung Wallet'}
      pills={
        <>
          {status.issuance.state === 'disabled' ? (
            <StatusPill status="not_available" tone="neutral">
              Not available yet
            </StatusPill>
          ) : null}
          <StatusPill status="wallet_instance" tone="neutral">
            {LIFECYCLE[status.lifecycle]}
          </StatusPill>
        </>
      }
      meta={
        <>
          <span className="block">
            {operation
              ? `Desired ${operation.kind === 'upsert' ? 'update' : 'revocation'} v${operation.version}: ${OPERATION[operation.state]}${operation.reason ? ` (${REASON[operation.reason]})` : ''}`
              : 'No desired operation observed for this instance.'}
          </span>
          <span className="block">Installation on a device: unknown.</span>
          {status.priorGenerationRetirementPending ? (
            <span className="block">A previous generation is still awaiting retirement.</span>
          ) : null}
        </>
      }
    />
  );
}

/** Independent provider instances, not device registrations or provider readiness. */
export function WalletProviderStatus({ pass, active }: { pass: PassDetailDto; active: boolean }) {
  const scope = useOrgScope();
  const session = useSession();
  const mode = useMode();
  const userId = session.authed?.user.id;
  const allowed = Boolean(
    userId &&
      !session.isFetching &&
      !session.isError &&
      !scope.isLoading &&
      !scope.isError &&
      scope.orgId === pass.orgId &&
      scope.membership?.userId === userId &&
      scope.membership?.capabilities.includes('passes:read'),
  );
  const enabled = active && allowed && mode === pass.mode;
  const query = useQuery({
    queryKey: [
      'admin',
      'wallet-provider-status',
      pass.orgId,
      pass.mode,
      pass.id,
      userId,
      scope.membership?.id,
    ],
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/wallet-providers/passes/${encodeURIComponent(pass.id)}`,
        WalletProviderPassStatusSchema,
        { signal },
      ),
    enabled,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: enabled ? 15_000 : false,
  });
  if (!active || !allowed) return null;
  return (
    <Card className="min-w-0">
      <CardHeader
        title="Google & Samsung Wallet"
        actions={
          mode === pass.mode ? (
            <IconButton
              size="sm"
              label="Reload wallet status"
              data-busy={query.isFetching ? 'spin' : undefined}
              icon={<RefreshCw aria-hidden />}
              onClick={() => void query.refetch()}
            />
          ) : undefined
        }
      />
      {mode !== pass.mode ? (
        <CardBody>
          <p className="text-sm text-fg-muted">
            Switch to {pass.mode === 'live' ? 'Live' : 'Test'} mode to view wallet status.
          </p>
        </CardBody>
      ) : query.isError ? (
        <CardBody>
          <ErrorState
            inline
            subject="wallet status"
            error={query.error}
            onRetry={() => query.refetch()}
          />
        </CardBody>
      ) : !query.data ? (
        <CardBody>
          <SkeletonRows rows={2} label="Loading wallet status" />
        </CardBody>
      ) : (
        <CardBody>
          <ListRows label="Wallet provider instances">
            {query.data.providers.map((status) => (
              <ProviderRow key={status.provider} status={status} />
            ))}
          </ListRows>
        </CardBody>
      )}
    </Card>
  );
}
