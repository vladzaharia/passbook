import { useState } from 'react';
import type { WalletHealth } from '@/shared/contracts/wallet-health.ts';
import type { WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import { cn } from '@/web/lib/cn.ts';
import { formatDateTimeIn, formatFullIn } from '@/web/lib/format.ts';
import type { Tone } from '@/web/lib/status.ts';
import {
  Button,
  Callout,
  ErrorState,
  Skeleton,
  StatusPill,
  toast,
  WalletArt,
} from '@/web/ui/index.ts';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';
import { HEALTH, safeError } from './copy.ts';
import { useOrgWalletHealth, useWalletRecheck } from './health-queries.ts';

const TONE: Record<WalletHealth['tone'], Tone> = {
  ok: 'success',
  attention: 'warning',
  failing: 'danger',
  idle: 'neutral',
};
const MOOD = { ok: 'happy', attention: 'curious', failing: 'sad', idle: 'flat' } as const;

function Fact({
  label,
  value,
  hot,
}: {
  label: string;
  value: React.ReactNode;
  hot?: 'warning' | 'danger' | false;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface-sunken px-3 py-2">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd
        className={cn(
          'text-sm font-medium tabular-nums',
          hot === 'danger' ? 'text-danger' : hot ? 'text-warning' : 'text-fg-strong',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Moment({ at, zone }: { at: number | null; zone: string }) {
  if (at === null) return <span className="text-fg-muted">{HEALTH.none}</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatFullIn(at, zone)}>
      {formatDateTimeIn(at, zone)}
    </time>
  );
}

/**
 * One wallet's health for the org in the current mode. The server lists only wallets open to the
 * org, so a wallet that is off at platform or plan level has no panel and no placeholder.
 */
export function WalletHealthPanel({
  orgId,
  provider,
  canOperate,
}: {
  orgId: string;
  provider: WalletProvider;
  /** passes:operate: a recheck is a pass action, not an account one. */
  canOperate: boolean;
}) {
  const zone = useOrgTimeZone(orgId);
  const health = useOrgWalletHealth(orgId);
  const recheck = useWalletRecheck(orgId);
  const [busy, setBusy] = useState(false);
  const item = health.data?.items.find((i) => i.provider === provider);

  if (health.isPending)
    return (
      <div
        role="status"
        aria-label="Loading"
        className="flex flex-col gap-3 border-t border-border pt-4"
      >
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[3.375rem]" />
          ))}
        </div>
      </div>
    );
  if (health.isError)
    return (
      <div className="border-t border-border pt-4">
        <ErrorState title={HEALTH.loadError} onRetry={() => void health.refetch()} />
      </div>
    );
  if (!item) return null;

  const stuck = item.uncertain - item.uncertainWaiting;
  async function run() {
    setBusy(true);
    try {
      const result = await recheck(provider);
      if (result.due > 0) toast.success(HEALTH.rechecked);
      else toast.info(HEALTH.nothingDue);
    } catch (cause) {
      toast.error(safeError(cause), 'Could not check');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={HEALTH.title} className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex items-center gap-3">
        <WalletArt size="sm" mood={MOOD[item.tone]} aria-hidden className="-my-2 shrink-0" />
        <h3 className="text-sm font-medium text-fg-strong">{HEALTH.title}</h3>
        <StatusPill status={`wallet_health_${item.tone}`} tone={TONE[item.tone]}>
          {HEALTH.tone[item.tone]}
        </StatusPill>
      </div>
      <dl className="m-0 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Fact label={HEALTH.lastUpdate} value={<Moment at={item.lastSuccessAt} zone={zone} />} />
        <Fact label={HEALTH.queued} value={item.queued} />
        <Fact
          label={HEALTH.failed}
          value={item.failed24h}
          hot={item.failed24h > 0 && (item.tone === 'failing' ? 'danger' : 'warning')}
        />
        <Fact label={HEALTH.report} value={<Moment at={item.callbackAt} zone={zone} />} />
      </dl>
      {item.tone === 'failing' ? <Callout tone="danger">{HEALTH.failing}</Callout> : null}
      {item.uncertain > 0 ? (
        <Callout
          tone="warning"
          title={HEALTH.unknown(item.uncertain)}
          actionsAside
          actions={
            canOperate ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || stuck === 0}
                onClick={() => void run()}
              >
                {HEALTH.recheck}
              </Button>
            ) : null
          }
        >
          {stuck > 0 ? HEALTH.due : HEALTH.waiting}
        </Callout>
      ) : null}
    </section>
  );
}
