import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Ban, Pencil, RotateCcw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { cancelBroadcastConfirm } from '../../lib/confirms.ts';
import { isApiError } from '../../lib/errors.ts';
import { useMode } from '../../lib/mode.ts';
import { useOrgScope, useResourceOrg } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import { membershipsQuery, sessionQuery } from '../../lib/session.ts';
import {
  Button,
  Callout,
  ConfirmDialog,
  DetailNotFound,
  detailError,
  ErrorState,
  PageHeader,
  SkeletonDetail,
  TwoPane,
  toast,
} from '../../ui/index.ts';
import { templateDetailQuery } from '../templates/api.ts';
import { broadcastQuery, type ItemOutcome, useAudienceCount, useBroadcastActions } from './api.ts';
import { MessageContent, MessageDetails, MessageMeta } from './detail-content.tsx';
import { Counts } from './detail-counts.tsx';
import { PassesCard } from './detail-passes.tsx';
import { scanEventIdOf, useAudienceEventName } from './event-name.ts';
import {
  audienceOf,
  isQuiet,
  KIND_LABEL,
  messageText,
  plural,
  SCOPE_CHANGED,
  stopLine,
} from './labels.ts';
import { SendConfirm } from './send-confirm.tsx';

const CRUMBS = [{ label: 'Messages', to: '/admin/messages' }];

type MessageDetailProps = {
  broadcastId: string;
  outcome?: ItemOutcome | undefined;
  onOutcome?: (next: ItemOutcome | undefined) => void;
};

export function MessageDetailPage(props: MessageDetailProps) {
  const { hasExplicitOrg } = useOrgScope();
  return (
    <MessageDetailLoader key={JSON.stringify([props.broadcastId, hasExplicitOrg])} {...props} />
  );
}

function MessageDetailLoader({ broadcastId, outcome, onOutcome }: MessageDetailProps) {
  const scope = useOrgScope();
  const canFetch =
    !scope.isLoading &&
    !scope.isError &&
    (scope.hasExplicitOrg
      ? Boolean(scope.orgId && scope.membership?.capabilities.includes('messages:read'))
      : scope.memberships.some((membership) => membership.capabilities.includes('messages:read')));
  const query = useQuery({
    ...broadcastQuery(broadcastId),
    ...(!scope.hasExplicitOrg ? { staleTime: 0, refetchOnMount: 'always' as const } : {}),
    enabled: (current) =>
      canFetch &&
      (!scope.hasExplicitOrg || !current.state.data || current.state.data.orgId === scope.orgId),
  });
  const b = query.data;
  const verified = scope.hasExplicitOrg || (query.isFetchedAfterMount && !query.isError);
  const resourceScope = useResourceOrg(verified ? b?.orgId : undefined);
  const canOperate = scope.membership?.capabilities.includes('messages:manage') === true;

  if (scope.isError)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (resourceScope === 'not-found' || resourceScope === 'choose-org')
    return (
      <>
        <PageHeader title="Message" breadcrumbs={[...CRUMBS, { label: 'Message' }]} />
        <DetailNotFound entity="broadcast" to="/admin/messages" />
      </>
    );
  if (
    canFetch &&
    query.isError &&
    (!b ||
      !scope.hasExplicitOrg ||
      (isApiError(query.error) && (query.error.isForbidden || query.error.isNotFound)))
  )
    return detailError(query, {
      entity: 'broadcast',
      to: '/admin/messages',
      header: <PageHeader title="Message" breadcrumbs={[...CRUMBS, { label: 'Message' }]} />,
    });
  const orgId = scope.orgId;
  if (resourceScope !== 'ready' || !orgId || !b || b.orgId !== orgId)
    return (
      <>
        <PageHeader title="Message" breadcrumbs={[...CRUMBS, { label: 'Message' }]} />
        <SkeletonDetail label="Loading message" />
      </>
    );

  return (
    <LoadedMessageDetail
      key={JSON.stringify([orgId, b.id, canOperate])}
      b={b}
      canOperate={canOperate}
      outcome={outcome}
      onOutcome={onOutcome}
    />
  );
}

function LoadedMessageDetail({
  b,
  canOperate,
  outcome,
  onOutcome,
}: {
  b: BroadcastDto;
  canOperate: boolean;
  outcome: ItemOutcome | undefined;
  onOutcome: ((next: ItemOutcome | undefined) => void) | undefined;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const initialPath = useRef(router.state.location.pathname.replace(/\/+$/, '')).current;
  const qc = useQueryClient();
  const session = qc.getQueryData(sessionQuery.queryKey);
  const principalId = useRef(session?.authenticated ? session.user.id : undefined).current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mode = useMode();
  const { cancel, send, retry } = useBroadcastActions();
  const orgs = useOrgOptions();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const templates = useQueries({
    queries: b.target.templateIds.map((id) => templateDetailQuery(id, b.orgId)),
  });
  const count = useAudienceCount(b.orgId, b.target, canOperate && sending);
  const org = orgs.data?.items.find((o) => o.id === b.orgId);
  const details = templates.map(({ data }) =>
    data && (data.orgId === null || data.orgId === b.orgId) ? data : undefined,
  );
  const names = details.map((detail, i) => detail?.name ?? b.target.templateIds[i] ?? '');
  const orgScope = useOrgScope();
  const currentScope = useRef(orgScope);
  currentScope.current = orgScope;
  const eventName = useAudienceEventName(b.orgId, scanEventIdOf(b));
  const draft = b.state === 'draft';
  const noun = b.kind === 'change' ? 'change' : 'message';
  const text = messageText(b);
  const started = b.state !== 'draft' && b.state !== 'scheduled' && b.state !== 'cancelled';
  const sameMode = b.mode === mode;
  const isCurrent = () => {
    const session = qc.getQueryData(sessionQuery.queryKey);
    const membership = qc
      .getQueryData(membershipsQuery.queryKey)
      ?.items.find((item) => item.orgId === b.orgId && item.revokedAt === null);
    const location = router.state.location;
    return Boolean(
      mounted.current &&
        principalId &&
        qc.getQueryState(sessionQuery.queryKey)?.status === 'success' &&
        session?.authenticated &&
        session.user.id === principalId &&
        qc.getQueryState(membershipsQuery.queryKey)?.status === 'success' &&
        membership?.capabilities.includes('messages:manage') &&
        location.pathname.replace(/\/+$/, '') === initialPath &&
        currentScope.current.requestedSelection === b.orgId,
    );
  };
  const sendAgain = async () => {
    if (!isCurrent()) return;
    try {
      const made = await retry.mutateAsync(b.id);
      if (made.orgId !== b.orgId || !isCurrent()) return;
      toast.info('Sending');
      void navigate({ to: '/admin/messages/$broadcastId', params: { broadcastId: made.id } });
    } catch (cause) {
      if (isCurrent()) toast.error(cause, 'Could not send');
    }
  };

  return (
    <>
      <PageHeader
        title={b.name}
        breadcrumbs={[...CRUMBS, { label: b.name }]}
        meta={<MessageMeta b={b} />}
        actions={
          <>
            {canOperate && draft ? (
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
            {canOperate && b.state === 'failed' && sameMode ? (
              <Button
                iconStart={<RotateCcw aria-hidden />}
                loading={retry.isPending}
                onClick={() => void sendAgain()}
              >
                Send again
              </Button>
            ) : null}
            {canOperate && (draft || b.state === 'scheduled') ? (
              <Button
                variant="outline"
                iconStart={<Ban aria-hidden />}
                onClick={() => setAsking(true)}
              >
                {`Cancel ${noun}`}
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
          {sameMode || !canOperate
            ? ''
            : ` Switch to ${b.mode === 'test' ? 'Test' : 'Live'} mode to send again.`}
        </Callout>
      ) : null}
      <TwoPane
        asideFrom="lg"
        asideLabel="Details"
        aside={
          <MessageDetails
            b={b}
            orgName={org?.name}
            names={names}
            text={text}
            eventName={eventName}
          />
        }
      >
        <Counts b={b} outcome={outcome} />
        {started ? <PassesCard b={b} outcome={outcome} onOutcome={(o) => onOutcome?.(o)} /> : null}
        <MessageContent
          b={b}
          orgName={org?.name}
          orgAccent={org?.branding.accent ?? null}
          inputSchema={details[0]?.inputSchema}
          text={text}
        />
      </TwoPane>
      {canOperate ? (
        <>
          <SendConfirm
            open={sending}
            onOpenChange={setSending}
            kind={b.kind}
            count={count}
            quiet={isQuiet(b)}
            audience={[names.join(', '), audienceOf(b, eventName)].filter(Boolean).join(' · ')}
            at={undefined}
            later={false}
            onConfirm={async () => {
              if (!isCurrent()) throw new Error(SCOPE_CHANGED);
              const made = await send.mutateAsync({ id: b.id });
              if (made.id === b.id && made.orgId === b.orgId && isCurrent()) toast.info('Sending');
            }}
          />
          <ConfirmDialog
            open={asking}
            onOpenChange={setAsking}
            {...cancelBroadcastConfirm(b.name, b.kind, b.state)}
            destructive
            onConfirm={async () => {
              if (!isCurrent()) throw new Error(SCOPE_CHANGED);
              const made = await cancel.mutateAsync(b.id);
              if (made.id !== b.id || made.orgId !== b.orgId || !isCurrent()) return;
              toast.success(`${KIND_LABEL[b.kind]} cancelled`);
              void navigate({ to: '/admin/messages' });
            }}
          />
        </>
      ) : null}
    </>
  );
}
