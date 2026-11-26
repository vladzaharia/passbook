import { Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { isApiError } from '@/web/lib/errors.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { KeyValue } from '../../ui/key-value.tsx';
import { SegmentedControl } from '../../ui/segmented-control.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { type Email, ForwardingStatus, type SendState } from './forwarding-status.tsx';
import type { InboxHost } from './host.ts';
import { FailedBadge } from './parts.tsx';
import { useCapturedEmail, useVerifiedInboxEmails } from './queries.ts';
import { useSendCapturedToMe } from './send.ts';

type View = 'html' | 'text';

const VIEWS = [
  { value: 'html', label: 'Preview' },
  { value: 'text', label: 'Text' },
] as const;

function Details({
  email,
  forLink,
  send,
  view,
  onView,
}: {
  email: Email;
  forLink: ForLink;
  send: SendState;
  view: View;
  onView: (view: View) => void;
}) {
  return (
    <>
      <KeyValue
        items={[
          { label: 'Would go to', value: email.to },
          {
            label: 'For',
            value: email.passId ? forLink(email) : email.kind === 'bundle' ? 'A bundle' : 'A pass',
          },
          { label: 'Captured', value: formatDateTime(email.createdAt) },
          ...(email.failed ? [{ label: 'Delivery', value: <FailedBadge /> }] : []),
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

/**
 * An image the frame's policy does not load: a remote `src` or `background` attribute, a `srcset` with a
 * remote candidate, or a CSS `url()`. This app's own images load, so its origin is not remote. Notice
 * text only; the policy is what blocks them.
 */
const REMOTE_IMAGE =
  /\b(?:src|background)\s*=\s*["']?\s*(?:https?:)?\/\/|\bsrcset\s*=\s*["']?[^"'>]*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

function Message({ email, orgId, view }: { email: Email; orgId: string; view: View }) {
  if (view !== 'html')
    return (
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-sunken p-3 font-mono text-xs text-fg [overflow-wrap:anywhere]">
        {email.text}
      </pre>
    );
  // No allow-* tokens: no script, no forms, no popups, no storage. It loads from the
  // endpoint that sets the email's own CSP (the SPA's would block its styles), on the white
  // canvas email is designed for, whatever the viewer's theme.
  return (
    <>
      {REMOTE_IMAGE.test(email.html.replaceAll(location.origin, '')) ? (
        <p className="text-sm text-fg-muted">Remote images hidden in preview</p>
      ) : null}
      <iframe
        title="Email preview"
        sandbox=""
        referrerPolicy="no-referrer"
        src={`/api/v1/test-inbox/${encodeURIComponent(email.id)}/html?${new URLSearchParams({ orgId, mode: 'test' })}`}
        style={{ colorScheme: 'light' }}
        className="h-[32rem] w-full min-w-0 rounded-md border border-border bg-white"
      />
    </>
  );
}

type ForLink = (email: Email) => ReactNode;

/**
 * One captured message, whatever frames it: the details, a sandboxed frame and Send to me. `frame`
 * puts the title and the body in the host's own surface (admin's sheet, the Workbench's inspector).
 */
export function EmailDetail({
  id,
  orgId,
  userId,
  host,
  forLink,
  frame,
}: {
  id: string;
  orgId: string;
  userId: string;
  host: InboxHost;
  forLink: ForLink;
  frame: (title: string, body: ReactNode) => ReactNode;
}) {
  const { canOperate } = host;
  const email = useCapturedEmail(id, orgId, host);
  const emails = useVerifiedInboxEmails(host, canOperate);
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
    host,
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
  return frame(
    data?.subject ?? 'Test email',
    <>
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
        <Details email={data} forLink={forLink} send={sendState} view={view} onView={setView} />
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
      <div aria-live="polite">
        {data ? <ForwardingStatus email={data} send={sendState} /> : null}
      </div>
      {data ? <Message email={data} orgId={orgId} view={view} /> : null}
    </>,
  );
}
