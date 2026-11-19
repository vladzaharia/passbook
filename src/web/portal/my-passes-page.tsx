import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import type { MyPassListSchema } from '../../shared/contracts/me.ts';
import { MY_PASSES_BUNDLE_PATH, MY_PASSES_BUNDLE_SIZE } from '../../shared/contracts/me.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { addLine } from '../../shared/device.ts';
import { useArrival } from '../lib/motion.ts';
import {
  AppleWalletBadge,
  Buddy,
  type BuddyScene,
  Button,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  Skeleton,
  type WalletMood,
} from '../ui/index.ts';
import { myPassesQuery } from './api.ts';
import { browserDevice } from './device.ts';
import { PassTile } from './pass-tile.tsx';
import type { MyPass } from './pass-view.ts';
import { useRemovalStatus } from './removal-status.ts';
import { AddLine } from './wallet-actions.tsx';
import './portal.css';

// The buddy's room over the first tile (32 px and the 24 px gap above), skeleton included.
const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3';
const GRID_ROOM = `wl-buddy-room [--wl-buddy-room:2rem] ${GRID}`;

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

function PassGrid({
  passes,
  dealt,
  lead,
}: {
  passes: readonly MyPass[];
  dealt: boolean;
  /** The first tile carries the list's buddy. */
  lead: boolean;
}) {
  return (
    <ul className={lead ? GRID_ROOM : GRID}>
      {passes.map((pass, i) => (
        <li
          key={pass.id}
          className="row-span-3 grid min-w-0 grid-rows-subgrid"
          style={{ '--i': i } as CSSProperties}
        >
          <PassTile
            pass={pass}
            dealt={dealt}
            buddy={lead && i === 0 ? <ListBuddy passes={passes} /> : undefined}
          />
        </li>
      ))}
    </ul>
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
  const live = passes.filter(isLive);
  const off = passes.filter((p) => !isLive(p));
  const bundle = query.data?.pages[0]?.bundle ?? null;
  const addable = bundle?.count ?? 0;
  const [device] = useState(browserDevice);

  let body: ReactNode;
  if (query.isPending) {
    body = (
      // A flex box like the list's, so the grid's margin adds to the header's instead of collapsing.
      <div className="flex flex-col">
        <div className={GRID_ROOM} aria-busy="true">
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
            className="wl-bundle flex flex-col gap-3 sm:self-start rounded-2xl border border-border bg-surface-raised p-5 sm:p-6"
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
        <div className="flex flex-col gap-8">
          <PassGrid passes={live} dealt={dealt} lead />
          {off.length > 0 ? (
            <section aria-labelledby="ended-title" className="flex flex-col gap-4">
              {live.length > 0 ? (
                <h2 id="ended-title" className="text-sm font-semibold text-fg-strong">
                  {HOLDER_COPY.endedTitle}
                </h2>
              ) : null}
              <PassGrid passes={off} dealt={dealt} lead={live.length === 0} />
            </section>
          ) : null}
          <LoadMore query={query} />
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="My passes"
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
