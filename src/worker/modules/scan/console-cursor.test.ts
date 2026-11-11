import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../platform/clock.ts';
import { encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { fromBase64Url, randomBytes, toBase64, toBase64Url } from '../../platform/ids.ts';
import {
  type ConsoleCursorScope,
  decodeConsoleCursor,
  encodeConsoleCursor,
  type ScanCursorPosition,
} from './console-cursor.ts';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);
const kek = () => toBase64(randomBytes(32));

function setup(env: Record<string, string> = { KEK_V1: kek() }) {
  const clock = new ManualClock(START);
  return { ctx: { env: env as unknown as AppEnv, clock }, clock };
}

function scope(): ConsoleCursorScope {
  return {
    auth: { kind: 'session', userId: 'user-alice', sessionId: 'session-one' },
    orgId: 'org-north',
    mode: 'live',
    operation: 'list',
    filters: {
      q: 'VIP pass',
      passId: 'pass-secret',
      scannerId: 'scanner-one',
      staffId: 'staff-one',
      eventId: 'event-one',
      outcome: 'refused',
      reason: 'not_found',
      from: 0,
      to: START,
    },
  };
}

const position: ScanCursorPosition = { at: START - 500, id: 'hidden-scan-id-1a2b3c' };
const invalid = {
  name: 'ValidationError',
  code: 'INVALID_CURSOR',
  status: 422,
  message: 'Invalid cursor.',
};

describe('opaque scan console cursor', () => {
  it('round-trips without exposing scope or position and uses fresh randomness', async () => {
    const { ctx } = setup();
    const requestScope = scope();
    const first = await encodeConsoleCursor(ctx, requestScope, position);
    const second = await encodeConsoleCursor(ctx, requestScope, position);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(512);
    expect(second.length).toBeLessThanOrEqual(512);
    expect(await decodeConsoleCursor(ctx, requestScope, first)).toEqual(position);
    expect(await decodeConsoleCursor(ctx, requestScope, second)).toEqual(position);

    const parts = first.split('.');
    expect(parts[0]).toBe('sc1');
    expect(parts[1]).toBe('1');
    const encoded = parts.slice(2).map((part) => fromBase64Url(part));
    const raw = encoded.map((part) => String.fromCharCode(...part)).join('');
    const utf16Id = [...position.id].map((char) => `\u0000${char}`).join('');
    expect(raw).not.toContain(utf16Id);
    for (const secret of [
      position.id,
      'user-alice',
      'session-one',
      'org-north',
      'pass-secret',
      'VIP pass',
    ]) {
      expect(first).not.toContain(secret);
      expect(raw).not.toContain(secret);
    }
  });

  it('supports the full ID schema without exceeding the page cursor limit', async () => {
    const { ctx } = setup();
    const longest = '\u0000\ud800'.repeat(32);
    const requestScope = scope();
    requestScope.auth = { kind: 'session', userId: 'u'.repeat(64), sessionId: 's'.repeat(64) };
    requestScope.orgId = 'o'.repeat(64);
    requestScope.filters = {
      q: 'q'.repeat(80),
      passId: 'p'.repeat(64),
      scannerId: 'c'.repeat(64),
      staffId: 's'.repeat(64),
      eventId: 'e'.repeat(64),
      outcome: 'heads_up',
      reason: 'r'.repeat(64),
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
    };
    const edge = { at: Number.MAX_SAFE_INTEGER, id: longest };
    const token = await encodeConsoleCursor(ctx, requestScope, edge);
    expect(token.length).toBeLessThanOrEqual(512);
    await expect(decodeConsoleCursor(ctx, requestScope, token)).resolves.toEqual(edge);
  });

  it('authenticates every actor, credential, organization, mode and operation', async () => {
    const { ctx } = setup();
    const original = scope();
    const token = await encodeConsoleCursor(ctx, original, position);
    const others: ConsoleCursorScope[] = [
      { ...original, auth: { kind: 'session', userId: 'user-bob', sessionId: 'session-one' } },
      { ...original, auth: { kind: 'session', userId: 'user-alice', sessionId: 'session-two' } },
      { ...original, auth: { kind: 'api_key', keyId: 'user-alice' } },
      { ...original, orgId: 'org-south' },
      { ...original, orgId: undefined },
      { ...original, mode: 'test' },
      { ...original, operation: 'export' },
    ];
    for (const changed of others) {
      await expect(decodeConsoleCursor(ctx, changed, token)).rejects.toMatchObject(invalid);
    }
    const keyScope: ConsoleCursorScope = {
      ...original,
      auth: { kind: 'api_key', keyId: 'key-one' },
    };
    const keyToken = await encodeConsoleCursor(ctx, keyScope, position);
    await expect(decodeConsoleCursor(ctx, keyScope, keyToken)).resolves.toEqual(position);
    await expect(
      decodeConsoleCursor(
        ctx,
        {
          ...keyScope,
          auth: { kind: 'api_key', keyId: 'key-two' },
        },
        keyToken,
      ),
    ).rejects.toMatchObject(invalid);
  });

  it('authenticates every result-affecting filter, including zero-valued bounds', async () => {
    const { ctx } = setup();
    const original = scope();
    const token = await encodeConsoleCursor(ctx, original, position);
    const changes: Partial<ConsoleCursorScope['filters']>[] = [
      { q: 'vip pass' },
      { passId: 'pass-other' },
      { scannerId: 'scanner-other' },
      { staffId: 'staff-other' },
      { eventId: 'event-other' },
      { outcome: 'ok' },
      { reason: 'other' },
      { from: 1 },
      { to: START - 1 },
      { from: undefined },
      { to: undefined },
    ];
    for (const change of changes) {
      await expect(
        decodeConsoleCursor(
          ctx,
          {
            ...original,
            filters: { ...original.filters, ...change },
          },
          token,
        ),
      ).rejects.toMatchObject(invalid);
    }
  });

  it('canonicalizes query whitespace and absence but excludes paging controls', async () => {
    const { ctx } = setup();
    const original = scope();
    const token = await encodeConsoleCursor(ctx, original, position);
    const pagingControls = {
      ...original.filters,
      q: '  VIP pass  ',
      limit: 1,
      cursor: 'not-part-of-the-scope',
      internalCursor: { at: 0, id: 'also-not-part-of-the-scope' },
      now: 0,
    };
    await expect(
      decodeConsoleCursor(
        ctx,
        {
          ...original,
          filters: pagingControls,
        },
        token,
      ),
    ).resolves.toEqual(position);
    const unfiltered = { ...original, orgId: null, filters: { ...original.filters, q: undefined } };
    const noQueryToken = await encodeConsoleCursor(ctx, unfiltered, position);
    await expect(
      decodeConsoleCursor(
        ctx,
        {
          ...unfiltered,
          orgId: undefined,
          filters: { ...unfiltered.filters, q: '  ' },
        },
        noQueryToken,
      ),
    ).resolves.toEqual(position);
  });

  it('keeps identities with delimiter characters unambiguous', async () => {
    const { ctx } = setup();
    const first: ConsoleCursorScope = {
      ...scope(),
      auth: { kind: 'session', userId: 'a|b', sessionId: 'c' },
    };
    const other: ConsoleCursorScope = {
      ...first,
      auth: { kind: 'session', userId: 'a', sessionId: 'b|c' },
    };
    const token = await encodeConsoleCursor(ctx, first, position);
    await expect(decodeConsoleCursor(ctx, other, token)).rejects.toMatchObject(invalid);
  });

  it('rejects future issuance and expires at the exact deadline', async () => {
    const { ctx, clock } = setup();
    const requestScope = scope();
    const token = await encodeConsoleCursor(ctx, requestScope, position);
    clock.set(START - 1);
    await expect(decodeConsoleCursor(ctx, requestScope, token)).rejects.toMatchObject(invalid);
    clock.set(START + DAY - 1);
    await expect(decodeConsoleCursor(ctx, requestScope, token)).resolves.toEqual(position);
    clock.set(START + DAY);
    await expect(decodeConsoleCursor(ctx, requestScope, token)).rejects.toMatchObject(invalid);
  });

  it('rejects mutations of the IV, wrapped key and ciphertext', async () => {
    const { ctx } = setup();
    const requestScope = scope();
    const token = await encodeConsoleCursor(ctx, requestScope, position);
    for (const index of [2, 3, 4]) {
      const parts = token.split('.');
      const value = parts[index];
      if (!value) throw new Error('Missing token component');
      parts[index] = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
      await expect(decodeConsoleCursor(ctx, requestScope, parts.join('.'))).rejects.toMatchObject(
        invalid,
      );
    }
  });

  it('rejects malformed, noncanonical, oversized and raw-ID cursors', async () => {
    const { ctx } = setup();
    const requestScope = scope();
    const token = await encodeConsoleCursor(ctx, requestScope, { at: 0, id: 'ab' });
    const parts = token.split('.');
    const ciphertext = parts[4];
    if (!ciphertext) throw new Error('Missing ciphertext');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(ciphertext.at(-1) ?? '');
    const noncanonical = `${ciphertext.slice(0, -1)}${alphabet[last + 1]}`;
    expect(fromBase64Url(noncanonical)).toEqual(fromBase64Url(ciphertext));
    parts[4] = noncanonical;
    const malformed = [
      '',
      position.id,
      `${position.at}.${position.id}`,
      'sc1.1.a.b.c',
      ` ${token}`,
      `${token}\n`,
      `${token}\r`,
      `${token}=`,
      `${token}.extra`,
      token.replace('sc1.', 'sc2.'),
      token.replace('sc1.1.', 'sc1.01.'),
      parts.join('.'),
      'x'.repeat(513),
      null as unknown as string,
    ];
    for (const value of malformed) {
      await expect(decodeConsoleCursor(ctx, requestScope, value)).rejects.toMatchObject(invalid);
    }
  });

  it('reads old key versions during rotation and rejects retired or wrong keys', async () => {
    const key1 = kek();
    const key2 = kek();
    const old = setup({ KEK_V1: key1 });
    const rotated = setup({ KEK_V1: key1, KEK_V2: key2 });
    const retired = setup({ KEK_V2: key2 });
    const wrong = setup({ KEK_V1: kek() });
    const requestScope = scope();
    const oldToken = await encodeConsoleCursor(old.ctx, requestScope, position);
    const newToken = await encodeConsoleCursor(rotated.ctx, requestScope, position);
    expect(oldToken.split('.')[1]).toBe('1');
    expect(newToken.split('.')[1]).toBe('2');
    await expect(decodeConsoleCursor(rotated.ctx, requestScope, oldToken)).resolves.toEqual(
      position,
    );
    await expect(decodeConsoleCursor(rotated.ctx, requestScope, newToken)).resolves.toEqual(
      position,
    );
    await expect(decodeConsoleCursor(retired.ctx, requestScope, oldToken)).rejects.toMatchObject(
      invalid,
    );
    await expect(decodeConsoleCursor(wrong.ctx, requestScope, oldToken)).rejects.toMatchObject(
      invalid,
    );
    await expect(decodeConsoleCursor(old.ctx, requestScope, newToken)).rejects.toMatchObject(
      invalid,
    );
  });

  it('authenticates the key version even if two configured versions share key material', async () => {
    const material = kek();
    const old = setup({ KEK_V1: material });
    const rotated = setup({ KEK_V1: material, KEK_V2: material });
    const requestScope = scope();
    const token = await encodeConsoleCursor(old.ctx, requestScope, position);
    const changedVersion = token.replace('sc1.1.', 'sc1.2.');
    await expect(
      decodeConsoleCursor(rotated.ctx, requestScope, changedVersion),
    ).rejects.toMatchObject(invalid);
  });

  it('rejects authenticated payloads with invalid positions, lengths or lifetimes', async () => {
    const { ctx } = setup();
    const requestScope = scope();
    const aad = JSON.stringify([
      'scan-console-cursor-v1',
      1,
      'list',
      'user',
      'user-alice',
      'session',
      'session-one',
      'org-north',
      'live',
      'VIP pass',
      'pass-secret',
      'scanner-one',
      'staff-one',
      'event-one',
      'refused',
      'not_found',
      0,
      START,
    ]);
    const ring = await loadKekRing(ctx.env);
    const build = (at: bigint, issued: bigint, expiry: bigint, idBytes = 2) => {
      const bytes = new Uint8Array(24 + idBytes);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, at);
      view.setBigUint64(8, issued);
      view.setBigUint64(16, expiry);
      return bytes;
    };
    const issued = BigInt(START);
    const expiry = BigInt(START + DAY);
    const bodies = [
      build(0n, issued, expiry, 3),
      build(BigInt(Number.MAX_SAFE_INTEGER) + 1n, issued, expiry),
      build(0n, issued + 1n, expiry + 1n),
      build(0n, issued, expiry + 1n),
      build(0n, issued, issued),
    ];
    for (const body of bodies) {
      const envelope = await encryptSecret(ring, body, aad);
      const token = [
        'sc1',
        String(envelope.kekVersion),
        toBase64Url(envelope.iv),
        toBase64Url(envelope.wrappedDek),
        toBase64Url(envelope.ciphertext),
      ].join('.');
      await expect(decodeConsoleCursor(ctx, requestScope, token)).rejects.toMatchObject(invalid);
    }
  });

  it('does not manufacture a fallback when no encryption key is configured', async () => {
    const { ctx } = setup({});
    await expect(encodeConsoleCursor(ctx, scope(), position)).rejects.toThrow(/No KEK configured/);
  });
});
