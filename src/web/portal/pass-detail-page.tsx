import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { MyPassListSchema } from '@/shared/contracts/me.ts';
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
import { HolderPassView } from './holder-pass-view.tsx';
import { InWalletPill } from './my-passes-page.tsx';
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

/** Status and the pass's fields. Not on a device yet, the buddy falls onto it under the badge. */
function DetailsCard({ pass, nudge }: { pass: MyPass; nudge: boolean }) {
  return (
    <Card className={nudge ? 'mt-8' : undefined}>
      {nudge ? <Buddy scene="nudge" size="sm" at="start" className="wl-nudge" /> : null}
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

function Detail({ pass, dealt }: { pass: MyPass; dealt: boolean }) {
  const navigate = useNavigate();
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [dip, setDip] = useState(0);
  const [device] = useState(browserDevice);
  const name = passName(pass);
  const view = toView(pass);
  const voided = pass.status === 'voided';
  const state = voided ? 'voided' : view.expired ? 'expired' : 'active';
  const publicUrl = publicUrlOf(pass.downloadUrl);
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
          {voided ? null : <RefreshButton passId={pass.id} pass={pass} size="badge" />}
          <PassMoreMenu
            page
            passId={pass.id}
            passTitle={name}
            publicUrl={voided ? null : publicUrl}
            onRemoved={() => void navigate({ to: '/', replace: true })}
          />
        </>
      }
      // In Wallet keeps the badge (a holder who removed the pass adds it back) but not the nudge.
      details={<DetailsCard pass={pass} nudge={state === 'active' && !pass.inWallet} />}
    />
  );
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
    // Arriving from the grid, the card morphs in; a deep link deals it instead.
    return (
      <>
        {header}
        <Detail pass={pass} dealt={!seed} />
      </>
    );
  }
  if (query.isError) {
    return detailError(query, { entity: 'pass', to: '/', back: 'My passes', lost: true, header });
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
