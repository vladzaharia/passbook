import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { MyPassListSchema } from '@/shared/contracts/me.ts';
import type { PassView } from '@/shared/pass-view/index.ts';
import { Upcoming } from '../pass-card/back.tsx';
import { PassCardStage } from '../pass-card/index.tsx';
import {
  Buddy,
  Card,
  CardBody,
  CardHeader,
  detailError,
  KeyValue,
  PassSideToggle,
  Skeleton,
  StatusPill,
} from '../ui/index.ts';
import { myPassesKey, myPassQuery } from './api.ts';
import { browserDevice } from './device.ts';
import { HolderPassView } from './holder-pass-view.tsx';
import { fieldRows } from './pass-fields.ts';
import { PassHeader } from './pass-header.tsx';
import { type HolderState, holderState, type MyPass, passName, toView } from './pass-view.ts';
import { isPendingRefresh } from './refresh.ts';
import { publicUrlOf } from './wallet-actions.tsx';
import './portal.css';

type Page = typeof MyPassListSchema._output;

/** The list's copy of the pass, so a tile click shows the card on the first frame. */
function fromList(client: ReturnType<typeof useQueryClient>, id: string): MyPass | undefined {
  const list = client.getQueryData<InfiniteData<Page>>(myPassesKey);
  return list?.pages.flatMap((p) => p.items).find((p) => p.id === id);
}

/** The pass's fields, then its upcoming events. The header's pill carries the state. */
function DetailsCard({ pass, view, state }: { pass: MyPass; view: PassView; state: HolderState }) {
  const rows = fieldRows(pass.passJson);
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
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [dip, setDip] = useState(0);
  const [device] = useState(browserDevice);
  const stale = state === 'voided' || state === 'removed';
  return (
    <HolderPassView
      pass={
        <PassCardStage
          view={view}
          face={face}
          flippable
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
      toggle={<PassSideToggle value={face} onChange={setFace} />}
      passTitle={passName(pass)}
      orgName={pass.orgName}
      state={state}
      removalMessage={pass.removalMessage}
      device={device}
      downloadHref={pass.downloadUrl}
      publicUrl={publicUrlOf(pass.downloadUrl)}
      support={pass.support}
      inWallet={pass.inWallet}
      onAdd={() => setDip((n) => n + 1)}
      rise={dealt}
      details={<DetailsCard pass={pass} view={view} state={state} />}
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
