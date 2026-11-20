import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../types.ts';
import { decodeBase64_32, decodeHex32, decodeJsonStrict, parseStripeSignature } from './decode.ts';
import {
  REPLAY_WINDOW_MS,
  signWebhook,
  VERIFIERS,
  verifySignedRequest,
  type WebhookVerifier,
  webhookSecretsOf,
  withinWindow,
} from './hmac.ts';

const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

async function mac(secret: string, message: string | Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      typeof message === 'string' ? enc.encode(message) : message,
    ),
  );
}

const post = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
  new Request('https://x.test/hook', { method: 'POST', body, headers });

async function outcome(
  id: WebhookVerifier['id'],
  req: Request,
  secrets: readonly string[],
  now = 0,
): Promise<string> {
  return VERIFIERS[id].verify(req, secrets, now).then(
    () => 'ok',
    (e: unknown) => (e instanceof ConnectorError ? e.code : 'THROWN'),
  );
}

// Fixtures of the design (section 2.4), signed independently of this code.
const SHOPIFY = {
  secret: 'shpss_test_secret_0123456789abcdef',
  body: '{"id":820982911946154508,"email":"jon@example.com","cancelled_at":null,"updated_at":"2026-11-18T10:00:00-05:00"}',
  sig: 'Oa0gejiNAO+7mpyIGQkoQiRElCprtvWmjRIuEHyuaWc=',
};
const STRIPE = {
  secret: 'whsec_test_secret',
  t: 1763460000,
  body: '{"id":"evt_test_webhook","object":"event","type":"customer.subscription.updated","created":1763460000,"data":{"object":{"id":"sub_123","object":"subscription","status":"active"}}}',
  v1: 'c08b1c950ec63622e8063324fbaa10fdf87b6cc13f99187f1c9c2e97fa426a73',
};
const CALCOM = {
  secret: 'cal_test_secret_0123456789',
  body: '{"triggerEvent":"BOOKING_CREATED","createdAt":"2026-11-18T10:00:00.000Z","payload":{"uid":"bk_abc123","bookingId":42}}',
  sig: 'a7d59d35769661660e56d834a09a32b2d430d94dd3e29180338dcd1b279ceb2c',
};
const STRIPE_NOW = STRIPE.t * 1000;
const stripeHeader = (t: number | string, ...entries: string[]) => [`t=${t}`, ...entries].join(',');

describe('strict decoders', () => {
  const good = 'ab'.repeat(32);
  it.each([
    [good, true],
    [good.toUpperCase(), false],
    [good.slice(1), false],
    [`${good}0`, false],
    [` ${good}`, false],
    [`${good.slice(0, 62)}zz`, false],
    ['', false],
  ])('hex %j -> %j', (s, ok) => {
    expect(decodeHex32(s) !== null).toBe(ok);
  });

  const raw = new Uint8Array(32).map((_, i) => 250 - i * 7);
  it.each([
    [b64(raw), true],
    [b64(raw).slice(0, -1), false],
    [`${b64(raw)}=`, false],
    [hex(raw), false],
    [b64(raw).replace(/\+/g, '-').replace(/\//g, '_'), false],
    [b64(raw).slice(0, 43), false],
    // same 32 bytes with non-zero padding bits: a malleable twin of a valid value
    ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=', false],
    ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', true],
  ])('base64 %j -> %j', (s, ok) => {
    expect(decodeBase64_32(s) !== null).toBe(ok);
  });

  it('decodes to the exact bytes', () => {
    expect(decodeHex32(`${'00'.repeat(31)}ff`)?.at(-1)).toBe(255);
    expect(decodeBase64_32(b64(raw))).toEqual(raw);
  });
});

describe('parseStripeSignature', () => {
  const a = 'aa'.repeat(32);
  const b = 'bb'.repeat(32);
  it.each([
    [`t=1763460000,v1=${a}`, 1],
    [`v1=${a},t=1763460000`, 1],
    [`t=1763460000,v1=${a},v1=${b}`, 2],
    [`t=1763460000,v0=${b},v1=${a},secret=whsec_****PzVt,payload=a25aefc6,foo`, 1],
  ])('%j gives %j v1 entries', (h, n) => {
    const r = parseStripeSignature(h);
    expect(r?.t).toBe(1763460000);
    expect(r?.v1).toHaveLength(n);
  });

  it.each([
    ['no t', `v1=${a}`],
    ['only v0', `t=1763460000,v0=${a}`],
    ['no v1', 't=1763460000'],
    ['bad v1 only', 't=1763460000,v1=zz'],
    ['non-numeric t', `t=abc,v1=${a}`],
    ['negative t', `t=-5,v1=${a}`],
    ['leading zero t', `t=01763460000,v1=${a}`],
    ['float t', `t=1763460000.5,v1=${a}`],
    ['two t values', `t=1763460000,t=1763460001,v1=${a}`],
    ['empty', ''],
  ])('rejects %s', (_n, h) => {
    expect(parseStripeSignature(h)).toBeNull();
  });

  it('tries only the first 8 v1 entries', () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `v1=${String(i).padStart(2, '0').repeat(32)}`,
    );
    expect(parseStripeSignature(`t=1763460000,${many.join(',')}`)?.v1).toHaveLength(8);
  });
});

describe('withinWindow', () => {
  it.each([
    [0, 0, true],
    [300_000, 0, true],
    [300_001, 0, false],
    [0, 60_000, true],
    [0, 60_001, false],
  ])('now %d, signed %d -> %j', (now, signedAt, ok) => {
    expect(withinWindow(now, signedAt, 300_000, 60_000)).toBe(ok);
  });
});

describe('shopify', () => {
  const ok = (body = SHOPIFY.body, sig = SHOPIFY.sig, h = 'x-shopify-hmac-sha256') =>
    outcome('shopify', post(body, { [h]: sig }), [SHOPIFY.secret]);

  it('accepts the fixture and is header-case insensitive', async () => {
    expect(await ok()).toBe('ok');
    expect(await ok(SHOPIFY.body, SHOPIFY.sig, 'X-Shopify-Hmac-SHA256')).toBe('ok');
  });

  it('matches the fixture computed here', async () => {
    expect(b64(await mac(SHOPIFY.secret, SHOPIFY.body))).toBe(SHOPIFY.sig);
  });

  it('rejects a tampered body, a flipped signature byte and a wrong key', async () => {
    expect(await ok(SHOPIFY.body.replace('jon', 'joe'))).toBe('AUTH');
    expect(
      await ok(SHOPIFY.body, `${SHOPIFY.sig.startsWith('O') ? 'P' : 'O'}${SHOPIFY.sig.slice(1)}`),
    ).toBe('AUTH');
    expect(
      await outcome('shopify', post(SHOPIFY.body, { 'x-shopify-hmac-sha256': SHOPIFY.sig }), [
        'other-secret-value',
      ]),
    ).toBe('AUTH');
  });

  it.each([
    ['hex instead of base64', hex(decodeBase64_32(SHOPIFY.sig) ?? new Uint8Array())],
    ['unpadded', SHOPIFY.sig.slice(0, -1)],
    ['base64url', SHOPIFY.sig.replace(/\+/g, '-')],
    ['43 chars', SHOPIFY.sig.slice(0, 43)],
    ['45 chars', `${SHOPIFY.sig}A`],
    ['empty', ''],
  ])('rejects a header in the wrong form: %s', async (_n, sig) => {
    expect(await ok(SHOPIFY.body, sig)).toBe('AUTH');
  });

  it('rejects a missing header', async () => {
    expect(await outcome('shopify', post(SHOPIFY.body), [SHOPIFY.secret])).toBe('AUTH');
  });

  it("does not accept another scheme's header", async () => {
    expect(await ok(SHOPIFY.body, SHOPIFY.sig, 'x-cal-signature-256')).toBe('AUTH');
  });

  it('allows up to 1 MiB, not more', async () => {
    const pad = 'x'.repeat(600 * 1024);
    const body = JSON.stringify({ pad });
    const sig = b64(await mac(SHOPIFY.secret, body));
    expect(await ok(body, sig)).toBe('ok');
    const big = JSON.stringify({ pad: 'x'.repeat(1100 * 1024) });
    expect(await ok(big, b64(await mac(SHOPIFY.secret, big)))).toBe('INVALID_PAYLOAD');
  });
});

describe('calcom', () => {
  const ok = (sig: string | null, body = CALCOM.body) =>
    outcome('calcom', post(body, sig === null ? {} : { 'x-cal-signature-256': sig }), [
      CALCOM.secret,
    ]);

  it('accepts the documented plain hex form', async () => {
    expect(await ok(CALCOM.sig)).toBe('ok');
  });

  it('matches the fixture computed here', async () => {
    expect(hex(await mac(CALCOM.secret, CALCOM.body))).toBe(CALCOM.sig);
  });

  it.each([
    ['uppercase hex', CALCOM.sig.toUpperCase()],
    ['no-secret-provided', 'no-secret-provided'],
    ['empty', ''],
    ['sha256= prefix', `sha256=${CALCOM.sig}`],
    ['other prefix', `sha1=${CALCOM.sig}`],
    ['double prefix', `sha256=sha256=${CALCOM.sig}`],
    ['63 chars', CALCOM.sig.slice(1)],
  ])('rejects %s', async (_n, sig) => {
    expect(await ok(sig)).toBe('AUTH');
  });

  it('rejects a missing header and a tampered body', async () => {
    expect(await ok(null)).toBe('AUTH');
    expect(await ok(CALCOM.sig, CALCOM.body.replace('BOOKING_CREATED', 'BOOKING_CANCELLED'))).toBe(
      'AUTH',
    );
  });
});

describe('stripe', () => {
  const sign = async (t: number, body = STRIPE.body, secret = STRIPE.secret) =>
    hex(await mac(secret, `${t}.${body}`));
  const run = (
    header: string | null,
    body = STRIPE.body,
    secrets = [STRIPE.secret],
    now = STRIPE_NOW,
  ) =>
    outcome(
      'stripe',
      post(body, header === null ? {} : { 'stripe-signature': header }),
      secrets,
      now,
    );

  it('accepts the fixture', async () => {
    expect(await run(stripeHeader(STRIPE.t, `v1=${STRIPE.v1}`))).toBe('ok');
  });

  it('matches the fixture computed here, with the whsec_ prefix in the key', async () => {
    expect(await sign(STRIPE.t)).toBe(STRIPE.v1);
    expect(await sign(STRIPE.t, STRIPE.body, 'test_secret')).not.toBe(STRIPE.v1);
  });

  it('accepts when any v1 matches, in any order, with unknown and debug entries', async () => {
    const bad = 'ee'.repeat(32);
    expect(await run(stripeHeader(STRIPE.t, `v1=${bad}`, `v1=${STRIPE.v1}`))).toBe('ok');
    expect(
      await run(
        `v0=${bad},destination=we_1,v1=${STRIPE.v1},payload=a25aefc6,secret=whsec_****PzVt,t=${STRIPE.t}`,
      ),
    ).toBe('ok');
  });

  it('rejects a downgrade: valid v0, invalid v1', async () => {
    const v0 = await sign(STRIPE.t);
    expect(await run(stripeHeader(STRIPE.t, `v0=${v0}`, `v1=${'ee'.repeat(32)}`))).toBe('AUTH');
    expect(await run(stripeHeader(STRIPE.t, `v0=${v0}`))).toBe('AUTH');
  });

  it('rejects a tampered body and a flipped signature byte', async () => {
    expect(
      await run(
        stripeHeader(STRIPE.t, `v1=${STRIPE.v1}`),
        STRIPE.body.replace('active', 'canceled'),
      ),
    ).toBe('AUTH');
    const flipped = `${STRIPE.v1.startsWith('c') ? 'd' : 'c'}${STRIPE.v1.slice(1)}`;
    expect(await run(stripeHeader(STRIPE.t, `v1=${flipped}`))).toBe('AUTH');
  });

  it('rejects a timestamp that is signed over but swapped in the header', async () => {
    expect(await run(stripeHeader(STRIPE.t + 1, `v1=${STRIPE.v1}`))).toBe('AUTH');
  });

  it('enforces 5 minutes past and 1 minute future, after the MAC', async () => {
    const header = stripeHeader(STRIPE.t, `v1=${STRIPE.v1}`);
    expect(await run(header, STRIPE.body, [STRIPE.secret], STRIPE_NOW + 300_000)).toBe('ok');
    expect(await run(header, STRIPE.body, [STRIPE.secret], STRIPE_NOW + 300_001)).toBe('AUTH');
    expect(await run(header, STRIPE.body, [STRIPE.secret], STRIPE_NOW - 60_000)).toBe('ok');
    expect(await run(header, STRIPE.body, [STRIPE.secret], STRIPE_NOW - 60_001)).toBe('AUTH');
  });

  it('rejects an expired timestamp even with a valid signature over it', async () => {
    const t = STRIPE.t - 3600;
    expect(await run(stripeHeader(t, `v1=${await sign(t)}`))).toBe('AUTH');
  });

  it.each([
    ['missing header', null],
    ['no t', `v1=${STRIPE.v1}`],
    ['non-numeric t', `t=now,v1=${STRIPE.v1}`],
    ['empty', ''],
  ])('rejects %s', async (_n, header) => {
    expect(await run(header)).toBe('AUTH');
  });

  it('ignores v1 entries past the eighth', async () => {
    const junk = Array.from({ length: 8 }, (_, i) => `v1=${String(i).padStart(2, '0').repeat(32)}`);
    expect(await run(stripeHeader(STRIPE.t, ...junk, `v1=${STRIPE.v1}`))).toBe('AUTH');
  });

  it('rejects a body larger than 256 KiB by content-length and by stream', async () => {
    const header = { 'stripe-signature': stripeHeader(STRIPE.t, `v1=${STRIPE.v1}`) };
    const big = 'x'.repeat(300 * 1024);
    expect(await outcome('stripe', post(big, header), [STRIPE.secret], STRIPE_NOW)).toBe(
      'INVALID_PAYLOAD',
    );
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(64 * 1024));
        if (pulled > 1000) c.close();
      },
    });
    const req = new Request('https://x.test', {
      method: 'POST',
      body: stream,
      headers: header,
      duplex: 'half',
    } as RequestInit);
    expect(await outcome('stripe', req, [STRIPE.secret], STRIPE_NOW)).toBe('INVALID_PAYLOAD');
    expect(pulled).toBeLessThan(20);
  });
});

describe('verifier contract', () => {
  it.each(Object.values(VERIFIERS))('$id declares where its replay bound comes from', (v) => {
    expect(['header-window', 'body-window']).toContain(v.replay);
  });

  it('the schemes without a signed timestamp header are body-window', () => {
    expect(VERIFIERS.shopify.replay).toBe('body-window');
    expect(VERIFIERS.calcom.replay).toBe('body-window');
    expect(VERIFIERS.stripe.replay).toBe('header-window');
    expect(VERIFIERS.custom.replay).toBe('header-window');
  });

  it('header-window verifiers return the signed time', async () => {
    const t = STRIPE.t;
    const res = await VERIFIERS.stripe.verify(
      post(STRIPE.body, { 'stripe-signature': stripeHeader(t, `v1=${STRIPE.v1}`) }),
      [STRIPE.secret],
      t * 1000,
    );
    expect(res.signedAt).toBe(t * 1000);
  });

  it.each([
    ['shopify', {}, SHOPIFY.secret],
    ['shopify', { 'x-shopify-hmac-sha256': 'bad' }, SHOPIFY.secret],
    ['calcom', {}, CALCOM.secret],
    ['stripe', {}, STRIPE.secret],
    ['stripe', { 'stripe-signature': 'v1=zz' }, STRIPE.secret],
    ['custom', {}, 'whsec_custom_value_01'],
  ] as const)(
    '%s: a missing or malformed header is AUTH before any body byte is read',
    async (id, headers, secret) => {
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1;
          c.enqueue(new Uint8Array(1024));
        },
      });
      const req = new Request('https://x.test', {
        method: 'POST',
        body: stream,
        headers,
        duplex: 'half',
      } as RequestInit);
      expect(await outcome(id, req, [secret])).toBe('AUTH');
      // The stream's own priming pull is the only one: the verifier reads nothing.
      expect(pulled).toBeLessThanOrEqual(1);
    },
  );
});

describe('raw bytes', () => {
  const invalid = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);

  it('verifies a body with non-ASCII text and a BOM', async () => {
    const body = enc.encode('﻿{"name":"Zoë 日本語 \u{1F600}"}');
    const sig = b64(await mac(SHOPIFY.secret, body));
    const res = await VERIFIERS.shopify.verify(
      post(body, { 'x-shopify-hmac-sha256': sig }),
      [SHOPIFY.secret],
      0,
    );
    expect(res.bytes).toEqual(body);
    expect(decodeJsonStrict(res.bytes)).toEqual({ name: 'Zoë 日本語 \u{1F600}' });
  });

  it('a MAC over re-encoded text fails: invalid UTF-8 is not rewritten to U+FFFD', async () => {
    const reencoded = enc.encode(new TextDecoder().decode(invalid));
    expect(reencoded).not.toEqual(invalid);
    const sigOfReencoded = b64(await mac(SHOPIFY.secret, reencoded));
    expect(
      await outcome('shopify', post(invalid, { 'x-shopify-hmac-sha256': sigOfReencoded }), [
        SHOPIFY.secret,
      ]),
    ).toBe('AUTH');
  });

  it('invalid UTF-8 with a valid MAC over the raw bytes is a bad payload, not bad auth', async () => {
    const sig = b64(await mac(SHOPIFY.secret, invalid));
    const res = await VERIFIERS.shopify.verify(
      post(invalid, { 'x-shopify-hmac-sha256': sig }),
      [SHOPIFY.secret],
      0,
    );
    expect(res.bytes).toEqual(invalid);
    expect(() => decodeJsonStrict(res.bytes)).toThrow(ConnectorError);
    try {
      decodeJsonStrict(res.bytes);
    } catch (e) {
      expect((e as ConnectorError).code).toBe('INVALID_PAYLOAD');
    }
  });

  it('the custom scheme signs the received bytes too (regression: re-encoded text)', async () => {
    const t = 1763460000;
    const sigOfReencoded = hex(
      await mac('whsec_custom_value_01', enc.encode(`${t}.${new TextDecoder().decode(invalid)}`)),
    );
    const req = post(invalid, {
      'x-wallet-timestamp': String(t),
      'x-wallet-signature': `v1=${sigOfReencoded}`,
    });
    const res = await verifySignedRequest(req, {
      secrets: ['whsec_custom_value_01'],
      now: t * 1000,
    }).catch((e: ConnectorError) => e.code);
    expect(res).toBe('AUTH');
    const rawSig = hex(
      await mac('whsec_custom_value_01', new Uint8Array([...enc.encode(`${t}.`), ...invalid])),
    );
    const req2 = post(invalid, {
      'x-wallet-timestamp': String(t),
      'x-wallet-signature': `v1=${rawSig}`,
    });
    const res2 = await verifySignedRequest(req2, {
      secrets: ['whsec_custom_value_01'],
      now: t * 1000,
    }).catch((e: ConnectorError) => e.code);
    expect(res2).toBe('INVALID_PAYLOAD');
  });
});

describe('secrets and overlap', () => {
  const header = { 'x-shopify-hmac-sha256': SHOPIFY.sig };
  const verify = (secrets: readonly string[]) =>
    outcome('shopify', post(SHOPIFY.body, header), secrets);

  it('accepts the previous secret as the second entry and fails without it', async () => {
    expect(await verify(['new-secret-value-1', SHOPIFY.secret])).toBe('ok');
    expect(await verify(['new-secret-value-1'])).toBe('AUTH');
  });

  it('no secrets or an empty secret is a permanent AUTH', async () => {
    for (const secrets of [[], ['']]) {
      const err = await VERIFIERS.shopify
        .verify(post(SHOPIFY.body, header), secrets, 0)
        .catch((e: ConnectorError) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe('AUTH');
      expect((err as ConnectorError).permanent).toBe(true);
    }
  });

  it('reports when only the previous secret matched', async () => {
    const run = (secrets: string[]) =>
      VERIFIERS.shopify.verify(post(SHOPIFY.body, header), secrets, 0);
    expect((await run([SHOPIFY.secret, 'old-secret-value-001'])).usedPrevious).toBeUndefined();
    expect((await run(['new-secret-value-1', SHOPIFY.secret])).usedPrevious).toBe(true);
  });

  it('more than two secrets is a coded permanent CONFIG error, not a bare Error', async () => {
    const err = await VERIFIERS.shopify
      .verify(post(SHOPIFY.body, header), ['a'.repeat(20), 'b'.repeat(20), SHOPIFY.secret], 0)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe('CONFIG');
    expect((err as ConnectorError).permanent).toBe(true);
  });

  it('webhookSecretsOf prefers the list and falls back to the single secret', () => {
    expect(webhookSecretsOf({ webhookSecrets: ['a', 'b'], webhookSecret: 'a' })).toEqual([
      'a',
      'b',
    ]);
    expect(webhookSecretsOf({ webhookSecret: 'a' })).toEqual(['a']);
    expect(webhookSecretsOf({})).toEqual([]);
  });
});

describe('custom scheme (verifySignedRequest, signWebhook)', () => {
  const secret = 'whsec_test_secret_value';
  const now = Date.UTC(2026, 0, 1);
  const ts = Math.floor(now / 1000);
  const body = JSON.stringify({ id: 'evt1', refs: ['a'] });

  async function request(over: { sig?: string; ts?: number; body?: string } = {}) {
    const timestamp = over.ts ?? ts;
    return new Request('https://x.test/hook', {
      method: 'POST',
      body: over.body ?? body,
      headers: {
        'x-wallet-timestamp': String(timestamp),
        'x-wallet-signature': over.sig ?? (await signWebhook(secret, timestamp, body)),
      },
    });
  }
  const verify = async (req: Request, at = now) =>
    verifySignedRequest(req, { secrets: [secret], now: at }).then(
      () => 'ok',
      (e: ConnectorError) => e.code,
    );

  it('accepts a valid signature and returns the decoded body', async () => {
    expect(await verify(await request())).toBe('ok');
    const res = await verifySignedRequest(await request(), { secrets: [secret], now });
    expect(res.body).toBe(body);
    expect(res.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the x-passbook-* spelling, and either one when both are present', async () => {
    const sig = await signWebhook(secret, ts, body);
    const send = (headers: Record<string, string>) =>
      new Request('https://x.test/hook', { method: 'POST', body, headers });
    const passbook = { 'x-passbook-timestamp': String(ts), 'x-passbook-signature': sig };
    expect(await verify(send(passbook))).toBe('ok');
    expect(await verify(send({ ...passbook, 'x-wallet-signature': 'v1=junk' }))).toBe('ok');
    expect(await verify(send({ 'x-passbook-timestamp': String(ts) }))).toBe('AUTH');
  });

  it('rejects a tampered body', async () => {
    expect(await verify(await request({ body: body.replace('evt1', 'evt2') }))).toBe('AUTH');
  });

  it('rejects a wrong secret and a missing secret', async () => {
    const other = await signWebhook('another-secret-value', ts, body);
    expect(await verify(await request({ sig: other }))).toBe('AUTH');
    const res = await verifySignedRequest(await request(), { secrets: [], now }).catch(
      (e: ConnectorError) => e.code,
    );
    expect(res).toBe('AUTH');
  });

  it('accepts the previous secret while it is listed', async () => {
    const res = await verifySignedRequest(await request(), {
      secrets: ['new-secret-value-1', secret],
      now,
    });
    expect(res.body).toBe(body);
  });

  it('rejects malformed or missing headers', async () => {
    expect(await verify(await request({ sig: 'v1=zz' }))).toBe('AUTH');
    expect(await verify(new Request('https://x.test', { method: 'POST', body }))).toBe('AUTH');
  });

  it('enforces the replay window in both directions', async () => {
    expect(await verify(await request({ ts: ts - REPLAY_WINDOW_MS / 1000 - 5 }))).toBe('AUTH');
    expect(await verify(await request({ ts: ts + 120 }))).toBe('AUTH');
    expect(await verify(await request({ ts: ts - 200 }))).toBe('ok');
  });

  it('rejects oversized bodies before verifying', async () => {
    const req = new Request('https://x.test', {
      method: 'POST',
      body: 'x'.repeat(300 * 1024),
      headers: { 'x-wallet-timestamp': String(ts), 'x-wallet-signature': `v1=${'0'.repeat(64)}` },
    });
    expect(await verify(req)).toBe('INVALID_PAYLOAD');
  });
});
