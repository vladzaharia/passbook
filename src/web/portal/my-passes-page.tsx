import './preload-barcode.ts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { MyPassListSchema } from '../../shared/contracts/me.ts';
import { MY_PASSES_BUNDLE_PATH, MY_PASSES_BUNDLE_SIZE } from '../../shared/contracts/me.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { canAddToWallet } from '../../shared/device.ts';
import { useMediaQuery } from '../lib/media.ts';
import { useArrival } from '../lib/motion.ts';
import { useDocumentTitle } from '../lib/route-focus.tsx';
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
import { MyPassesStack, type StackItem } from './my-passes-stack.tsx';
import { PassDetailPage } from './pass-detail-page.tsx';
import { PassNotices } from './pass-notices.tsx';
import { type MyPass, toView } from './pass-view.ts';
import { pickWithTransition, stackNavigation } from './stack-motion.ts';
import { frontOf, groupPasses } from './stack-order.ts';
import { StackPanel } from './stack-panel.tsx';
import { AddLine } from './wallet-actions.tsx';
import './portal.css';

/** Master-detail from here: the stack beside the front pass's page. */
export const STACK_WIDE = '(min-width: 768px)';

/** Still the holder's: not voided, not removed from Wallet. */
const stillOn = (p: MyPass) => p.status !== 'voided' && p.removedAt === null;

/**
 * What the list's buddy acts out (motion-and-expression.md, The buddy). Passes to add: it aims at
 * the bundle badge above it (nudge) or, with one and no bundle, lifts a pass and drops it into its
 * pocket (tuck). Every live pass has a registration: it counts its own, happy. Only voided: a sigh.
 */
export function listAct(passes: readonly MyPass[]): { mood?: WalletMood; scene: BuddyScene } {
  const live = passes.filter(stillOn);
  const out = live.filter((p) => !p.inWallet).length;
  if (live.length === 0) return { mood: 'sad', scene: 'beat' };
  if (out === 0) return { mood: 'happy', scene: 'count' };
  return { scene: out > 1 ? 'nudge' : 'tuck' };
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

/** /passes/:id wide: the pass is the page's h1, so My passes is a way back, set as the title. */
function SelectedTitle({ actions }: { actions: ReactNode }) {
  useDocumentTitle('My passes');
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <p className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong">
        <Link to="/" className="rounded-sm underline-offset-4 hover:underline">
          My passes
        </Link>
      </p>
      {actions}
    </header>
  );
}

/**
 * My passes as Wallet's stack (PassStack): the front pass full size with its row, the rest as
 * peeks, then Test and Voided and expired. From 768 px the front pass's page sits beside it, and
 * /passes/:id is this page with that pass in front (`selectedId`).
 */
export function MyPassesPage({ selectedId }: { selectedId?: string }) {
  const query = useInfiniteQuery(myPassesQuery);
  const pages = query.data?.pages;
  const passes = useMemo(() => pages?.flatMap((p) => p.items) ?? [], [pages]);
  const dealt = useArrival(query.isPending);
  const bundle = pages?.[0]?.bundle ?? null;
  const addable = bundle?.count ?? 0;
  const [device] = useState(browserDevice);
  const wide = useMediaQuery(STACK_WIDE);
  const navigate = useNavigate();
  const [picked, setPicked] = useState<string | null>(null);
  const [raise, setRaise] = useState(false);
  const nameRef = useRef<HTMLAnchorElement>(null);
  const focusFront = useRef(false);

  const items = useMemo<StackItem[]>(
    () => passes.map((pass) => ({ pass, view: toView(pass) })),
    [passes],
  );
  const groups = useMemo(() => groupPasses(items), [items]);
  const want = selectedId ?? picked;
  const front = items.find((i) => i.pass.id === want) ?? frontOf(groups, Date.now());
  const act = listAct(passes);

  // A peek came forward: its name link takes the focus the peek had.
  useEffect(() => {
    if (!focusFront.current) return;
    focusFront.current = false;
    nameRef.current?.focus({ preventScroll: true });
  });

  // A pass the loaded list does not hold (a later page, or not the holder's): its own page.
  if (selectedId && query.isSuccess && !items.some((i) => i.pass.id === selectedId)) {
    return <PassDetailPage passId={selectedId} />;
  }

  const pick = (id: string) => {
    if (wide) {
      void navigate({
        to: '/passes/$passId',
        params: { passId: id },
        viewTransition: stackNavigation(),
      });
      return;
    }
    focusFront.current = true;
    const morphed = pickWithTransition(() => setPicked(id));
    setRaise(!morphed);
  };

  const bundleRow =
    canAddToWallet(device.device) && ((bundle && addable > 1) || device.inApp) ? (
      // No card and no title: the badge says what it adds; Apple's line only in an app's
      // web view, which cannot add. A computer gets Show QR on the front pass instead.
      <div className="wl-bundle flex flex-wrap items-center gap-x-4 gap-y-2">
        {bundle && addable > 1 ? <AddAllLinks bundle={bundle} /> : null}
        <AddLine />
      </div>
    ) : null;

  let body: ReactNode;
  if (query.isPending) {
    body = (
      // A flex box like the list's, so the room's margin adds to the header's, never collapses.
      <div className="flex flex-col">
        <div
          className="wl-buddy-room w-full max-w-[22rem] [--wl-buddy-room:3.5rem] max-md:mx-auto"
          aria-busy="true"
        >
          <Skeleton className="aspect-[320/460] w-full rounded-xl" />
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
      <div className="wl-passes wl-mp" data-wide={(wide && front !== null) || undefined}>
        <div className="wl-mp-side">
          {wide ? null : bundleRow}
          <MyPassesStack
            groups={groups}
            front={front}
            dealt={dealt}
            raise={raise}
            nameRef={nameRef}
            onPick={pick}
            buddy={<Buddy key={act.scene} size="sm" at="end" {...act} className="wl-list-buddy" />}
            selected={wide && selectedId === front?.pass.id}
            {...(selectedId
              ? { onFrontRemoved: () => void navigate({ to: '/', replace: true }) }
              : {})}
          />
          <LoadMore query={query} />
        </div>
        {wide && front ? <StackPanel seed={front.pass} level={selectedId ? 1 : 2} /> : null}
      </div>
    );
  }

  const actions = wide ? bundleRow : null;
  return (
    <>
      {selectedId ? (
        <SelectedTitle actions={actions} />
      ) : (
        <PageHeader title="My passes" actions={actions ?? undefined} />
      )}
      <PassNotices
        pending={pages?.[0]?.pendingRemovals.length ?? 0}
        reissue={pages?.[0]?.reissueRequired ?? []}
      />
      {body}
    </>
  );
}
