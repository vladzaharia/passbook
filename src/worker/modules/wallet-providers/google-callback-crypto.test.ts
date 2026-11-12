import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_CALLBACK_BODY_LIMIT,
  GOOGLE_CALLBACK_KEYS_URL,
  GoogleCallbackInvalid,
  GoogleCallbackKeysUnavailable,
  readGoogleCallbackBody,
  verifyGoogleCallback,
} from './google-callback-crypto.ts';
import {
  type CallbackSigningKeys,
  callbackKeyset,
  makeCallbackSigningKeys,
  signedGoogleEvent,
} from './google-callback-test-kit.ts';

const now = Date.now();
const issuer = '33880000000223344';
const event = {
  classId: `${issuer}.c_${'a'.repeat(43)}`,
  objectId: `${issuer}.o_${'b'.repeat(43)}`,
  eventType: 'save',
  nonce: 'a-unique-nonce',
  expTimeMillis: String(now + 60_000),
};
let keys: CallbackSigningKeys;
beforeAll(async () => {
  keys = await makeCallbackSigningKeys();
});
afterEach(() => vi.unstubAllGlobals());

function provideKeyset(keyset: object) {
  const fetcher = vi.fn(async () => Response.json(keyset));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const bytes = (message: string) => new TextEncoder().encode(message);

describe('Google ECv2SigningOnly callback signatures', () => {
  it('verifies generated P-256 DER signatures against rotated root keys and exact serialized fields', async () => {
    const live = await callbackKeyset(keys.root, now + 60_000);
    const expired = await callbackKeyset(keys.other, now);
    const fetcher = provideKeyset({ keys: [...expired.keys, ...live.keys] });
    const raw = await signedGoogleEvent(keys, issuer, event, {
      keyExpiration: now + 30_000,
      extraRootSigner: keys.other,
    });
    await expect(verifyGoogleCallback(bytes(raw), issuer, () => now)).resolves.toEqual({
      classId: event.classId,
      objectId: event.objectId,
      eventType: 'save',
      nonce: event.nonce,
      expiresAt: now + 60_000,
      validUntil: now + 30_000,
    });
    expect(fetcher).toHaveBeenCalledWith(GOOGLE_CALLBACK_KEYS_URL, {
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('fetches fresh keys when Google rotates its signing roots', async () => {
    let keyset = await callbackKeyset(keys.root, now + 60_000);
    const fetcher = vi.fn(async () => Response.json(keyset));
    vi.stubGlobal('fetch', fetcher);
    const first = await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 });
    await expect(verifyGoogleCallback(bytes(first), issuer, () => now)).resolves.toMatchObject({
      nonce: event.nonce,
    });
    keyset = await callbackKeyset(keys.other, now + 60_000);
    const rotated = await signedGoogleEvent(keys, issuer, event, {
      keyExpiration: now + 30_000,
      rootSigner: keys.other,
    });
    await expect(verifyGoogleCallback(bytes(rotated), issuer, () => now)).resolves.toMatchObject({
      nonce: event.nonce,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses the time after key download, not a stale time captured before it', async () => {
    let clock = now;
    const keyset = await callbackKeyset(keys.root, now + 10);
    vi.stubGlobal('fetch', async () => {
      clock = now + 10;
      return Response.json(keyset);
    });
    const raw = await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 });
    await expect(verifyGoogleCallback(bytes(raw), issuer, () => clock)).rejects.toBeInstanceOf(
      GoogleCallbackKeysUnavailable,
    );
  });

  it('does not trust attacker-supplied key URLs or accept oversized upstream keysets', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(64 * 1024 + 1)));
    vi.stubGlobal('fetch', fetcher);
    const raw = await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 });
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    envelope.keysUrl = 'https://attacker.example/keys';
    await expect(
      verifyGoogleCallback(bytes(JSON.stringify(envelope)), issuer, () => now),
    ).rejects.toBeInstanceOf(GoogleCallbackInvalid);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(verifyGoogleCallback(bytes(raw), issuer, () => now)).rejects.toBeInstanceOf(
      GoogleCallbackKeysUnavailable,
    );
    expect(fetcher).toHaveBeenCalledWith(GOOGLE_CALLBACK_KEYS_URL, {
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects wrong sender, recipient, forged root or message, and altered signed content', async () => {
    provideKeyset(await callbackKeyset(keys.root, now + 60_000));
    const options = { keyExpiration: now + 30_000 };
    const valid = await signedGoogleEvent(keys, issuer, event, options);
    const changed = JSON.parse(valid) as { signedMessage: string };
    changed.signedMessage = changed.signedMessage.replace('a-unique-nonce', 'altered-nonce');
    const cases = [
      await signedGoogleEvent(keys, issuer, event, { ...options, sender: 'Google' }),
      await signedGoogleEvent(keys, issuer, event, { ...options, recipient: '12345' }),
      await signedGoogleEvent(keys, issuer, event, { ...options, rootSigner: keys.other }),
      await signedGoogleEvent(keys, issuer, event, { ...options, messageSigner: keys.other }),
      JSON.stringify(changed),
    ];
    for (const raw of cases)
      await expect(verifyGoogleCallback(bytes(raw), issuer, () => now)).rejects.toBeInstanceOf(
        GoogleCallbackInvalid,
      );
  });

  it('rejects expiry at the exact millisecond for root, intermediate and both message expiration fields', async () => {
    const valid = await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 });
    provideKeyset(await callbackKeyset(keys.root, now));
    await expect(verifyGoogleCallback(bytes(valid), issuer, () => now)).rejects.toBeInstanceOf(
      GoogleCallbackKeysUnavailable,
    );
    provideKeyset(await callbackKeyset(keys.root, now + 30_000));
    for (const raw of [
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now }),
      await signedGoogleEvent(
        keys,
        issuer,
        { ...event, expTimeMillis: now },
        { keyExpiration: now + 30_000 },
      ),
      await signedGoogleEvent(
        keys,
        issuer,
        { ...event, messageExpiration: String(now) },
        { keyExpiration: now + 30_000 },
      ),
    ])
      await expect(verifyGoogleCallback(bytes(raw), issuer, () => now)).rejects.toBeInstanceOf(
        GoogleCallbackInvalid,
      );
  });

  it('enforces issuer prefixes, event type and an actual streamed byte limit', async () => {
    provideKeyset(await callbackKeyset(keys.root, now + 60_000));
    for (const changed of [
      { classId: `123.c_${'a'.repeat(43)}` },
      { objectId: `123.o_${'b'.repeat(43)}` },
      { eventType: 'install' },
      { nonce: '' },
    ]) {
      const raw = await signedGoogleEvent(
        keys,
        issuer,
        { ...event, ...changed },
        { keyExpiration: now + 30_000 },
      );
      await expect(verifyGoogleCallback(bytes(raw), issuer, () => now)).rejects.toBeInstanceOf(
        GoogleCallbackInvalid,
      );
    }
    const request = new Request('https://example.test/', {
      method: 'POST',
      headers: { 'content-length': '1' },
      body: 'x'.repeat(GOOGLE_CALLBACK_BODY_LIMIT + 1),
    });
    await expect(readGoogleCallbackBody(request)).rejects.toMatchObject({ status: 413 });
  });
});
