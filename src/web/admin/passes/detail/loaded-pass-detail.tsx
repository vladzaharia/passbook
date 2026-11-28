import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { ChannelStage } from '../../../channel-previews/channel-stage.tsx';
import { previewSource } from '../../../channel-previews/source.ts';
import { entityLabel } from '../../../lib/entity-label.ts';
import { formatDateTime, formatDay } from '../../../lib/format.ts';
import { useLasting, useMintedOnArrival } from '../../../lib/motion.ts';
import { sessionQuery } from '../../../lib/session.ts';
import { PassWallets } from '../../../pass-wallets/pass-wallets.tsx';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  KeyValue,
  PageHeader,
  StatusPill,
  Tabs,
  TabsList,
  TabsTrigger,
  TechnicalDetails,
  toast,
} from '../../../ui/index.ts';
import { ModePill } from '../../../ui/layout/mode-pill.tsx';
import { OpenInWorkbench } from '../../../ui/layout/open-in-workbench.tsx';
import { useDraftPreview, useTemplate } from '../../templates/api.ts';
import { usePassActions } from '../api.ts';
import { useCreated } from '../created.tsx';
import { reportEmailError } from '../email-outcome.ts';
import { newKey } from '../format.ts';
import { usePassActionRunner } from '../pass-actions.tsx';
import { usePassForeign } from '../pass-foreign.ts';
import { PassPreview, PassPreviewPanel } from '../pass-preview.tsx';
import { PreviewLayout } from '../preview-layout.tsx';
import { usePassVersion } from '../versions-api.ts';
import {
  ModeMismatchCallout,
  PassCreatedCallout,
  PassWarnings,
  ReissueRequiredCallout,
  RemovedCallout,
  VoidedCallout,
} from './callouts.tsx';
import type { PassDetailSearch as Search, PassDetailTab as Tab } from './detail-types.ts';
import { HeaderActionsView } from './header-actions.tsx';
import { type Notice, NotifyPreview, orgLine } from './notify-preview.tsx';
import { PassHold } from './pass-hold.tsx';
import { PassTabs } from './pass-tabs.tsx';
import { StageBuddy } from './stage-buddy.tsx';
import { useStageMotion } from './stage-state.ts';

const devices = (n: number) =>
  n === 0 ? 'Not in a Wallet yet' : `On ${n} ${n === 1 ? 'device' : 'devices'}`;

const newest = <T extends { createdAt: number }>(items: readonly T[]): T | null =>
  items.reduce<T | null>((a, d) => (!a || d.createdAt > a.createdAt ? d : a), null);

/** What last went out: the newest email and the newest published version, one line each. */
function lastSent(p: PassDetailDto): string[] {
  const email = newest(p.deliveries.filter((d) => d.kind === 'email'));
  const published = newest(p.versions);
  const mail = !email
    ? null
    : email.state === 'sent'
      ? `Emailed ${formatDateTime(email.finishedAt ?? email.createdAt)}`
      : email.state === 'failed'
        ? 'Email failed'
        : 'Email sending';
  return [
    ...(mail ? [mail] : []),
    ...(published && p.version > 1 ? [`Published ${formatDay(published.createdAt)}`] : []),
  ];
}

export function LoadedPassDetail({
  pass: p,
  search,
  crumbs,
  setSearch,
  canOperate,
}: {
  pass: PassDetailDto;
  search: Search;
  crumbs: { label: string; to?: string }[];
  setSearch: (patch: Partial<Search>) => void;
  canOperate: boolean;
}) {
  const client = useQueryClient();
  const minted = useMintedOnArrival(p.id);
  // The deal runs once on a hard load; data-enter then goes, so later mints and settles can play.
  const [deal, setDeal] = useState(() => !minted);
  useEffect(() => {
    const t = setTimeout(() => setDeal(false), 900);
    return () => clearTimeout(t);
  }, []);
  const created = useCreated<{ sent: boolean; first: boolean }>(`pass:${p.id}`);
  const runner = usePassActionRunner(p, p, { canOperate });
  const actions = usePassActions(p.id);
  const template = useTemplate(p.templateId, p.orgId);
  const picked = search.v !== undefined && search.v !== p.version ? search.v : undefined;
  const version = usePassVersion(p.id, picked);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const draftPreview = useDraftPreview(draft ? p.templateId : undefined, draft ?? {}, {
    orgId: p.orgId,
    version: p.templateVersion,
  });
  const tab: Tab = search.tab ?? 'fields';
  const voided = p.status === 'voided';
  const removed = p.removedAt !== null;
  const motion = useStageMotion(p.version, p.status, minted, removed);
  const foreign = usePassForeign(p);
  const readOnly = foreign || !canOperate;
  const loadingVersion = picked !== undefined && !version.data;
  const waiting = useLasting(loadingVersion || (draft !== null && draftPreview.isFetching));
  const source =
    draft && draftPreview.data
      ? draftPreview.data
      : picked !== undefined && version.data
        ? version.data
        : p;
  const showing = picked !== undefined && version.data ? picked : p.version;
  const channelSource = useMemo(
    () =>
      previewSource(source, template.data, {
        input: p.personalization,
        version: p.templateVersion,
        testBand: p.testPreview,
      }),
    [source, template.data, p.personalization, p.templateVersion, p.testPreview],
  );
  const stage = (size: 'column' | 'card' | 'sheet') => (
    <div className="relative">
      <ChannelStage
        size={size}
        source={channelSource}
        title={entityLabel(p.title, 'Pass')}
        templateId={p.templateId}
        orgId={p.orgId}
        // A sandbox pass is a preview on every channel, so every channel shows, each with its band.
        channels={p.testPreview ? undefined : p.channels}
        channelsTab="holder"
        own="pass"
        apple={
          <PassPreviewPanel
            passJson={source.passJson}
            assetBaseUrl={source.assetBaseUrl}
            assetNames={source.assetNames}
            transitionName={size === 'sheet' ? undefined : `pass-${p.id}`}
            celebrate={size !== 'sheet' && created.mark?.first === true}
            enter={deal && picked === undefined && size !== 'sheet'}
            mint={picked === undefined && !draft ? motion.mint : undefined}
            settle={motion.settle}
            dim={voided}
            removed={removed}
            testBand={p.testPreview}
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
            beside={<StageBuddy stamp={motion.stamp} minted={minted} />}
          />
        }
      />
      {notice ? (
        <NotifyPreview
          notice={notice}
          passJson={source.passJson}
          title={orgLine(source.passJson) ?? entityLabel(p.title, 'Pass')}
        />
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader
        title={entityLabel(p.title, 'Pass')}
        breadcrumbs={crumbs}
        meta={
          <>
            <ModePill mode={p.mode} />
            {p.mode === 'live' && foreign ? <Badge tone="warning">Live</Badge> : null}
            <StatusPill status={removed ? 'removed' : p.status} />
            <StatusPill status={p.holderState} />
            <span className="min-w-0 tabular-nums">
              {[`v${p.version}`, devices(p.deviceCount), ...lastSent(p)].join(' · ')}
            </span>
          </>
        }
        actions={
          <HeaderActionsView
            runner={runner}
            lead={
              p.mode === 'test' ? <OpenInWorkbench tool="passes" options={{ hash: p.id }} /> : null
            }
          />
        }
      />
      <PreviewLayout
        title={entityLabel(p.title, 'Pass')}
        stage={stage}
        inline={minted || motion.stamp}
        lead={
          <>
            <Card className="min-w-0">
              <CardHeader title="Pass context" />
              <CardBody className="grid gap-3">
                <KeyValue
                  items={[
                    ...(template.data ? [{ label: 'Template', value: template.data.name }] : []),
                    { label: 'Last updated', value: formatDateTime(p.modifiedAt) },
                  ]}
                />
                <TechnicalDetails
                  items={[
                    { label: 'Serial number', value: p.serial, copy: true },
                    { label: 'Template revision', value: p.templateVersion, copy: true },
                  ]}
                />
                <PassHold passId={p.id} orgId={p.orgId} />
              </CardBody>
            </Card>
            <PassWallets pass={p} />
            <div className="flex flex-col gap-3 empty:hidden">
              {p.reissueRequired ? (
                <ReissueRequiredCallout pass={p} canOperate={!readOnly} />
              ) : null}
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
                  canOperate={canOperate}
                  canEdit={!readOnly}
                  onDismiss={created.dismiss}
                  onSend={() => {
                    if (readOnly) return;
                    const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
                    if (!before?.authenticated) return;
                    const userId = before.user.id;
                    void actions.resendEmail
                      .mutateAsync({ key: newKey() })
                      .then(() => {
                        const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
                        if (!current?.authenticated || current.user.id !== userId) return;
                        toast.info(`Email queued to ${p.holderEmail}`);
                        const afterToast = client.getQueryData<SessionResponse>(
                          sessionQuery.queryKey,
                        );
                        if (!afterToast?.authenticated || afterToast.user.id !== userId) return;
                        created.dismiss();
                      })
                      .catch((error: unknown) => {
                        const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
                        if (!current?.authenticated || current.user.id !== userId) return;
                        reportEmailError(error);
                      });
                  }}
                />
              ) : null}
              <PassWarnings pass={p} />
            </div>
          </>
        }
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
            readOnly={readOnly}
            template={template}
            picked={picked}
            onPick={(v) => setSearch({ v })}
            onDraft={setDraft}
            onNotice={setNotice}
          />
        </Tabs>
      </PreviewLayout>
    </>
  );
}
