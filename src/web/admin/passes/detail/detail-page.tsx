import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { useMode } from '../../../lib/mode.ts';
import { useLasting, useMintedOnArrival } from '../../../lib/motion.ts';
import {
  Badge,
  Buddy,
  Celebrate,
  detailError,
  KeyValue,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from '../../../ui/index.ts';
import { ModePill } from '../../../ui/layout/mode-pill.tsx';
import { useDraftPreview, useTemplate } from '../../templates/api.ts';
import { usePass, usePassActions, usePassVersion } from '../api.ts';
import { useCreated } from '../created.tsx';
import { newKey } from '../format.ts';
import { usePassActionRunner } from '../pass-actions.tsx';
import { PassPreview, PassPreviewPanel } from '../pass-preview.tsx';
import { PreviewLayout } from '../preview-layout.tsx';
import type { passDetailSearchSchema } from '../search.ts';
import {
  ModeMismatchCallout,
  PassCreatedCallout,
  PassWarnings,
  RemovedCallout,
  VoidedCallout,
} from './callouts.tsx';
import { HeaderActionsView } from './header-actions.tsx';
import { PassTabs } from './pass-tabs.tsx';
import { useStageMotion } from './stage-state.ts';
import '../passes.css';

type Search = z.infer<typeof passDetailSearchSchema>;
export type Tab = NonNullable<Search['tab']>;

const devices = (n: number) =>
  n === 0 ? 'Not on a device yet' : `On ${n} ${n === 1 ? 'device' : 'devices'}`;

export function PassDetailPage({ passId, search }: { passId: string; search: Search }) {
  const navigate = useNavigate({ from: '/admin/passes/$passId' });
  const pass = usePass(passId);
  const crumbs = [
    { label: 'Passes', to: '/admin/passes' },
    { label: pass.data ? (pass.data.title ?? pass.data.serial) : 'Pass' },
  ];
  if (pass.isError) {
    return detailError(pass, {
      entity: 'pass',
      to: '/admin/passes',
      header: <PageHeader title="Pass" breadcrumbs={crumbs} />,
    });
  }
  if (!pass.data) {
    return (
      <>
        <PageHeader title="Pass" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading pass" />
      </>
    );
  }
  return (
    <Loaded
      pass={pass.data}
      search={search}
      crumbs={crumbs}
      setSearch={(patch) =>
        void navigate({
          to: '.',
          search: (prev: Search) =>
            Object.fromEntries(
              Object.entries({ ...prev, ...patch }).filter(([, v]) => v !== undefined),
            ),
          replace: true,
        })
      }
    />
  );
}

function Loaded({
  pass: p,
  search,
  crumbs,
  setSearch,
}: {
  pass: PassDetailDto;
  search: Search;
  crumbs: { label: string; to?: string }[];
  setSearch: (patch: Partial<Search>) => void;
}) {
  const minted = useMintedOnArrival(p.id);
  // The deal runs once on a hard load; data-enter then goes, so later mints and settles can play.
  const [deal, setDeal] = useState(() => !minted);
  useEffect(() => {
    const t = setTimeout(() => setDeal(false), 900);
    return () => clearTimeout(t);
  }, []);
  const created = useCreated<{ sent: boolean; first: boolean }>(`pass:${p.id}`);
  const runner = usePassActionRunner(p, p);
  const actions = usePassActions(p.id);
  const template = useTemplate(p.templateId);
  const picked = search.v !== undefined && search.v !== p.version ? search.v : undefined;
  const version = usePassVersion(p.id, picked);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const draftPreview = useDraftPreview(draft ? p.templateId : undefined, draft ?? {}, {
    orgId: p.orgId,
    version: p.templateVersion,
  });
  const tab: Tab = search.tab ?? 'fields';
  const voided = p.status === 'voided';
  const removed = p.removedAt !== null;
  const motion = useStageMotion(p.version, p.status, minted, removed);
  const foreign = p.mode !== useMode();
  const loadingVersion = picked !== undefined && !version.data;
  const waiting = useLasting(loadingVersion || (draft !== null && draftPreview.isFetching));
  const source =
    draft && draftPreview.data
      ? draftPreview.data
      : picked !== undefined && version.data
        ? version.data
        : p;
  const showing = picked !== undefined && version.data ? picked : p.version;

  const stage = (size: 'column' | 'card' | 'sheet') => (
    <div className="relative">
      {size === 'sheet' ? null : <Celebrate when={created.mark?.first === true} />}
      <PassPreviewPanel
        passJson={source.passJson}
        assetBaseUrl={source.assetBaseUrl}
        assetNames={source.assetNames}
        transitionName={size === 'sheet' ? undefined : `pass-${p.id}`}
        enter={deal && picked === undefined && size !== 'sheet'}
        mint={picked === undefined && !draft ? motion.mint : undefined}
        settle={motion.settle}
        dim={voided}
        removed={removed}
        unsaved={draft !== null}
        waiting={waiting}
        // Browsing versions crossfades in place; a new current version mints the same card.
        swapKey={picked === undefined ? 'current' : showing}
        label={picked !== undefined ? `v${showing} of ${p.version}` : `v${p.version}`}
        className={size === 'card' ? 'gap-2' : undefined}
        // Any pass can be voided while open: the buddy's seat is kept from the first frame.
        seat
        // Just created, the buddy falls onto the Front / Details control and waves at the pass;
        // just voided, it sheds a tear. It stays there, in every layout.
        beside={
          motion.stamp ? (
            <Buddy
              key="tear"
              size="sm"
              at="end"
              mood="sad"
              scene="tear"
              className="wl-pass-buddy"
            />
          ) : minted ? (
            <Buddy
              key="wave"
              size="sm"
              at="end"
              mood="happy"
              scene="wave"
              className="wl-pass-buddy"
            />
          ) : undefined
        }
      />
    </div>
  );

  return (
    <>
      <PageHeader
        title={p.title ?? p.serial}
        breadcrumbs={crumbs}
        meta={
          <>
            <ModePill mode={p.mode} />
            {p.mode === 'live' && foreign ? <Badge tone="warning">Live</Badge> : null}
            <StatusPill status={removed ? 'removed' : p.status} />
            <StatusPill status={p.holderState} />
            <span className="tabular-nums">v{p.version}</span>
            <span>{devices(p.deviceCount)}</span>
          </>
        }
        actions={<HeaderActionsView runner={runner} />}
      />
      <div className="mb-6 flex flex-col gap-3 empty:hidden">
        {foreign ? <ModeMismatchCallout pass={p} /> : null}
        {removed ? (
          <RemovedCallout pass={p} tab={tab} />
        ) : voided ? (
          <VoidedCallout pass={p} stamp={motion.stamp} />
        ) : null}
        {created.shown && !voided ? (
          <PassCreatedCallout
            pass={p}
            sent={created.mark?.sent === true}
            runner={runner}
            onDismiss={created.dismiss}
            onSend={() =>
              actions.resendEmail
                .mutateAsync({ key: newKey() })
                .then(() => {
                  toast.sent(`Pass emailed to ${p.holderEmail}`);
                  created.dismiss();
                })
                .catch((error: unknown) => toast.error(error, 'Could not send'))
            }
          />
        ) : null}
        <PassWarnings pass={p} />
      </div>
      <PreviewLayout
        title={p.title ?? p.serial}
        stage={stage}
        still={
          <PassPreview
            passJson={p.passJson}
            assetBaseUrl={p.assetBaseUrl}
            assetNames={p.assetNames}
            still
            dim={voided}
            removed={removed}
          />
        }
        summary={
          <KeyValue
            items={[
              { label: 'Holder', value: p.holderEmail },
              { label: 'Status', value: <StatusPill status={removed ? 'removed' : p.status} /> },
              { label: 'Devices', value: devices(p.deviceCount) },
              { label: 'Version', value: `v${p.version}` },
            ]}
          />
        }
      >
        <Tabs value={tab} onValueChange={(t) => setSearch({ tab: t as Tab })} className="min-w-0">
          <TabsList aria-label="Pass sections">
            {(
              [
                ['fields', 'Fields'],
                ['holder', 'Holder'],
                ['devices', 'Devices'],
                ['sync', 'Sync log'],
                ['delivery', 'Delivery'],
                ['images', 'Images'],
                ['versions', 'Versions'],
                ['connection', 'Connection'],
                ['activity', 'Activity'],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <PassTabs
            pass={p}
            tab={tab}
            template={template}
            picked={picked}
            onPick={(v) => setSearch({ v })}
            onDraft={setDraft}
            runner={runner}
          />
        </Tabs>
      </PreviewLayout>
    </>
  );
}
