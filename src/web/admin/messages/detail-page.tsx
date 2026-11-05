import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Ban, Pencil, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { cancelBroadcastConfirm } from '../../lib/confirms.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useMode } from '../../lib/mode.ts';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  detailError,
  KeyValue,
  MetaLink,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  TwoPane,
  toast,
} from '../../ui/index.ts';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import { templateDetailQuery } from '../templates/api.ts';
import { type ItemOutcome, useAudienceCount, useBroadcast, useBroadcastActions } from './api.ts';
import { Counts } from './detail-counts.tsx';
import { PassesCard } from './detail-passes.tsx';
import {
  clearLabel,
  HOLDER_LABEL,
  isQuiet,
  KIND_LABEL,
  messageText,
  plural,
  stopLine,
  whenLine,
} from './labels.ts';
import { LockScreenNotice } from './lock-screen.tsx';
import { patchRows } from './patch-view.ts';
import { SendConfirm } from './send-confirm.tsx';

const CRUMBS = [{ label: 'Messages', to: '/admin/messages' }];

function audienceOf(b: BroadcastDto): string {
  return (
    [
      b.target.onDevice ? 'On a device' : null,
      b.target.holderState ? HOLDER_LABEL[b.target.holderState] : null,
      b.target.q ? `Matching “${b.target.q}”` : null,
    ]
      .filter(Boolean)
      .join(', ') || 'Every active pass'
  );
}

export function MessageDetailPage({
  broadcastId,
  outcome,
  onOutcome,
}: {
  broadcastId: string;
  outcome?: ItemOutcome | undefined;
  onOutcome?: (next: ItemOutcome | undefined) => void;
}) {
  const navigate = useNavigate();
  const mode = useMode();
  const query = useBroadcast(broadcastId);
  const { cancel, send, retry } = useBroadcastActions();
  const orgs = useOrgOptions();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const b = query.data;
  const templates = useQueries({
    queries: (b?.target.templateIds ?? []).map((id) => templateDetailQuery(id)),
  });
  const count = useAudienceCount(b?.orgId, b?.target, sending);

  if (!b)
    return query.isError ? (
      detailError(query, {
        entity: 'broadcast',
        to: '/admin/messages',
        header: <PageHeader title="Message" breadcrumbs={[...CRUMBS, { label: 'Message' }]} />,
      })
    ) : (
      <>
        <PageHeader title="Message" breadcrumbs={[...CRUMBS, { label: 'Message' }]} />
        <SkeletonDetail label="Loading message" />
      </>
    );
  const org = orgs.data?.items.find((o) => o.id === b.orgId);
  const names = templates.map((t, i) => t.data?.name ?? b.target.templateIds[i] ?? '');
  const draft = b.state === 'draft';
  const noun = b.kind === 'change' ? 'change' : 'message';
  const text = messageText(b);
  const started = b.state !== 'draft' && b.state !== 'scheduled' && b.state !== 'cancelled';
  const sameMode = b.mode === mode;
  const sendAgain = async () => {
    try {
      const made = await retry.mutateAsync(b.id);
      toast.info('Sending');
      void navigate({ to: '/admin/messages/$broadcastId', params: { broadcastId: made.id } });
    } catch (cause) {
      toast.error(cause, 'Could not send');
    }
  };

  return (
    <>
      <PageHeader
        title={b.name}
        breadcrumbs={[...CRUMBS, { label: b.name }]}
        meta={
          <>
            <ModePill mode={b.mode} />
            <StatusPill status={b.state} />
            <span>{KIND_LABEL[b.kind]}</span>
            <span>{whenLine(b)}</span>
            {b.parentId ? (
              <MetaLink to="/admin/messages/$broadcastId" params={{ broadcastId: b.parentId }}>
                Original message
              </MetaLink>
            ) : null}
            {b.followUp ? (
              <MetaLink to="/admin/messages/$broadcastId" params={{ broadcastId: b.followUp.id }}>
                {b.followUp.at ? `Clears ${formatDateTime(b.followUp.at)}` : 'Clears later'}
              </MetaLink>
            ) : null}
          </>
        }
        actions={
          <>
            {draft ? (
              <>
                <Button iconStart={<Send aria-hidden />} onClick={() => setSending(true)}>
                  Send
                </Button>
                <Button asChild variant="outline" iconStart={<Pencil aria-hidden />}>
                  <Link to="/admin/messages/new" search={{ from: b.id }}>
                    Edit
                  </Link>
                </Button>
              </>
            ) : null}
            {b.state === 'failed' && sameMode ? (
              <Button
                iconStart={<RotateCcw aria-hidden />}
                loading={retry.isPending}
                onClick={() => void sendAgain()}
              >
                Send again
              </Button>
            ) : null}
            {draft || b.state === 'scheduled' ? (
              <Button
                variant="outline"
                iconStart={draft ? <Trash2 aria-hidden /> : <Ban aria-hidden />}
                onClick={() => setAsking(true)}
              >
                {draft ? 'Delete draft' : `Cancel ${noun}`}
              </Button>
            ) : null}
          </>
        }
      />
      {b.state === 'partial' ? (
        <Callout
          tone="warning"
          className="mb-6"
          actions={
            <Button size="sm" variant="outline" onClick={() => onOutcome?.('failed')}>
              Show failed
            </Button>
          }
        >
          {plural(b.counts.failed, 'pass', 'passes')} could not be updated.
        </Callout>
      ) : null}
      {b.state === 'failed' ? (
        <Callout tone="danger" className="mb-6">
          {stopLine(b.errorCode)}
          {sameMode ? '' : ` Switch to ${b.mode === 'test' ? 'Test' : 'Live'} mode to send again.`}
        </Callout>
      ) : null}
      <TwoPane
        asideFrom="lg"
        asideLabel="Details"
        aside={
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <KeyValue
                items={[
                  { label: 'Organization', value: org?.name ?? '—' },
                  { label: 'Templates', value: names.join(', ') },
                  { label: 'Audience', value: audienceOf(b) },
                  {
                    label: 'Notification',
                    value:
                      b.kind === 'message' && !text.trim()
                        ? 'None, clears the message'
                        : b.notify
                          ? 'Notify holders'
                          : 'None',
                  },
                  ...(b.clearAfter ? [{ label: 'Clears', value: clearLabel(b.clearAfter) }] : []),
                  { label: 'Created', value: formatDateTime(b.createdAt) },
                  ...(b.startedAt
                    ? [{ label: 'Started', value: formatDateTime(b.startedAt) }]
                    : []),
                  ...(b.finishedAt
                    ? [{ label: 'Finished', value: formatDateTime(b.finishedAt) }]
                    : []),
                ]}
              />
            </CardBody>
          </Card>
        }
      >
        <Counts b={b} outcome={outcome} />
        {started ? <PassesCard b={b} outcome={outcome} onOutcome={(o) => onOutcome?.(o)} /> : null}
        {b.kind === 'message' ? (
          <Card>
            <CardHeader title="Message" />
            <CardBody>
              <LockScreenNotice
                org={{
                  id: b.orgId,
                  name: org?.name ?? 'Your organization',
                  accent: org?.branding.accent ?? null,
                }}
                text={text}
                silent={isQuiet(b)}
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader title="Changes" />
            <CardBody>
              <KeyValue
                items={patchRows(templates[0]?.data?.inputSchema, b.patch).map((r) => ({
                  label: r.label,
                  value: r.value,
                }))}
              />
            </CardBody>
          </Card>
        )}
      </TwoPane>
      <SendConfirm
        open={sending}
        onOpenChange={setSending}
        kind={b.kind}
        count={count}
        quiet={isQuiet(b)}
        at={undefined}
        later={false}
        onConfirm={async () => {
          await send.mutateAsync({ id: b.id });
          toast.info('Sending');
        }}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        {...cancelBroadcastConfirm(b.name, b.kind, b.state)}
        destructive
        onConfirm={async () => {
          await cancel.mutateAsync(b.id);
          toast.success(draft ? 'Draft deleted' : `${KIND_LABEL[b.kind]} cancelled`);
          void navigate({ to: '/admin/messages' });
        }}
      />
    </>
  );
}
