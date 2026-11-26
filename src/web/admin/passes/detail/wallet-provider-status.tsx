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
import type { Tone } from '../../../lib/status.ts';
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
  TechnicalDetails,
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

/** What an author reads: one pill and why. The local lifecycle and last operation sit under Technical details. */
function headline(status: WalletProviderInstanceStatus): {
  label: string;
  note?: string;
  tone: Tone;
} {
  const operation = status.desiredOperation;
  if (status.issuance.state === 'disabled')
    return { label: 'Not offered', note: 'Not open to holders yet.', tone: 'neutral' };
  if (status.lifecycle === 'blocked')
    return { label: 'Not offered', note: 'Blocked.', tone: 'warning' };
  if (status.lifecycle === 'revoked' || status.lifecycle === 'retired')
    return { label: 'Closed', tone: 'neutral' };
  if (status.lifecycle === 'revoking') return { label: 'Closing', tone: 'neutral' };
  if (operation?.state === 'failed')
    return {
      label: 'Not updating',
      ...(operation.reason ? { note: `${REASON[operation.reason]}.` } : {}),
      tone: 'danger',
    };
  if (
    operation?.state === 'pending' ||
    operation?.state === 'claimed' ||
    operation?.state === 'retry'
  )
    return { label: 'Updating', tone: 'neutral' };
  if (status.classReview === 'rejected') return { label: 'Rejected by Google', tone: 'danger' };
  if (status.classReview === 'waiting')
    return { label: 'Waiting for Google review', tone: 'neutral' };
  if (operation?.state === 'succeeded') return { label: 'Up to date', tone: 'success' };
  return { label: status.lifecycle === 'absent' ? 'Not added' : 'Ready', tone: 'neutral' };
}

const technicalOf = (status: WalletProviderInstanceStatus) => {
  const operation = status.desiredOperation;
  const last = operation
    ? `${operation.kind === 'upsert' ? 'Update' : 'Revocation'} v${operation.version}: ${OPERATION[operation.state]}${operation.reason ? ` (${REASON[operation.reason]})` : ''}`
    : 'No operation';
  return {
    label: status.provider === 'google' ? 'Google Wallet' : 'Samsung Wallet',
    value: `${LIFECYCLE[status.lifecycle]} · ${last}`,
    mono: false,
  };
};

function ProviderRow({ status }: { status: WalletProviderInstanceStatus }) {
  const { label, note, tone } = headline(status);
  return (
    <ListRow
      leading={<WalletCards aria-hidden />}
      title={status.provider === 'google' ? 'Google Wallet' : 'Samsung Wallet'}
      pills={
        <>
          <StatusPill status="wallet_instance" tone={tone}>
            {label}
          </StatusPill>
          {status.reported ? (
            <StatusPill
              status={status.reported.event === 'saved' ? 'wallet_saved' : 'wallet_removed'}
              tone={status.reported.event === 'saved' ? 'success' : 'warning'}
            >
              {status.reported.event === 'saved' ? 'Saved by holder' : 'Removed by holder'}
            </StatusPill>
          ) : null}
        </>
      }
      meta={
        <>
          {note ? (
            <span className="block">
              {note[0]?.toUpperCase()}
              {note.slice(1)}
            </span>
          ) : null}
          {status.reported ? (
            <span className="block">
              {`Provider reported ${status.reported.event === 'saved' ? 'a save' : 'a removal'}; not proof of what is on a device.`}
            </span>
          ) : null}
          {status.priorGenerationRetirementPending ? (
            <span className="block">A previous generation is still awaiting retirement.</span>
          ) : null}
        </>
      }
    />
  );
}

/** The pass's provider instances, read only for a member who may read passes, in the pass's mode. */
export function useWalletProviderStatus(
  pass: Pick<PassDetailDto, 'id' | 'orgId' | 'mode'>,
  active: boolean,
) {
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
  return { query, allowed, mode };
}

/** Independent provider instances, not device registrations or provider readiness. */
export function WalletProviderStatus({ pass, active }: { pass: PassDetailDto; active: boolean }) {
  const { query, allowed, mode } = useWalletProviderStatus(pass, active);
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
          <TechnicalDetails className="mt-3" items={query.data.providers.map(technicalOf)} />
        </CardBody>
      )}
    </Card>
  );
}
