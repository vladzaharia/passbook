import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { MyPassListSchema } from '@/shared/contracts/me.ts';
import { endedOn } from '@/shared/ended-on.ts';
import type { PassView } from '@/shared/pass-view/index.ts';
import { useSession } from '../lib/session.ts';
import { Upcoming } from '../pass-card/back.tsx';
import { PassCardStage } from '../pass-card/index.tsx';
import {
  Buddy,
  Card,
  CardBody,
  CardHeader,
  detailError,
  KeyValue,
  Skeleton,
  StatusPill,
} from '../ui/index.ts';
import { myPassesKey, myPassQuery } from './api.ts';
import { browserDevice } from './device.ts';
import { HolderPassView } from './holder-pass-view.tsx';
import { fieldRows } from './pass-fields.ts';
import { PassHeader } from './pass-header.tsx';
import { type HolderState, holderPassName, holderState, type MyPass, toView } from './pass-view.ts';
import { isPendingRefresh } from './refresh.ts';
import { TagsCard } from './tags-card.tsx';
import { publicUrlOf } from './wallet-actions.tsx';
import './portal.css';

type Page = typeof MyPassListSchema._output;

/** The list's copy of the pass, so a tile click shows the card on the first frame. */
function fromList(client: ReturnType<typeof useQueryClient>, id: string): MyPass | undefined {
  const list = client.getQueryData<InfiniteData<Page>>(myPassesKey);
  return list?.pages.flatMap((p) => p.items).find((p) => p.id === id);
}

/** The pass's fields, then its upcoming events. The header's pill carries the state. */
function DetailsCard({
  pass,
  view,
  state,
  title,
}: {
  pass: MyPass;
  view: PassView;
  state: HolderState;
  title: string;
}) {
  // The card already says what the pass is called.
  const rows = fieldRows(pass.passJson).filter((r) => r.value !== title);
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody className="flex flex-col gap-4">
        <KeyValue
          items={
            state === 'active'
              ? [{ label: 'Status', value: <StatusPill status="active" /> }, ...rows]
              : rows
          }
        />
        {view.upcoming.length ? (
          <div className="pc-flat">
            <Upcoming events={view.upcoming} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Detail({
  pass,
  view,
  state,
  dealt,
}: {
  pass: MyPass;
  view: PassView;
  state: HolderState;
  dealt: boolean;
}) {
  const [dip, setDip] = useState(0);
  const [device] = useState(browserDevice);
  const { authed } = useSession();
  const title = holderPassName(pass, authed?.user);
  const stale = state === 'voided' || state === 'removed';
  const publicUrl = publicUrlOf(pass.pageUrl ?? pass.downloadUrl);
  const printUrl = pass.holderPrint && publicUrl ? `${publicUrl}/print` : undefined;
  return (
    <HolderPassView
      pass={
        <PassCardStage
          view={view}
          enter={dealt}
          dim={state !== 'active'}
          removed={state === 'removed'}
          mint={stale ? undefined : `${pass.modifiedAt}:${pass.lastRefreshedAt}`}
          settle={pass.status}
          dip={dip}
          syncing={isPendingRefresh(pass, Date.now())}
          transitionName={`pass-${pass.id}`}
        />
      }
      passTitle={title}
      orgName={pass.orgName}
      state={state}
      removalMessage={pass.removalMessage}
      device={device}
      downloadHref={pass.downloadUrl}
      channels={pass.channels}
      printHref={printUrl}
      walletOffers={pass.presentationEligible === true ? pass.walletOffers : []}
      issuance={pass.walletIssuance}
      barcodeHref={
        // On the phone that adds, the badge leads and the card carries the code.
        pass.presentationEligible === true &&
        pass.channels?.mobile.on !== false &&
        device.device !== 'iphone'
          ? `/api/v1/me/passes/${encodeURIComponent(pass.id)}/barcode`
          : undefined
      }
      publicUrl={publicUrl}
      support={pass.support}
      endedOn={
        state === 'voided' || state === 'expired'
          ? endedOn(
              state,
              {
                modifiedAt: pass.modifiedAt,
                voidedAt: pass.voidedAt,
                expirationDate: pass.passJson.expirationDate,
              },
              navigator.language,
            )
          : null
      }
      inWallet={pass.inWallet}
      onAdd={() => setDip((n) => n + 1)}
      rise={dealt}
      details={
        <div className="flex flex-col gap-6">
          {state === 'active' && pass.channels?.nfc.on !== false ? (
            <TagsCard tags={pass.tags} orgName={pass.orgName} />
          ) : null}
          <DetailsCard pass={pass} view={view} state={state} title={title} />
        </div>
      }
      buddy={(props) => <Buddy {...props} />}
    />
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
  const view = useMemo(() => (pass ? toView(pass) : null), [pass]);
  const state = pass && view ? holderState(pass, view) : 'active';
  const header = <PassHeader pass={pass} view={view} state={state} />;
  if (pass && view) {
    // Arriving from the grid, the card morphs in; a deep link deals it instead.
    return (
      <>
        {header}
        <Detail pass={pass} view={view} state={state} dealt={!seed} />
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
