import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { MY_PASSES_BUNDLE_PATH, MY_PASSES_BUNDLE_SIZE } from '../../shared/contracts/me.ts';
import { showsAddQr } from '../../shared/device.ts';
import { cn } from '../lib/cn.ts';
import { useArrival } from '../lib/motion.ts';
import { PassCardStage } from '../pass-card/index.tsx';
import {
  AppleWalletBadge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  Skeleton,
  StatusPill,
} from '../ui/index.ts';
import { myPassesQuery } from './api.ts';
import { browserDevice } from './device.ts';
import { type MyPass, passName, toView } from './pass-view.ts';
import { isPendingRefresh } from './refresh.ts';
import { RefreshButton } from './refresh-button.tsx';
import { AddLine, PassMoreMenu, publicUrlOf, ShowQrButton } from './wallet-actions.tsx';
import './portal.css';

const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3';

/** A pass that is already in a Wallet: the badge gives way to this pill. */
export function InWalletPill() {
  return <StatusPill status="in_wallet" />;
}

/**
 * A flex column: the card takes the free height, so the title, org and actions sit at the bottom
 * on one line across a row of tiles. The actions beside the badge are badge-sized outline buttons.
 */
function PassTile({ pass, dealt }: { pass: MyPass; dealt: boolean }) {
  const name = passName(pass);
  const publicUrl = publicUrlOf(pass.downloadUrl);
  const voided = pass.status === 'voided';
  const [qr] = useState(() => showsAddQr(browserDevice().device));
  const [dip, setDip] = useState(0);
  const link = { to: '/passes/$passId', params: { passId: pass.id } } as const;
  return (
    // The tile's corner is the 18 px card radius: the pass inside draws ~14 px, never more.
    <Card className="flex h-full w-full flex-col gap-4 rounded-xl p-4">
      {/* The card is a second way into the pass; the title link is the one in the tab order. */}
      <Link {...link} tabIndex={-1} aria-hidden className="flex flex-1 items-center">
        <PassCardStage
          view={toView(pass)}
          mint={voided ? undefined : `${pass.modifiedAt}:${pass.lastRefreshedAt}`}
          settle={pass.status}
          dip={dip}
          enter={dealt}
          dim={voided}
          syncing={isPendingRefresh(pass, Date.now())}
          transitionName={`pass-${pass.id}`}
        />
      </Link>
      <div className={cn('mt-auto flex flex-col gap-3', dealt && 'wl-tile-chrome')}>
        <div className="min-w-0">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <h2 className="min-w-0 text-sm font-semibold text-fg-strong">
              {/* A block link truncates on its own box, so the 44 px touch padding is not clipped. */}
              <Link
                {...link}
                className="block truncate rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:-my-3 pointer-coarse:py-3"
              >
                {name}
              </Link>
            </h2>
            {voided ? <StatusPill status="voided" /> : pass.inWallet ? <InWalletPill /> : null}
          </div>
          <p className="truncate text-xs text-fg-muted">{pass.orgName}</p>
        </div>
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 pointer-coarse:min-h-11">
          <div className="flex flex-wrap items-center gap-2">
            {!voided && qr && publicUrl ? <ShowQrButton passTitle={name} url={publicUrl} /> : null}
            {voided || pass.inWallet ? null : (
              <AppleWalletBadge href={pass.downloadUrl} onClick={() => setDip((n) => n + 1)} />
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {voided ? null : <RefreshButton passId={pass.id} pass={pass} compact />}
            <PassMoreMenu passId={pass.id} passTitle={name} publicUrl={voided ? null : publicUrl} />
          </div>
        </div>
      </div>
    </Card>
  );
}

/** One badge per bundle of 10 passes not yet in a Wallet; a .pkpasses file is one add. */
function AddAllLinks({ count }: { count: number }) {
  if (count < 2) return null;
  const parts = Math.ceil(count / MY_PASSES_BUNDLE_SIZE);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {Array.from({ length: parts }, (_, i) => {
        const from = i * MY_PASSES_BUNDLE_SIZE + 1;
        const to = Math.min(count, from + MY_PASSES_BUNDLE_SIZE - 1);
        return (
          <AppleWalletBadge
            key={from}
            href={`${MY_PASSES_BUNDLE_PATH}?part=${i + 1}`}
            label={
              parts === 1
                ? `All passes (${count})`
                : `Passes ${from === to ? from : `${from}–${to}`}`
            }
          />
        );
      })}
    </div>
  );
}

export function MyPassesPage() {
  const query = useInfiniteQuery(myPassesQuery);
  const passes = query.data?.pages.flatMap((p) => p.items) ?? [];
  const dealt = useArrival(query.isPending);
  const addable = passes.filter((p) => p.status !== 'voided' && !p.inWallet).length;

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div className={GRID} aria-busy="true">
        <Skeleton className="h-[34rem]" />
        <Skeleton className="h-[34rem] max-sm:hidden" />
        <Skeleton className="h-[34rem] max-lg:hidden" />
      </div>
    );
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (passes.length === 0) {
    body = (
      <EmptyState
        art="wallet"
        artState="empty"
        title="No passes"
        description="Passes sent to your emails show up here."
        action={
          <Button asChild variant="outline" iconStart={<Plus aria-hidden />}>
            <Link to="/account" search={{ add: 'email' }}>
              Add another email
            </Link>
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        {addable > 0 ? (
          <div className="flex flex-col gap-2">
            <AddAllLinks count={addable} />
            <AddLine />
          </div>
        ) : null}
        <div>
          <ul className={GRID}>
            {passes.map((pass, i) => (
              <li key={pass.id} className="flex min-w-0" style={{ '--i': i } as CSSProperties}>
                <PassTile pass={pass} dealt={dealt} />
              </li>
            ))}
          </ul>
          <LoadMore query={query} />
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader title="My passes" />
      {body}
    </>
  );
}
