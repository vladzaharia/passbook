import { describe, expect, it } from 'vitest';
import { verifySignedRequest } from '../../connectors/lib/hmac.ts';
import { requestHeaders, signatureHeader } from './sign.ts';

const BODY = '{"id":"0193a1b2-0000-7000-8000-000000000001","type":"webhook.test"}';

describe('signing', () => {
  it('matches the published test vector', async () => {
    expect(await signatureHeader(['whsec_test_vector'], 1764000000, BODY)).toBe(
      'v1=2e47be5b02039b59b046e18c0a95a355bc374db0c467ffd40bac4de9bd480ca1',
    );
  });

  it('sends one v1 value per secret during a rotation, and each verifies', async () => {
    const headers = await requestHeaders({
      eventId: 'e1',
      eventType: 'pass.scanned',
      secrets: ['whsec_new', 'whsec_old'],
      nowMs: 1_764_000_000_500,
      body: BODY,
    });
    expect(headers['x-passbook-timestamp']).toBe('1764000000');
    expect(headers['x-passbook-event-id']).toBe('e1');
    expect(headers['x-passbook-event-type']).toBe('pass.scanned');
    expect(headers['user-agent']).toBe('PassBook-Webhooks/1.0');
    const values = (headers['x-passbook-signature'] ?? '').split(', ');
    expect(values).toHaveLength(2);
    // The inbound verifier is the receiver's recipe: each secret accepts its own value.
    for (const [i, secret] of ['whsec_new', 'whsec_old'].entries()) {
      const req = new Request('https://x.test/', {
        method: 'POST',
        body: BODY,
        headers: { 'x-wallet-signature': values[i] ?? '', 'x-wallet-timestamp': '1764000000' },
      });
      await expect(
        verifySignedRequest(req, { secret, now: 1_764_000_001_000 }),
      ).resolves.toMatchObject({ body: BODY });
    }
  });
});
