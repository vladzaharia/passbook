import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Ban, Clock } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { MyPassListSchema } from '@/shared/contracts/me.ts';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { isApiError } from '../lib/errors.ts';
import { PassCardStage } from '../pass-card/index.tsx';
import {
  Breadcrumbs,
  Buddy,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  KeyValue,
  PassSideToggle,
  Skeleton,
  StatusPill,
} from '../ui/index.ts';
import { myPassesKey, myPassQuery } from './api.ts';
import { canAddToWallet } from './device.ts';
import { InWalletPill } from './my-passes-page.tsx';
import { fieldRows, updatedLine } from './pass-fields.ts';
import { type MyPass, passName, toView } from './pass-view.ts';
import { QrCode } from './qr-code.tsx';
import { isPendingRefresh } from './refresh.ts';
import { RefreshButton } from './refresh-button.tsx';
import { AddLine, AddToWalletButton, PassMoreMenu, publicUrlOf } from './wallet-actions.tsx';
import './portal.css';

type Page = typeof MyPassListSchema._output;

/** The list's copy of the pass, so a tile click shows the card on the first frame. */
function fromList(client: ReturnType<typeof useQueryClient>, id: string): MyPass | undefined {
  const list = client.getQueryData<InfiniteData<Page>>(myPassesKey);
  return list?.pages.flatMap((p) => p.items).find((p) => p.id === id);
}

const AREAS =
  'grid gap-6 [grid-template-areas:"title"_"pass"_"side"] lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-x-12 lg:[grid-template-areas:"pass_title"_"pass_side"] lg:grid-rows-[auto_1fr]';

function Detail({ pass, dealt }: { pass: MyPass; dealt: boolean }) {
  const navigate = useNavigate();
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [dip, setDip] = useState(0);
  const name = passName(pass);
  const view = toView(pass);
  const voided = pass.status === 'voided';
  const publicUrl = publicUrlOf(pass.downloadUrl);
  const canAdd = canAddToWallet();
  const active = !voided && !view.expired;
  const nudge = active && !pass.inWallet;
  useEffect(() => {
    document.title = `${name} · PassBook`;
  }, [name]);

  return (
    <div className={AREAS}>
      <div className="min-w-0 [grid-area:title]">
        <h1
          tabIndex={-1}
          className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong sm:text-3xl"
        >
          {name}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
          <span>{pass.orgName}</span>
          <span aria-hidden>·</span>
          <span>{updatedLine(pass.modifiedAt)}</span>
          {pass.inWallet && !voided ? <InWalletPill /> : null}
        </p>
      </div>
      <div className="flex min-w-0 flex-col items-center gap-3 [grid-area:pass]">
        <div className="relative isolate w-full max-w-[22rem]">
          <PassCardStage
            view={view}
            face={face}
            flippable
            enter={dealt}
            dim={voided}
            mint={voided ? undefined : `${pass.modifiedAt}:${pass.lastRefreshedAt}`}
            settle={pass.status}
            dip={dip}
            syncing={isPendingRefresh(pass, Date.now())}
            transitionName={`pass-${pass.id}`}
          />
        </div>
        <PassSideToggle value={face} onChange={setFace} />
      </div>
      <div
        className={`wl-pass-side flex min-w-0 flex-col gap-6 [grid-area:side] ${dealt ? 'wl-after-card' : ''}`}
      >
        {active && !canAdd && publicUrl ? (
          <Card className="flex flex-col items-center gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
            <QrCode value={publicUrl} label={`QR code for ${name}`} />
            <div className="flex flex-col gap-1 text-center sm:text-left">
              <p className="text-sm font-medium text-fg-strong">Scan with your iPhone.</p>
              <p className="text-sm text-fg-muted">{HOLDER_COPY.openOnApple}</p>
            </div>
          </Card>
        ) : null}
        {/* Refresh and More wrap as a pair, never one alone. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* In Wallet keeps the badge: a holder who removed the pass adds it back here. */}
          {active ? (
            <AddToWalletButton
              downloadUrl={pass.downloadUrl}
              onPress={() => setDip((n) => n + 1)}
            />
          ) : null}
          <div className="flex items-center gap-2">
            {voided ? null : <RefreshButton passId={pass.id} pass={pass} size="lg" />}
            <PassMoreMenu
              page
              passId={pass.id}
              passTitle={name}
              publicUrl={voided ? null : publicUrl}
              onRemoved={() => void navigate({ to: '/' })}
            />
          </div>
          {/* Room for the buddy's head beside the actions; it wraps under them when narrow. */}
          {nudge ? <span aria-hidden className="ml-auto h-5 w-18 self-end lg:h-8 lg:w-22" /> : null}
        </div>
        {/* Off iPhone the QR card says how to add; an iPhone app's web view needs Safari. */}
        {active && canAdd ? <AddLine className={nudge ? '-mt-3 pr-20' : '-mt-3'} /> : null}
        {voided ? (
          <Callout tone="warning" icon={Ban}>
            This pass was voided.
          </Callout>
        ) : view.expired ? (
          <Callout tone="warning" icon={Clock}>
            This pass has expired.
          </Callout>
        ) : null}
        <Card>
          {/* Not on a device yet: the buddy falls onto the card and points at the badge. */}
          {nudge ? <Buddy scene="nudge" size="sm" className="wl-nudge" /> : null}
          <CardHeader title="Details" />
          <CardBody>
            <KeyValue
              items={[
                { label: 'Status', value: <StatusPill status={pass.status} /> },
                ...fieldRows(pass.passJson),
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

export function PassDetailPage({ passId }: { passId: string }) {
  const client = useQueryClient();
  const [seed] = useState(() => fromList(client, passId));
  const query = useQuery({
    ...myPassQuery(passId),
    ...(seed
      ? {
          initialData: seed,
          initialDataUpdatedAt: client.getQueryState(myPassesKey)?.dataUpdatedAt,
        }
      : {}),
  });
  const crumbs = [
    { label: 'My passes', to: '/' },
    { label: query.data ? passName(query.data) : 'Pass' },
  ];

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div className={AREAS} aria-busy="true">
        <Skeleton className="h-16 [grid-area:title]" />
        <Skeleton className="mx-auto h-[28rem] w-full max-w-[22rem] [grid-area:pass]" />
        <Skeleton className="h-48 [grid-area:side]" />
      </div>
    );
  } else if (query.isError && isApiError(query.error) && query.error.isNotFound) {
    body = (
      <EmptyState
        heading
        art="wallet"
        artState="lost"
        title="Pass not found"
        action={
          <Button asChild variant="outline">
            <Link to="/">Back to My passes</Link>
          </Button>
        }
      />
    );
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else {
    // Arriving from the grid, the card morphs in; a deep link deals it instead.
    body = <Detail pass={query.data} dealt={!seed} />;
  }
  return (
    <>
      <Breadcrumbs items={crumbs} className="mb-4" />
      {body}
    </>
  );
}
