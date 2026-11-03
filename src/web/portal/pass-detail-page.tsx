import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { MyPassListSchema } from '@/shared/contracts/me.ts';
import { canAddToWallet } from '@/shared/device.ts';
import type { AddDirection } from '../../shared/add-direction.ts';
import { cn } from '../lib/cn.ts';
import { useDocumentTitle } from '../lib/route-focus.tsx';
import { PassCardStage } from '../pass-card/index.tsx';
import {
  Buddy,
  Card,
  CardBody,
  CardHeader,
  detailError,
  KeyValue,
  PageHeader,
  PassSideToggle,
  Skeleton,
  StatusPill,
} from '../ui/index.ts';
import { myPassesKey, myPassQuery } from './api.ts';
import { browserDevice } from './device.ts';
import { HolderPassView, showsQr } from './holder-pass-view.tsx';
import { InWalletPill } from './my-passes-page.tsx';
import { exploreOf, portalDirection } from './pass-explore.tsx';
import { fieldRows, updatedLine } from './pass-fields.ts';
import { type MyPass, passName, toView } from './pass-view.ts';
import { isPendingRefresh } from './refresh.ts';
import { RefreshButton } from './refresh-button.tsx';
import { PassMoreMenu, publicUrlOf } from './wallet-actions.tsx';
import './portal.css';

type Page = typeof MyPassListSchema._output;

/** The list's copy of the pass, so a tile click shows the card on the first frame. */
function fromList(client: ReturnType<typeof useQueryClient>, id: string): MyPass | undefined {
  const list = client.getQueryData<InfiniteData<Page>>(myPassesKey);
  return list?.pages.flatMap((p) => p.items).find((p) => p.id === id);
}

const crumbsFor = (name: string) => [{ label: 'My passes', to: '/' }, { label: name }];

/**
 * Where the nudge sits on the Details card's top edge (portal.css): past the stack beside the QR,
 * or under the badge's row on the phone.
 */
type NudgeSeat = 'beside' | 'under';

/** Status and the pass's fields. Not on a device yet, the buddy falls onto it and points. */
function DetailsCard({ pass, nudge }: { pass: MyPass; nudge: NudgeSeat | null }) {
  return (
    <Card className={nudge === 'under' ? 'mt-8' : nudge === 'beside' ? 'mt-2' : undefined}>
      {nudge ? (
        <Buddy
          scene="nudge"
          size="sm"
          at="start"
          className={cn('wl-nudge', nudge === 'beside' && 'wl-nudge-beside')}
        />
      ) : null}
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
  );
}

function Detail({
  pass,
  dealt,
  direction,
}: {
  pass: MyPass;
  dealt: boolean;
  direction: AddDirection | null;
}) {
  const navigate = useNavigate();
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [dip, setDip] = useState(0);
  const [device] = useState(browserDevice);
  const name = passName(pass);
  const view = toView(pass);
  const voided = pass.status === 'voided';
  const state = voided ? 'voided' : view.expired ? 'expired' : 'active';
  const publicUrl = publicUrlOf(pass.downloadUrl);
  const stacked = showsQr(state, device, publicUrl);
  const explore = direction ? exploreOf(direction, pass, view, state, name) : null;
  // In Wallet keeps the badge (a holder who removed the pass adds it back) but not the nudge;
  // nor does a device whose badge cannot add (its line says where to go instead). An
  // exploration seats its own art.
  const nudge =
    !explore && state === 'active' && !pass.inWallet && canAddToWallet(device.device)
      ? stacked
        ? 'beside'
        : 'under'
      : null;
  // Explorations put Refresh and More in the header: page-sized, More as an icon in b.
  const header = explore !== null;
  return (
    <HolderPassView
      pass={
        <PassCardStage
          view={view}
          face={face}
          flippable
          enter={dealt}
          dim={state !== 'active'}
          mint={voided ? undefined : `${pass.modifiedAt}:${pass.lastRefreshedAt}`}
          settle={pass.status}
          dip={dip}
          syncing={isPendingRefresh(pass, Date.now())}
          transitionName={`pass-${pass.id}`}
        />
      }
      toggle={<PassSideToggle value={face} onChange={setFace} />}
      passTitle={name}
      orgName={pass.orgName}
      state={state}
      device={device}
      downloadHref={pass.downloadUrl}
      publicUrl={publicUrl}
      support={pass.support}
      onAdd={() => setDip((n) => n + 1)}
      rise={dealt}
      actions={
        <>
          {explore ? <DocumentTitle title={explore.heading.title} /> : null}
          {voided ? null : (
            <RefreshButton
              passId={pass.id}
              pass={pass}
              size={header ? 'md' : 'badge'}
              compact={explore?.direction === 'b'}
            />
          )}
          <PassMoreMenu
            page
            stacked={stacked && !header}
            size={header ? 'md' : 'badge'}
            icon={explore?.direction === 'b'}
            passId={pass.id}
            passTitle={name}
            publicUrl={voided ? null : publicUrl}
            onRemoved={() => void navigate({ to: '/', replace: true })}
          />
        </>
      }
      details={<DetailsCard pass={pass} nudge={nudge} />}
      explore={explore}
    />
  );
}

/** An exploration has no PageHeader: its header names the tab. */
function DocumentTitle({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

/** Org, last update and In Wallet under the h1. */
function Meta({ pass }: { pass: MyPass }) {
  return (
    <>
      <span>{pass.orgName}</span>
      <span>{updatedLine(pass.modifiedAt)}</span>
      {pass.inWallet && pass.status !== 'voided' ? <InWalletPill /> : null}
    </>
  );
}

export function PassDetailPage({ passId }: { passId: string }) {
  const client = useQueryClient();
  const [seed] = useState(() => fromList(client, passId));
  const [direction] = useState(portalDirection);
  const query = useQuery({
    ...myPassQuery(passId),
    ...(seed
      ? {
          initialData: seed,
          initialDataUpdatedAt: client.getQueryState(myPassesKey)?.dataUpdatedAt,
        }
      : {}),
  });

  // One header in every state, so the h1 keeps its node (and focus) as the pass arrives.
  const pass = query.data;
  const name = pass ? passName(pass) : 'Pass';
  const header = (
    <PageHeader
      title={name}
      breadcrumbs={crumbsFor(name)}
      meta={pass ? <Meta pass={pass} /> : undefined}
    />
  );
  if (pass) {
    // Arriving from the grid, the card morphs in; a deep link deals it instead. An exploration
    // draws its own header.
    return (
      <>
        {direction ? null : header}
        <Detail pass={pass} dealt={!seed} direction={direction} />
      </>
    );
  }
  if (query.isError) {
    // A pass that is not there is an entity not found: the torn pass the buddy mends.
    return detailError(query, { entity: 'pass', to: '/', back: 'My passes', header });
  }
  return (
    <>
      {header}
      <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-x-12" aria-busy="true">
        <Skeleton className="mx-auto h-[28rem] w-full max-w-[22rem]" />
        <Skeleton className="h-48" />
      </div>
    </>
  );
}
