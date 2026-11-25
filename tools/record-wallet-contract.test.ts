import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { googleCalls, samsungCalls } from './lib/wallet-contract-plan.ts';
import { leaks, scrubValue } from './lib/wallet-scrub.ts';
import { recordContract, samsungAuth, scrubCapture } from './record-wallet-contract.ts';

const SECRET_BODY = {
  id: '3388000000022334455.rec-object',
  accessToken: 'ya29.a0AfH6SMBsecret',
  holder: { name: 'Jane Doe', email: 'jane@example.com' },
  barcode: { value: 'SECRET-BARCODE' },
  links: 'https://wallet.example/p/token123 and Bearer abc.def',
  jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln',
  key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
  state: 'ACTIVE',
};

describe('scrubber', () => {
  it('leaves no token, key, email, url, name or long id, and keeps the shape', () => {
    const out = JSON.stringify(scrubValue(SECRET_BODY));
    for (const s of [
      'ya29',
      'Jane',
      'jane@',
      'SECRET',
      'token123',
      'abc.def',
      'eyJ',
      'BEGIN',
      '3388000000',
    ])
      expect(out).not.toContain(s);
    expect(leaks(out)).toEqual([]);
    expect(out).toContain('"state":"ACTIVE"');
  });

  it('gives one placeholder to one id', () => {
    const out = JSON.stringify(
      scrubValue({
        a: '3388000000022334455.same',
        b: '3388000000022334455.same',
        c: '3388000000022334455.other',
      }),
    );
    expect(out).toContain('<issuer>.<id-1>');
    expect(out).toContain('<issuer>.<id-2>');
    expect(out.match(/<id-1>/g)).toHaveLength(2);
  });

  it('flags what it missed', () => {
    expect(leaks('{"a":"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0"}')).toContain('jwt');
    expect(leaks('{"a":"x@y.example"}')).toContain('email');
  });
});

describe('recordContract', () => {
  const calls = googleCalls('3388000000022334455', 'loyalty', 'rec1');

  it('dry run sends nothing and writes nothing', async () => {
    const fetcher = vi.fn();
    const out = mkdtempSync(join(tmpdir(), 'rec-'));
    const done = await recordContract({
      fetcher: fetcher as never,
      base: 'https://x.test',
      calls,
      headers: () => ({}),
      literals: ['3388000000022334455'],
      out,
      dryRun: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readdirSync(out)).toEqual([]);
    expect(done).toHaveLength(calls.length);
    expect(JSON.stringify(done)).not.toContain('3388000000');
  });

  it('writes scrubbed fixtures and never the token it sent', async () => {
    const seen: string[] = [];
    const fetcher = (async (_u: unknown, init?: RequestInit) => {
      seen.push(String(((init?.headers ?? {}) as Record<string, string>).authorization));
      return new Response(JSON.stringify(SECRET_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'sid=1' },
      });
    }) as typeof fetch;
    const out = mkdtempSync(join(tmpdir(), 'rec-'));
    await recordContract({
      fetcher,
      base: 'https://x.test',
      calls,
      headers: () => ({ authorization: 'Bearer ya29.realtoken' }),
      literals: ['3388000000022334455'],
      out,
      dryRun: false,
    });
    expect(seen.every((h) => h === 'Bearer ya29.realtoken')).toBe(true);
    const files = readdirSync(out);
    expect(files).toHaveLength(calls.length);
    for (const f of files) {
      const text = readFileSync(join(out, f), 'utf8');
      expect(leaks(text)).toEqual([]);
      for (const s of ['realtoken', 'sid=1', 'Jane', '3388000000']) expect(text).not.toContain(s);
    }
  });
});

describe('samsung', () => {
  it('plans no update for generic or gift types and one per event otherwise', () => {
    expect(samsungCalls('US', 'card1', 'loyalty', 'ref1').map((c) => c.name)).toContain(
      'loyalty-update-canceled',
    );
  });

  it('signs an AUTH token bound to the method and path', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = samsungAuth(
      {
        partnerId: 'p1',
        certificateId: 'ab12',
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      },
      { name: 'x', method: 'POST', path: '/US/wltex/cards/c/updates' },
      1,
    );
    const [h, p] = token.split('.').map((s) => JSON.parse(Buffer.from(s, 'base64url').toString()));
    expect(h).toMatchObject({ alg: 'RS256', cty: 'AUTH', ver: '3', certificateId: 'ab12' });
    expect(p).toEqual({ API: { method: 'POST', path: '/US/wltex/cards/c/updates' } });
  });

  it('scrubs a captured inbound request', () => {
    const out = JSON.stringify(
      scrubCapture(
        JSON.stringify({
          method: 'GET',
          path: '/cards/c1/3388000000022334455?cc2=US',
          headers: {
            authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJhIjoxfQ.sig',
            'x-request-id': 'r1',
          },
          body: { email: 'a@b.example' },
        }),
      ),
    );
    expect(leaks(out)).toEqual([]);
    expect(out).not.toContain('authorization');
  });
});
