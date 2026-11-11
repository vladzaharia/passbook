import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import type { MyPassListSchema } from '../../shared/contracts/me.ts';
import { MY_PASSES_BUNDLE_PATH, MY_PASSES_BUNDLE_SIZE } from '../../shared/contracts/me.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { addLine, canAddToWallet } from '../../shared/device.ts';
import { cn } from '../lib/cn.ts';
import { useArrival } from '../lib/motion.ts';
import { PassCardStage } from '../pass-card/index.tsx';
import {
  AppleWalletBadge,
  Buddy,
  type BuddyScene,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  Skeleton,
  StatusPill,
  type WalletMood,
} from '../ui/index.ts';
import { ModePill } from '../ui/layout/mode-pill.tsx';
import { myPassesQuery } from './api.ts';
import { browserDevice } from './device.ts';
import { type MyPass, passName, toView } from './pass-view.ts';
import { isPendingRefresh } from './refresh.ts';
import { RefreshButton } from './refresh-button.tsx';
import { useRemovalStatus } from './removal-status.ts';
import { AddLine, PassMoreMenu, publicUrlOf, ShowQrButton } from './wallet-actions.tsx';
import './portal.css';

// mt-8: the buddy's room over the first tile (56 px with the 24 px above), skeleton included.
const GRID = 'mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3';

/**
 * What the list's buddy acts out (motion-and-expression.md, The buddy). Passes to add: it aims at
 * the bundle badge above it (nudge) or, with one and no bundle, lifts a pass and drops it into its
 * pocket (tuck). Every live pass has a registration: it counts its own, happy. Only voided: a sigh.
 */
/** Still the holder's to add: not voided, not removed from Wallet. */
const isLive = (p: MyPass) => p.status !== 'voided' && p.removedAt === null;

export function listAct(passes: readonly MyPass[]): { mood?: WalletMood; scene: BuddyScene } {
  const live = passes.filter(isLive);
  const out = live.filter((p) => !p.inWallet).length;
  if (live.length === 0) return { mood: 'sad', scene: 'beat' };
  if (out === 0) return { mood: 'happy', scene: 'count' };
  return { scene: out > 1 ? 'nudge' : 'tuck' };
}

/** Seated on the first tile's top edge at its start, under the bundle badge; a new act re-enters. */
function ListBuddy({ passes }: { passes: readonly MyPass[] }) {
  const { mood, scene } = listAct(passes);
  return (
    <Buddy key={scene} size="sm" at="start" mood={mood} scene={scene} className="wl-list-buddy" />
  );
}

/** A reported Apple registration: the badge gives way to this pill. */
export function InWalletPill() {
  return <StatusPill status="in_wallet">{HOLDER_COPY.inWalletPill}</StatusPill>;
}

/**
 * Three rows of the list's grid (subgrid): the card, then title and org, then the actions, so a
 * row of tiles lines them up however their actions wrap. The actions beside the badge are
 * badge-sized outline buttons.
 */
function PassTile({ pass, dealt, buddy }: { pass: MyPass; dealt: boolean; buddy?: ReactNode }) {
  const name = passName(pass);
  const publicUrl = publicUrlOf(pass.downloadUrl);
  const removed = pass.removedAt !== null;
  const voided = pass.status === 'voided' || removed;
  // Where the badge cannot add, Show QR leads; elsewhere off the phone it waits in More.
  const [qr] = useState(() => !canAddToWallet(browserDevice().device));
  const [dip, setDip] = useState(0);
  const link = { to: '/passes/$passId', params: { passId: pass.id } } as const;
  return (
    // The tile's corner is the 18 px card radius: the pass inside draws ~14 px, never more.
    <Card className="row-span-3 grid grid-rows-subgrid gap-y-3 rounded-xl p-4">
      {buddy}
      {/* The card is a second way into the pass; the title link is the one in the tab order. */}
      <Link {...link} tabIndex={-1} aria-hidden className="mb-1 flex items-center">
        <PassCardStage
          view={toView(pass)}
          mint={voided ? undefined : `${pass.modifiedAt}:${pass.lastRefreshedAt}`}
          settle={pass.status}
          dip={dip}
          enter={dealt}
          dim={voided}
          removed={removed}
          syncing={isPendingRefresh(pass, Date.now())}
          transitionName={`pass-${pass.id}`}
        />
      </Link>
      <div className={cn('contents', dealt && 'wl-tile-chrome')}>
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
            <span className="flex shrink-0 items-center gap-1.5">
              <ModePill mode={pass.mode} />
              {voided ? (
                <StatusPill status={removed ? 'removed' : 'voided'} />
              ) : pass.inWallet ? (
                <InWalletPill />
              ) : (
                <StatusPill status="active" />
              )}
            </span>
          </div>
          <p className="truncate text-xs text-fg-muted">{pass.orgName}</p>
        </div>
        {/* As tall as the badge with its clear space (52, 56 on touch), badge or not. */}
        <div className="flex min-h-13 flex-wrap content-end items-center justify-between gap-2 pointer-coarse:min-h-14">
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link {...link}>View pass</Link>
            </Button>
            {voided || pass.inWallet || !qr || !publicUrl ? null : (
              <ShowQrButton passTitle={name} url={publicUrl} />
            )}
            {voided || pass.inWallet ? null : (
              <AppleWalletBadge href={pass.downloadUrl} onClick={() => setDip((n) => n + 1)} />
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {voided ? null : <RefreshButton passId={pass.id} pass={pass} compact />}
            <PassMoreMenu
              passId={pass.id}
              passTitle={name}
              publicUrl={voided ? null : publicUrl}
              inWallet={pass.inWallet}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

type BundleInfo = (typeof MyPassListSchema._output)['bundle'];

/** One badge per bundle of 10 passes not yet in a Wallet; a .pkpasses file is one add. */
function AddAllLinks({ bundle }: { bundle: NonNullable<BundleInfo> }) {
  const { count, parts, token } = bundle;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {Array.from({ length: parts }, (_, i) => {
        const from = i * MY_PASSES_BUNDLE_SIZE + 1;
        const to = Math.min(count, from + MY_PASSES_BUNDLE_SIZE - 1);
        return (
          <AppleWalletBadge
            key={from}
            href={`${MY_PASSES_BUNDLE_PATH}?part=${i + 1}&snapshot=${encodeURIComponent(token)}`}
            label={
              parts === 1
                ? HOLDER_COPY.addAllCount(count)
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
  const pending = query.data?.pages[0]?.pendingRemovals;
  useRemovalStatus(pending);
  const pendingRemovals = pending?.length ?? 0;
  const reissueRequired = query.data?.pages[0]?.reissueRequired ?? [];
  const dealt = useArrival(query.isPending);
  const bundle = query.data?.pages[0]?.bundle ?? null;
  const addable = bundle?.count ?? 0;
  const [device] = useState(browserDevice);

  let body: ReactNode;
  if (query.isPending) {
    body = (
      // A flex box like the list's, so the grid's margin adds to the header's instead of collapsing.
      <div className="flex flex-col">
        <div className={GRID} aria-busy="true">
          <Skeleton className="h-[34rem]" />
          <Skeleton className="h-[34rem] max-sm:hidden" />
          <Skeleton className="h-[34rem] max-lg:hidden" />
        </div>
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
        description={HOLDER_COPY.noPasses}
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
      <div className="wl-passes flex flex-col gap-6">
        {bundle && (addable > 1 || addLine(device)) ? (
          <section
            className="wl-bundle flex flex-col gap-3 rounded-2xl border border-border bg-surface-raised p-5 sm:p-6"
            aria-labelledby="bundle-title"
          >
            <div>
              <h2 id="bundle-title" className="text-lg font-semibold text-fg-strong">
                {addable > 1 ? HOLDER_COPY.addAllTitle : HOLDER_COPY.addAllOne}
              </h2>
            </div>
            {addable > 1 ? <AddAllLinks bundle={bundle} /> : null}
            <AddLine />
          </section>
        ) : null}
        <div>
          <div>
            <h2 className="text-lg font-semibold text-fg-strong">{HOLDER_COPY.fromOrgs}</h2>
          </div>
          <ul className={GRID}>
            {passes.map((pass, i) => (
              <li
                key={pass.id}
                className="row-span-3 grid min-w-0 grid-rows-subgrid"
                style={{ '--i': i } as CSSProperties}
              >
                <PassTile
                  pass={pass}
                  dealt={dealt}
                  buddy={i === 0 ? <ListBuddy passes={passes} /> : undefined}
                />
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
      <PageHeader
        title="My passes"
        className="rounded-2xl border border-border bg-surface-raised p-5 sm:p-6"
        actions={
          <Button asChild variant="outline">
            <Link to="/account">Manage account</Link>
          </Button>
        }
      />
      {pendingRemovals > 0 ? (
        <p
          role="status"
          className="mt-6 rounded-xl border border-border bg-surface-raised p-4 text-sm text-fg-muted"
        >
          {HOLDER_COPY.removalPending(pendingRemovals)} {HOLDER_COPY.removalPendingLine}
        </p>
      ) : null}
      {reissueRequired.length > 0 ? (
        <section
          className="mt-6 rounded-xl border border-border bg-surface-raised p-4"
          aria-labelledby="reissue-title"
        >
          <h2 id="reissue-title" className="text-sm font-semibold text-fg-strong">
            {HOLDER_COPY.reissueTitle}
          </h2>
          <ul className="mt-2 space-y-2 text-sm text-fg-muted">
            {reissueRequired.map((item) => {
              const href = item.support?.email ? `mailto:${item.support.email}` : item.support?.url;
              return (
                <li key={item.passId}>
                  {HOLDER_COPY.reissueLine(item.title ?? 'A pass', item.orgName)}{' '}
                  {href ? (
                    <a
                      href={href}
                      className="font-medium text-accent-fg underline-offset-4 hover:underline"
                    >
                      {HOLDER_COPY.contact(item.orgName)}
                    </a>
                  ) : (
                    HOLDER_COPY.reissueAsk(item.orgName)
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {body}
    </>
  );
}
