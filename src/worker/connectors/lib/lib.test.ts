import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../types.ts';
import { REPLAY_WINDOW_MS, signWebhook, verifySignedRequest } from './hmac.ts';
import { assertSafeRef } from './http.ts';
import { getPointer, isPointer } from './pointer.ts';

describe('json pointer', () => {
  const doc = { a: { 'b/c': [10, { d: 'x' }], 'e~f': 1 }, n: null };

  it('resolves nested keys, arrays and escapes', () => {
    expect(getPointer(doc, '/a/b~1c/1/d')).toBe('x');
    expect(getPointer(doc, '/a/e~0f')).toBe(1);
    expect(getPointer(doc, '/a/b~1c/0')).toBe(10);
    expect(getPointer(doc, '')).toBe(doc);
  });

  it('returns undefined for missing paths and never walks the prototype', () => {
    expect(getPointer(doc, '/a/zzz')).toBeUndefined();
    expect(getPointer(doc, '/a/b~1c/9')).toBeUndefined();
    expect(getPointer(doc, '/a/b~1c/length')).toBeUndefined();
    expect(getPointer(doc, '/__proto__')).toBeUndefined();
    expect(getPointer(doc, '/constructor')).toBeUndefined();
    expect(getPointer(doc, '/n/x')).toBeUndefined();
  });

  it('treats a bare name as a top-level key', () => {
    expect(getPointer({ memberName: 'A' }, 'memberName')).toBe('A');
    expect(isPointer('memberName')).toBe(true);
    expect(isPointer('/a/~2')).toBe(false);
  });
});

describe('assertSafeRef', () => {
  it('encodes ordinary refs', () => {
    expect(assertSafeRef('a b&c')).toBe('a%20b%26c');
  });

  it.each(['..', 'a/../b', 'a/b', 'a\\b', '', 'x?y', 'x#y', 'a\u0000b', 'a'.repeat(201)])(
    'rejects %j',
    (ref) => {
      expect(() => assertSafeRef(ref)).toThrow(ConnectorError);
    },
  );
});

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret_value';
  const now = Date.UTC(2026, 0, 1);
  const ts = Math.floor(now / 1000);
  const body = JSON.stringify({ id: 'evt1', refs: ['a'] });

  async function request(over: { sig?: string; ts?: number; body?: string } = {}) {
    const timestamp = over.ts ?? ts;
    const text = over.body ?? body;
    return new Request('https://x.test/hook', {
      method: 'POST',
      body: text,
      headers: {
        'x-wallet-timestamp': String(timestamp),
        'x-wallet-signature': over.sig ?? (await signWebhook(secret, timestamp, body)),
      },
    });
  }
  const verify = async (req: Request, at = now) =>
    verifySignedRequest(req, { secret, now: at }).then(
      () => 'ok',
      (e: ConnectorError) => e.code,
    );

  it('accepts a valid signature', async () => {
    expect(await verify(await request())).toBe('ok');
  });

  it('rejects a tampered body', async () => {
    expect(await verify(await request({ body: body.replace('evt1', 'evt2') }))).toBe('AUTH');
  });

  it('rejects a wrong secret and a missing secret', async () => {
    const other = await signWebhook('another-secret-value', ts, body);
    expect(await verify(await request({ sig: other }))).toBe('AUTH');
    const res = await verifySignedRequest(await request(), { secret: undefined, now }).catch(
      (e: ConnectorError) => e.code,
    );
    expect(res).toBe('AUTH');
  });

  it('rejects malformed or missing headers', async () => {
    expect(await verify(await request({ sig: 'v1=zz' }))).toBe('AUTH');
    expect(await verify(new Request('https://x.test', { method: 'POST', body }))).toBe('AUTH');
  });

  it('enforces the replay window in both directions', async () => {
    const old = await request({ ts: ts - REPLAY_WINDOW_MS / 1000 - 5 });
    expect(await verify(old)).toBe('AUTH');
    const future = await request({ ts: ts + 120 });
    expect(await verify(future)).toBe('AUTH');
    expect(await verify(await request({ ts: ts - 200 }))).toBe('ok');
  });

  it('rejects oversized bodies before verifying', async () => {
    const big = 'x'.repeat(300 * 1024);
    const req = new Request('https://x.test', {
      method: 'POST',
      body: big,
      headers: { 'x-wallet-timestamp': String(ts), 'x-wallet-signature': `v1=${'0'.repeat(64)}` },
    });
    expect(await verify(req)).toBe('INVALID_PAYLOAD');
  });
});
