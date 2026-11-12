import type { z } from 'zod';
import type { CapturedEmailDetailSchema } from '@/shared/contracts/sandbox.ts';
import { Button, Callout } from '../../ui/index.ts';

export type Email = z.infer<typeof CapturedEmailDetailSchema>;
export type SendState = {
  pending: boolean;
  /** The email is being re-read; Send waits for the answer. */
  refreshing: boolean;
  allowed: boolean;
  unavailableReason: string | undefined;
  acknowledgedTo: string | undefined;
  accepted: boolean;
  prepared: boolean;
  unconfirmed: boolean;
  failed: boolean;
  failureCode: string | undefined;
  refresh: () => void;
  send: () => void;
};

function failureMessage(code: string | undefined): string | undefined {
  switch (code) {
    case 'NO_VERIFIED_EMAIL':
      return 'Verify your account email before trying again.';
    case 'RATE_LIMITED':
      return 'The sending limit was reached. Wait a minute before trying again.';
    case 'RATE_LIMIT_UNAVAILABLE':
      return 'The sending limit could not be checked. Try again later.';
    case 'TEST_FORWARD_CHANGED':
      return 'The email or account changed. Review the current details before trying again.';
    default:
      return undefined;
  }
}

export function ForwardingStatus({ email, send }: { email: Email; send: SendState }) {
  if (send.pending) {
    return (
      <Callout tone="info" title="Sending copy">
        Waiting for the send request to finish.
      </Callout>
    );
  }
  if (send.acknowledgedTo !== undefined || send.accepted) {
    return (
      <Callout tone="success" title="Copy accepted by email provider">
        {send.acknowledgedTo !== undefined ? (
          <>
            The provider accepted a copy for {send.acknowledgedTo}. Inbox delivery is not
            guaranteed.
          </>
        ) : (
          <>The provider accepted this copy. Inbox delivery is not guaranteed.</>
        )}
        {email.forwarding === 'sending'
          ? ' The saved forwarding status is still pending; another send is disabled.'
          : email.forwarding === 'unknown'
            ? ' The saved forwarding status is unknown; another send is disabled.'
            : email.forwarding !== 'sent'
              ? ' The saved forwarding status is not confirmed; another send is disabled.'
              : ''}
      </Callout>
    );
  }
  if (
    (send.unconfirmed || (send.prepared && email.forwarding !== 'failed')) &&
    (email.forwarding === 'none' || email.forwarding === 'failed')
  ) {
    return (
      <Callout
        tone="warning"
        title="Send outcome unconfirmed"
        actions={
          <Button variant="outline" size="sm" onClick={send.refresh}>
            Refresh status
          </Button>
        }
      >
        {send.prepared
          ? 'The send failed before contacting the provider, but its saved failure is not confirmed.'
          : 'The send may still be in progress or the provider may have accepted it.'}{' '}
        Another send is disabled until its outcome is confirmed.
      </Callout>
    );
  }
  switch (email.forwarding) {
    case 'sending':
      return (
        <Callout tone="info" title="Copy pending">
          The send may still be in progress or its outcome may not have been recorded. It can remain
          pending indefinitely; another send is disabled.
        </Callout>
      );
    case 'sent':
      return (
        <Callout tone="success" title="Copy accepted by email provider">
          The provider accepted this copy. Inbox delivery is not guaranteed.
        </Callout>
      );
    case 'unknown':
      return (
        <Callout tone="warning" title="Delivery outcome unknown">
          The email provider may have accepted this copy. Another send is disabled to avoid
          duplicates.
        </Callout>
      );
    case 'failed':
      return (
        <Callout tone="warning" title="Copy not sent">
          {failureMessage(send.failureCode) ??
            'The last send failed before the email provider was contacted. You can try again.'}
        </Callout>
      );
    case 'none':
      return send.failed ? (
        <Callout tone="warning" title="Send request failed">
          {failureMessage(send.failureCode) ??
            'The request failed before forwarding was reserved. You can try again.'}
        </Callout>
      ) : (
        <Callout tone="info">
          A copy with [Test] in the subject goes to your verified account email. The original test
          email was captured instead of sent.
        </Callout>
      );
  }
}
