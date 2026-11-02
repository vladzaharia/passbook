import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { isApiError } from '../../../lib/errors.ts';
import { useLasting, useMintedOnArrival } from '../../../lib/motion.ts';
import {
  Button,
  Celebrate,
  EmptyState,
  ErrorState,
  KeyValue,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
  WalletArt,
} from '../../../ui/index.ts';
import { useDraftPreview, useTemplate } from '../../templates/api.ts';
import { usePass, usePassActions, usePassVersion } from '../api.ts';
import { newKey } from '../format.ts';
import { usePassActionRunner } from '../pass-actions.tsx';
import { PassPreview, PassPreviewPanel } from '../pass-preview.tsx';
import { PreviewLayout } from '../preview-layout.tsx';
import type { passDetailSearchSchema } from '../search.ts';
import { CreatedCallout, PassWarnings, VoidedCallout } from './callouts.tsx';
import { HeaderActionsView } from './header-actions.tsx';
import { PassTabs } from './pass-tabs.tsx';
import { useCreated, useStageMotion } from './stage-state.ts';
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
    const missing = isApiError(pass.error) && pass.error.isNotFound;
    if (missing)
      return (
        <EmptyState
          heading
          art="torn"
          title="Pass not found"
          action={
            <Button asChild variant="outline">
              <Link to="/admin/passes">Back to passes</Link>
            </Button>
          }
          className="mt-6"
        />
      );
    return (
      <>
        <PageHeader title="Pass" breadcrumbs={crumbs} />
        <ErrorState error={pass.error} onRetry={() => void pass.refetch()} />
      </>
    );
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
  const created = useCreated(p.id);
  const runner = usePassActionRunner(p, p);
  const actions = usePassActions(p.id);
  const template = useTemplate(p.templateId);
  const motion = useStageMotion(p.version, p.status, minted);
  const picked = search.v !== undefined && search.v !== p.version ? search.v : undefined;
  const version = usePassVersion(p.id, picked);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const draftPreview = useDraftPreview(draft ? p.templateId : undefined, draft ?? {}, {
    orgId: p.orgId,
    version: p.templateVersion,
  });
  const tab: Tab = search.tab ?? 'fields';
  const voided = p.status === 'voided';
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
      {size === 'sheet' ? null : <Celebrate when={created.first} />}
      <PassPreviewPanel
        passJson={source.passJson}
        assetBaseUrl={source.assetBaseUrl}
        assetNames={source.assetNames}
        transitionName={size === 'sheet' ? undefined : `pass-${p.id}`}
        enter={deal && picked === undefined && size !== 'sheet'}
        mint={picked === undefined && !draft ? motion.mint : undefined}
        settle={motion.settle}
        dim={voided}
        unsaved={draft !== null}
        waiting={waiting}
        // Browsing versions crossfades in place; a new current version mints the same card.
        swapKey={picked === undefined ? 'current' : showing}
        label={picked !== undefined ? `v${showing} of ${p.version}` : `v${p.version}`}
        className={size === 'card' ? 'gap-2' : undefined}
        // Just created: the buddy steps out from behind the pass and stays beside it.
        beside={
          size === 'column' && minted ? (
            <span aria-hidden className="wl-pass-buddy">
              <WalletArt state="login" mood="happy" size="sm" beat={false} />
            </span>
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
            <StatusPill status={p.status} />
            <StatusPill status={p.holderState} />
            <span className="tabular-nums">v{p.version}</span>
            <span>{devices(p.deviceCount)}</span>
          </>
        }
        actions={<HeaderActionsView runner={runner} />}
      />
      <div className="mb-6 flex flex-col gap-3 empty:hidden">
        {voided ? <VoidedCallout pass={p} stamp={motion.stamp} /> : null}
        {created.unsent && !voided ? (
          <CreatedCallout
            pass={p}
            runner={runner}
            onDismiss={created.dismiss}
            onSend={() =>
              actions.resendEmail
                .mutateAsync({ key: newKey() })
                .then(() => {
                  toast.success(`Pass emailed to ${p.holderEmail}`);
                  created.dismiss();
                })
                .catch((error: unknown) => toast.error(error))
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
          />
        }
        summary={<KeyValue items={[{ label: 'Holder', value: p.holderEmail }]} />}
      >
        <Tabs value={tab} onValueChange={(t) => setSearch({ tab: t as Tab })} className="min-w-0">
          <TabsList aria-label="Pass sections">
            {(
              [
                ['fields', 'Fields'],
                ['holder', 'Holder'],
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
          />
        </Tabs>
      </PreviewLayout>
    </>
  );
}
