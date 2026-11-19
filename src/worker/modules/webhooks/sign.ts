import { WEBHOOK_USER_AGENT } from '../../../shared/contracts/webhooks.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';

export const USER_AGENT = WEBHOOK_USER_AGENT;

/** One `v1=` value per live secret, so a receiver mid-rotation can verify with either. */
export async function signatureHeader(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): Promise<string> {
  return (await Promise.all(secrets.map((s) => signWebhook(s, timestamp, body)))).join(', ');
}

/** Fixed headers: a tenant sets none. The timestamp is unix seconds and changes on every attempt. */
export async function requestHeaders(input: {
  eventId: string;
  eventType: string;
  secrets: readonly string[];
  nowMs: number;
  body: string;
}): Promise<Record<string, string>> {
  const timestamp = Math.floor(input.nowMs / 1000);
  return {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'x-passbook-event-id': input.eventId,
    'x-passbook-event-type': input.eventType,
    'x-passbook-timestamp': String(timestamp),
    'x-passbook-signature': await signatureHeader(input.secrets, timestamp, input.body),
  };
}
