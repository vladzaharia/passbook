import { Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  Button,
  ErrorState,
  KeyValue,
  MetaLink,
  SegmentedControl,
  Sheet,
  SheetContent,
  Skeleton,
} from '../../ui/index.ts';
import { type Email, ForwardingStatus, type SendState } from './forwarding-status.tsx';
import {
  type InboxSendScope,
  useCapturedEmail,
  useSendCapturedToMe,
  useVerifiedInboxEmails,
} from './queries.ts';

type View = 'html' | 'text';

const VIEWS = [
  { value: 'html', label: 'Preview' },
  { value: 'text', label: 'Text' },
] as const;

function Details({
  email,
  orgName,
  orgId,
  send,
  view,
  onView,
}: {
  email: Email;
  orgName: string | undefined;
  orgId: string;
  send: SendState;
  view: View;
  onView: (view: View) => void;
}) {
  return (
    <>
      <KeyValue
        items={[
          { label: 'Would go to', value: email.to },
          { label: 'Organization', value: orgName ?? null },
          {
            label: 'For',
            value: email.passId ? (
              <MetaLink
                to="/admin/passes/$passId"
                params={{ passId: email.passId }}
                search={{ orgId }}
              >
                {email.kind === 'bundle' ? 'A bundle' : 'A pass'}
              </MetaLink>
            ) : email.kind === 'bundle' ? (
              'A bundle'
            ) : (
              'A pass'
            ),
          },
          { label: 'Captured', value: formatDateTime(email.createdAt) },
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          label="Message view"
          options={VIEWS}
          value={view}
          onValueChange={onView}
        />
        <Button
          variant="outline"
          iconStart={<Send aria-hidden />}
          loading={send.pending}
          disabled={
            send.refreshing ||
            !send.allowed ||
            send.accepted ||
            send.acknowledgedTo !== undefined ||
            send.unconfirmed ||
            (send.prepared && email.forwarding !== 'failed') ||
            (email.forwarding !== 'none' && email.forwarding !== 'failed')
          }
          onClick={send.send}
        >
          Send to me
        </Button>
      </div>
      {send.unavailableReason ? (
        <p className="text-sm text-fg-muted">{send.unavailableReason}</p>
      ) : null}
    </>
  );
}

function Message({ email, orgId, view }: { email: Email; orgId: string; view: View }) {
  return view === 'html' ? (
    // No allow-* tokens: no script, no forms, no popups, no storage. It loads from the
    // endpoint that sets the email's own CSP (the SPA's would block its styles), on the white
    // canvas email is designed for, whatever the viewer's theme.
    <iframe
      title="Email preview"
      sandbox=""
      referrerPolicy="no-referrer"
      src={`/api/v1/test-inbox/${encodeURIComponent(email.id)}/html?${new URLSearchParams({ orgId, mode: 'test' })}`}
      style={{ colorScheme: 'light' }}
      className="h-[32rem] w-full min-w-0 rounded-md border border-border bg-white"
    />
  ) : (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-sunken p-3 font-mono text-xs text-fg [overflow-wrap:anywhere]">
      {email.text}
    </pre>
  );
}

function PreviewContent({
  id,
  orgId,
  userId,
  canOperate,
  sendScope,
  orgName,
}: {
  id: string;
  orgId: string;
  userId: string;
  canOperate: boolean;
  sendScope: InboxSendScope;
  orgName: (orgId: string) => string | undefined;
}) {
  const email = useCapturedEmail(id, orgId);
  const emails = useVerifiedInboxEmails(userId, canOperate);
  const verified = Boolean(
    emails.isSuccess &&
      !emails.isFetching &&
      emails.data.items.some((item) => item.verifiedAt !== null && item.email.trim()),
  );
  const canSend = canOperate && verified;
  const unavailableReason = !canOperate
    ? 'Pass operation access is required to send a copy.'
    : emails.isFetching || emails.isPending
      ? 'Checking your account email.'
      : emails.isError
        ? 'Your account email could not be checked. Try again later.'
        : !verified
          ? 'Verify an email address in your account before sending a copy.'
          : undefined;
  const [acknowledgedTo, setAcknowledgedTo] = useState<string | undefined>();
  const {
    mutation: send,
    pending,
    accepted,
    prepared,
    unconfirmed,
  } = useSendCapturedToMe(
    id,
    orgId,
    userId,
    canSend,
    sendScope,
    (to) => {
      const own = emails.data?.items.some(
        (item) =>
          item.verifiedAt !== null && item.email.trim().toLowerCase() === to.trim().toLowerCase(),
      );
      setAcknowledgedTo(own ? to : undefined);
    },
    { forwarding: email.data?.forwarding, at: email.dataUpdatedAt },
  );
  const [view, setView] = useState<View>('html');
  // Skeleton only until the first answer; later refetches keep the content and just hold Send.
  const data = email.isError ? undefined : email.data;
  const sendState: SendState = {
    allowed: canSend,
    refreshing: email.isFetching,
    unavailableReason,
    pending: pending || send.isPending,
    acknowledgedTo,
    accepted,
    prepared,
    unconfirmed,
    failed: send.isError,
    failureCode: isApiError(send.error) ? send.error.code : undefined,
    refresh: () => void email.refetch(),
    send: () => send.mutate(),
  };
  return (
    <SheetContent title={data?.subject ?? 'Test email'} className="w-[min(100vw,40rem)]">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {email.isError ? (
          <>
            <ErrorState
              inline
              error={email.error}
              retryLabel="Reload email"
              onRetry={() => email.refetch()}
            />
            {pending || !send.isIdle ? (
              <p className="text-sm text-fg-muted">
                Reloading checks this email; it will not send a copy.
              </p>
            ) : null}
          </>
        ) : data ? (
          <Details
            email={data}
            orgName={orgName(data.orgId)}
            orgId={orgId}
            send={sendState}
            view={view}
            onView={setView}
          />
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
        <div aria-live="polite">
          {data ? <ForwardingStatus email={data} send={sendState} /> : null}
        </div>
        {data ? <Message email={data} orgId={orgId} view={view} /> : null}
      </div>
    </SheetContent>
  );
}

/** One captured message: the details, a sandboxed frame and Send to me. */
export function EmailPreview({
  id,
  orgId,
  userId,
  mode,
  canOperate,
  sendScope,
  orgName,
  onClose,
}: {
  id: string;
  orgId: string;
  userId: string;
  mode: Mode;
  canOperate: boolean;
  sendScope: InboxSendScope;
  orgName: (orgId: string) => string | undefined;
  onClose: () => void;
}) {
  const [opened] = useState(() => ({ orgId, userId, mode }));
  const current =
    mode === 'test' && opened.orgId === orgId && opened.userId === userId && opened.mode === mode;
  useEffect(() => {
    if (!current) onClose();
  }, [current, onClose]);
  return (
    <Sheet open={current} onOpenChange={(open) => !open && onClose()}>
      {current ? (
        <PreviewContent
          id={id}
          orgId={orgId}
          userId={userId}
          canOperate={canOperate}
          sendScope={sendScope}
          orgName={orgName}
        />
      ) : null}
    </Sheet>
  );
}
