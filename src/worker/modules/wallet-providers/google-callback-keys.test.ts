import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../test/fixtures/wallets/google/callback-envelope.json';
import {
  clearGoogleCallbackKeyCache,
  GoogleCallbackInvalid,
  GoogleCallbackKeysUnavailable,
  verifyGoogleCallback,
} from './google-callback-crypto.ts';
import {
  type CallbackSigningKeys,
  callbackKeyset,
  makeCallbackSigningKeys,
  signedGoogleEvent,
} from './google-callback-test-kit.ts';

const now = Date.UTC(2026, 0, 1);
const issuer = '33880000000223344';
const event = {
  classId: `${issuer}.c_${'a'.repeat(43)}`,
  objectId: `${issuer}.o_${'b'.repeat(43)}`,
  eventType: 'save',
  nonce: 'a-unique-nonce',
  expTimeMillis: String(now + 3_600_000),
};
const bytes = (value: string) => new TextEncoder().encode(value);
let keys: CallbackSigningKeys;
beforeAll(async () => {
  keys = await makeCallbackSigningKeys();
});
beforeEach(() => clearGoogleCallbackKeyCache());
afterEach(() => vi.unstubAllGlobals());

describe('Google callback root key cache (G8)', () => {
  it('downloads the keys once and reuses them until the earliest keyExpiration', async () => {
    const live = await callbackKeyset(keys.root, now + 60_000);
    const soon = await callbackKeyset(keys.other, now + 30_000);
    const fetcher = vi.fn(async () => Response.json({ keys: [...live.keys, ...soon.keys] }));
    vi.stubGlobal('fetch', fetcher);
    let clock = now;
    const raw = bytes(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 50_000 }),
    );
    await verifyGoogleCallback(raw, issuer, () => clock);
    clock = now + 29_999;
    await verifyGoogleCallback(raw, issuer, () => clock);
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock = now + 30_000;
    await verifyGoogleCallback(raw, issuer, () => clock);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not let a download that never settles stall later callbacks', async () => {
    const fetcher = vi.fn(async () => Response.json(await callbackKeyset(keys.root, now + 60_000)));
    fetcher.mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetcher);
    const raw = bytes(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 }),
    );
    void verifyGoogleCallback(raw, issuer, () => now).catch(() => {});
    await expect(verifyGoogleCallback(raw, issuer, () => now)).resolves.toMatchObject({
      nonce: event.nonce,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps accepting callbacks from cached keys while Google keys endpoint is down', async () => {
    const fetcher = vi.fn(async () => Response.json(await callbackKeyset(keys.root, now + 60_000)));
    vi.stubGlobal('fetch', fetcher);
    const raw = bytes(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 }),
    );
    await verifyGoogleCallback(raw, issuer, () => now);
    fetcher.mockImplementation(async () => new Response('down', { status: 503 }));
    await expect(verifyGoogleCallback(raw, issuer, () => now + 1)).resolves.toMatchObject({
      nonce: event.nonce,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches once when a cached key set fails the chain check, after rotation', async () => {
    let keyset = await callbackKeyset(keys.root, now + 60_000);
    const fetcher = vi.fn(async () => Response.json(keyset));
    vi.stubGlobal('fetch', fetcher);
    const old = bytes(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 }),
    );
    await verifyGoogleCallback(old, issuer, () => now);
    keyset = await callbackKeyset(keys.other, now + 60_000);
    const rotated = bytes(
      await signedGoogleEvent(keys, issuer, event, {
        keyExpiration: now + 30_000,
        rootSigner: keys.other,
      }),
    );
    await expect(verifyGoogleCallback(rotated, issuer, () => now + 15_000)).resolves.toMatchObject({
      nonce: event.nonce,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not let forged signatures force a download per request', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(await callbackKeyset(keys.root, now + 600_000)),
    );
    vi.stubGlobal('fetch', fetcher);
    const forged = bytes(
      await signedGoogleEvent(keys, issuer, event, {
        keyExpiration: now + 30_000,
        rootSigner: keys.other,
      }),
    );
    await expect(verifyGoogleCallback(forged, issuer, () => now)).rejects.toBeInstanceOf(
      GoogleCallbackInvalid,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const offset of [1, 5_000, 9_999])
      await expect(verifyGoogleCallback(forged, issuer, () => now + offset)).rejects.toBeInstanceOf(
        GoogleCallbackInvalid,
      );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(verifyGoogleCallback(forged, issuer, () => now + 10_000)).rejects.toBeInstanceOf(
      GoogleCallbackInvalid,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('answers 503 rather than 401 when the refetch after a failed check cannot complete', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(await callbackKeyset(keys.root, now + 600_000)),
    );
    vi.stubGlobal('fetch', fetcher);
    const valid = bytes(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 }),
    );
    await verifyGoogleCallback(valid, issuer, () => now);
    fetcher.mockImplementation(async () => {
      throw new Error('network');
    });
    const rotated = bytes(
      await signedGoogleEvent(keys, issuer, event, {
        keyExpiration: now + 30_000,
        rootSigner: keys.other,
      }),
    );
    await expect(verifyGoogleCallback(rotated, issuer, () => now + 20_000)).rejects.toBeInstanceOf(
      GoogleCallbackKeysUnavailable,
    );
    // The failed refetch keeps the usable cached keys.
    await expect(verifyGoogleCallback(valid, issuer, () => now + 20_001)).resolves.toBeDefined();
  });

  it('does not download again inside the cooldown after a failed refetch', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(await callbackKeyset(keys.root, now + 600_000)),
    );
    vi.stubGlobal('fetch', fetcher);
    const valid = bytes(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 60_000 }),
    );
    await verifyGoogleCallback(valid, issuer, () => now);
    fetcher.mockImplementation(async () => new Response('slow down', { status: 429 }));
    const forged = bytes(
      await signedGoogleEvent(keys, issuer, event, {
        keyExpiration: now + 60_000,
        rootSigner: keys.other,
      }),
    );
    for (const offset of [20_000, 20_001, 22_000, 25_000, 29_999])
      await expect(verifyGoogleCallback(forged, issuer, () => now + offset)).rejects.toBeInstanceOf(
        GoogleCallbackKeysUnavailable,
      );
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () =>
      Response.json(await callbackKeyset(keys.root, now + 600_000)),
    );
    await expect(verifyGoogleCallback(forged, issuer, () => now + 30_000)).rejects.toBeInstanceOf(
      GoogleCallbackInvalid,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('negative-caches a failed cold download for the cooldown', async () => {
    const fetcher = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const raw = bytes(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 }),
    );
    for (const offset of [0, 1, 5_000, 9_999])
      await expect(verifyGoogleCallback(raw, issuer, () => now + offset)).rejects.toBeInstanceOf(
        GoogleCallbackKeysUnavailable,
      );
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () =>
      Response.json(await callbackKeyset(keys.root, now + 60_000)),
    );
    await expect(verifyGoogleCallback(raw, issuer, () => now + 10_000)).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('Google callback envelope tolerance (G10)', () => {
  it('ignores unknown fields on the envelope and intermediate key but still requires known ones', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, now + 60_000)),
    );
    const raw = JSON.parse(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 }),
    ) as Record<string, any>;
    raw.futureEnvelopeField = { anything: [1, 2] };
    raw.intermediateSigningKey.futureKeyField = 'x';
    await expect(
      verifyGoogleCallback(bytes(JSON.stringify(raw)), issuer, () => now),
    ).resolves.toMatchObject({
      nonce: event.nonce,
    });
    for (const drop of [
      'protocolVersion',
      'signature',
      'signedMessage',
      'intermediateSigningKey',
    ]) {
      const missing = { ...raw };
      delete missing[drop];
      await expect(
        verifyGoogleCallback(bytes(JSON.stringify(missing)), issuer, () => now),
      ).rejects.toBeInstanceOf(GoogleCallbackInvalid);
    }
    const noSignatures = structuredClone(raw);
    delete noSignatures.intermediateSigningKey.signatures;
    await expect(
      verifyGoogleCallback(bytes(JSON.stringify(noSignatures)), issuer, () => now),
    ).rejects.toBeInstanceOf(GoogleCallbackInvalid);
  });

  it('does not let unknown fields override signed content or key expiry', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, now + 60_000)),
    );
    const raw = JSON.parse(
      await signedGoogleEvent(keys, issuer, event, { keyExpiration: now + 30_000 }),
    ) as Record<string, any>;
    // Names the verifier reads from the signed key and message, planted where it must not look.
    raw.keyExpiration = String(now + 9_000_000);
    raw.intermediateSigningKey.keyExpiration = String(now + 9_000_000);
    raw.intermediateSigningKey.keyValue = raw.signature;
    raw.expTimeMillis = String(now + 9_000_000);
    raw.nonce = 'attacker-nonce';
    const verified = await verifyGoogleCallback(bytes(JSON.stringify(raw)), issuer, () => now);
    expect(verified).toEqual({
      classId: event.classId,
      objectId: event.objectId,
      eventType: 'save',
      nonce: event.nonce,
      expiresAt: now + 3_600_000,
      validUntil: now + 30_000,
    });
  });
});

describe('Google callback envelope contract fixture', () => {
  it('verifies the checked-in envelope with unknown fields against the fixture key set', async () => {
    const fetcher = vi.fn(async () => Response.json(fixture.keyset));
    vi.stubGlobal('fetch', fetcher);
    const parsed = JSON.parse(fixture.envelope) as Record<string, unknown>;
    expect(parsed).toHaveProperty('futureEnvelopeField');
    await expect(
      verifyGoogleCallback(bytes(fixture.envelope), fixture.issuerId, () => fixture.clock),
    ).resolves.toEqual(fixture.expected);
  });

  it('rejects the fixture for a different issuer or after its keys expire', async () => {
    vi.stubGlobal('fetch', async () => Response.json(fixture.keyset));
    await expect(
      verifyGoogleCallback(bytes(fixture.envelope), '12345', () => fixture.clock),
    ).rejects.toBeInstanceOf(GoogleCallbackInvalid);
    clearGoogleCallbackKeyCache();
    await expect(
      verifyGoogleCallback(
        bytes(fixture.envelope),
        fixture.issuerId,
        () => fixture.expected.validUntil,
      ),
    ).rejects.toBeInstanceOf(GoogleCallbackKeysUnavailable);
  });
});
