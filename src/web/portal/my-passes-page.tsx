import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, WalletCards } from 'lucide-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { MY_PASSES_BUNDLE_PATH, MY_PASSES_BUNDLE_SIZE } from '../../shared/contracts/me.ts';
import { cn } from '../lib/cn.ts';
import { useArrival } from '../lib/motion.ts';
import { PassCardStage } from '../pass-card/index.tsx';
import {
  AppleWalletBadge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StatusPill,
} from '../ui/index.ts';
import { myPassesQuery } from './api.ts';
import { canAddToWallet } from './device.ts';
import { type MyPass, passName, toView } from './pass-view.ts';
import { isPendingRefresh } from './refresh.ts';
import { RefreshButton } from './refresh-button.tsx';
import { AddToWalletButton, PassMoreMenu, publicUrlOf, ShowQrButton } from './wallet-actions.tsx';
import './portal.css';

const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3';

/** A pass that is already in a Wallet: the badge gives way to this pill. */
export function InWalletPill() {
  return (
    <StatusPill status="in_wallet" tone="success" icon={WalletCards}>
      In Wallet
    </StatusPill>
  );
}

function PassTile({ pass, dealt }: { pass: MyPass; dealt: boolean }) {
  const name = passName(pass);
  const publicUrl = publicUrlOf(pass.downloadUrl);
  const voided = pass.status === 'voided';
  const canAdd = canAddToWallet();
  const [dip, setDip] = useState(0);
  const link = { to: '/passes/$passId', params: { passId: pass.id } } as const;
  return (
    <Card className="flex h-full w-full flex-col gap-4 p-4">
      {/* The card is a second way into the pass; the title link is the one in the tab order. */}
      <Link {...link} tabIndex={-1} aria-hidden className="flex flex-1 items-center">
        <PassCardStage
          view={toView(pass)}
          mint={`${pass.modifiedAt}:${pass.lastRefreshedAt}`}
          dip={dip}
          enter={dealt}
          dim={voided}
          syncing={isPendingRefresh(pass, Date.now())}
          transitionName={`pass-${pass.id}`}
        />
      </Link>
      <div className={cn('flex flex-col gap-3', dealt && 'wl-tile-chrome')}>
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h2 className="min-w-0 truncate text-sm font-semibold text-fg-strong">
              <Link
                {...link}
                className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {name}
              </Link>
            </h2>
            {voided ? <StatusPill status="voided" /> : pass.inWallet ? <InWalletPill /> : null}
          </div>
          <p className="truncate text-xs text-fg-muted">{pass.orgName}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {!voided && !canAdd && publicUrl ? (
              <ShowQrButton passTitle={name} url={publicUrl} />
            ) : null}
            {voided || pass.inWallet ? null : (
              <AddToWalletButton
                downloadUrl={pass.downloadUrl}
                onPress={() => setDip((n) => n + 1)}
              />
            )}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {voided ? null : <RefreshButton passId={pass.id} pass={pass} compact />}
            <PassMoreMenu
              passId={pass.id}
              passTitle={name}
              publicUrl={voided ? null : publicUrl}
              addAgainHref={pass.inWallet && !voided ? pass.downloadUrl : null}
            />
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
        <AddAllLinks count={addable} />
        <ul className={GRID}>
          {passes.map((pass, i) => (
            <li key={pass.id} className="flex min-w-0" style={{ '--i': i } as CSSProperties}>
              <PassTile pass={pass} dealt={dealt} />
            </li>
          ))}
        </ul>
        {query.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="outline"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <PageHeader title="My passes" size="lg" />
      {body}
    </>
  );
}
