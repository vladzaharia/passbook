import type { z } from 'zod';
import type { WebhookTestAttemptSchema } from './contracts/webhook-tests.ts';

export type WebhookTestAttempt = z.infer<typeof WebhookTestAttemptSchema>;

/** The tag on a test send wherever deliveries are listed (portal and Admin). */
export const TEST_TAG = 'Test';

/** A test send as a row of the deliveries list. */
export interface TestRow {
  key: string;
  at: number;
  type: WebhookTestAttempt['type'];
  status: number | null;
  ok: boolean;
  errorCode: string | null;
  /** "Sent · 41 ms", "Failed · UNSAFE_URL · 88 ms". */
  detail: string;
}

export function testRowOf(t: WebhookTestAttempt): TestRow {
  return {
    key: t.id,
    at: t.at,
    type: t.type,
    status: t.status,
    ok: t.ok,
    errorCode: t.errorCode,
    detail: [t.ok ? 'Sent' : 'Failed', t.errorCode, `${t.durationMs} ms`]
      .filter(Boolean)
      .join(' · '),
  };
}
