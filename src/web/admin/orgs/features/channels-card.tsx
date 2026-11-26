import { useState } from 'react';
import { stoppingLevel } from '@/shared/channels.ts';
import type { Channel } from '@/shared/contracts/channels.ts';
import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import type { PassSetup, SetupChannel } from '@/shared/contracts/pass-setup.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { channelStatusLine, PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { PASS_FIX_COPY } from '@/shared/copy/pass-setup-fix.ts';
import { cn } from '@/web/lib/cn.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import { usePassSetup } from '../../brand/api.ts';
import { ChainBadge, LockPill } from '../../brand/chain-badge.tsx';
import { CHANNEL_ICON } from '../../brand/channel-row.tsx';
import { PROVIDER_NAME, RELEASE, safeError } from '../../wallet-accounts/copy.ts';
import { HoldDialog } from '../../wallet-accounts/hold-dialog.tsx';
import { useWalletActions } from '../../wallet-accounts/queries.ts';

const COPY = PASS_FIX_COPY.platform;

/** The plan feature that includes a channel, where there is one. */
const PLAN_FEATURE: Partial<Record<Channel, EntitlementKey>> = {
  google: 'wallet.google',
  samsung: 'wallet.samsung',
  paper: 'print',
  nfc: 'nfc',
};

const ORDER: readonly Channel[] = ['apple', 'mobile', 'google', 'samsung', 'paper', 'nfc'];

type Wallet = 'google' | 'samsung';
const isWallet = (c: Channel): c is Wallet => c === 'google' || c === 'samsung';

function Row({
  channel,
  row,
  busy,
  onInclude,
  onHold,
  onRelease,
}: {
  channel: Channel;
  row: SetupChannel;
  busy: boolean;
  onInclude: (key: EntitlementKey) => void;
  onHold: () => void;
  onRelease: () => void;
}) {
  const Icon = CHANNEL_ICON[channel];
  const stop = stoppingLevel(row.levels);
  const feature = PLAN_FEATURE[channel];
  const held = row.account?.state === 'held';
  // A hold only means something once PassBook has released the wallet.
  const holdable =
    isWallet(channel) && row.account !== undefined && !held && stop?.level !== 'passbook';
  return (
    <li data-channel={channel} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-h-11 flex-wrap items-center gap-3">
        <span
          aria-hidden
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-strong text-fg-muted"
        >
          <Icon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-strong">
            {CHANNEL_LABEL[channel]}
            <LockPill levels={row.levels} />
            {held ? <Badge tone="warning">{COPY.held}</Badge> : null}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-fg-muted">
            <span
              aria-hidden
              className={cn(
                'size-1.5 rounded-full',
                row.on && row.templates.on > 0 ? 'bg-success' : 'bg-border-strong',
              )}
            />
            {isWallet(channel) && stop?.level === 'passbook'
              ? RELEASE.notReleased(PROVIDER_NAME[channel])
              : channelStatusLine({ levels: row.levels, templates: row.templates })}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {stop?.level === 'plan' && feature ? (
            <Button variant="outline" size="sm" onClick={() => onInclude(feature)}>
              {COPY.include}
            </Button>
          ) : null}
          {held ? (
            <Button variant="outline" size="sm" loading={busy} onClick={onRelease}>
              {COPY.release}
            </Button>
          ) : holdable ? (
            <Button variant="outline" size="sm" onClick={onHold}>
              {COPY.hold}
            </Button>
          ) : null}
        </span>
      </div>
      <ChainBadge levels={row.levels} templates={row.templates} />
    </li>
  );
}

function Rows({
  view,
  orgName,
  onInclude,
}: {
  view: PassSetup;
  orgName: string;
  onInclude: (key: EntitlementKey) => void;
}) {
  const actions = useWalletActions();
  const [holding, setHolding] = useState<Wallet>();
  const [busy, setBusy] = useState<Wallet>();
  async function release(provider: Wallet) {
    setBusy(provider);
    try {
      await actions.release(view.orgId, view.mode, provider);
      toast.success(`${PROVIDER_NAME[provider]} released`);
    } catch (cause) {
      toast.error(safeError(cause), 'Could not release');
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <>
      <ul className="m-0 list-none divide-y divide-border p-0">
        {ORDER.map((channel) => (
          <Row
            key={channel}
            channel={channel}
            row={view.channels[channel]}
            busy={busy === channel}
            onInclude={onInclude}
            onHold={() => isWallet(channel) && setHolding(channel)}
            onRelease={() => isWallet(channel) && void release(channel)}
          />
        ))}
      </ul>
      <HoldDialog
        enrolment={
          holding ? { orgId: view.orgId, orgName, mode: view.mode, provider: holding } : undefined
        }
        onClose={() => setHolding(undefined)}
      />
    </>
  );
}

/**
 * The org's channels as the org sees them, with the two levels only PassBook sets: Include (the
 * plan feature, through the override dialog below) and Hold (a released wallet's account).
 */
export function PlatformChannels({
  orgId,
  orgName,
  onInclude,
}: {
  orgId: string;
  orgName: string;
  onInclude: (key: EntitlementKey) => void;
}) {
  const setup = usePassSetup(orgId);
  return (
    <Card>
      <CardHeader
        title={COPY.channels}
        actions={
          setup.data ? <Badge>{PASS_SETUP_COPY.page.mode[setup.data.mode]}</Badge> : undefined
        }
      />
      <CardBody>
        {setup.isPending ? (
          <SkeletonRows label="Loading channels" />
        ) : setup.data ? (
          <Rows view={setup.data} orgName={orgName} onInclude={onInclude} />
        ) : (
          <ErrorState inline error={setup.error} onRetry={() => void setup.refetch()} />
        )}
      </CardBody>
    </Card>
  );
}
