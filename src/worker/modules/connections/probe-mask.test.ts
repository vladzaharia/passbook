import { describe, expect, it } from 'vitest';
import { prune } from '../../../shared/rest/prune.ts';
import { masker } from './probe-mask.ts';
import { decodeToken, encodeToken, idHash, type TokenKit } from './probe-token.ts';

const kit = (bind = 'org|conn|https://x.test|/v1'): TokenKit => ({
  bind,
  mac: async (v) => {
    const bytes = new TextEncoder().encode(`k${v}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  },
});

describe('masker', () => {
  const secret = 'sk/Live+Ab~c(1)!==';
  const m = masker(
    { token: secret, queryValue: secret, username: 'svc', password: 'pw/1' },
    'api_key',
  );
  const hex = (s: string) => Buffer.from(s).toString('hex');
  const forms: Record<string, string> = {
    raw: secret,
    'url component': encodeURIComponent(secret),
    'search params (the connector writes this)': new URLSearchParams({ v: secret })
      .toString()
      .slice(2),
    'lower-case percent': encodeURIComponent(secret).toLowerCase(),
    'json escaped slash': secret.replace('/', '\\/'),
    base64: Buffer.from(secret).toString('base64'),
    base64url: Buffer.from(secret).toString('base64url'),
    'base64 of Bearer': Buffer.from(`Bearer ${secret}`).toString('base64'),
    hex: hex(secret),
    'upper-case hex': hex(secret).toUpperCase(),
    'basic user:pass': Buffer.from('svc:pw/1').toString('base64'),
  };
  for (const [name, form] of Object.entries(forms)) {
    it(`masks ${name}`, () => {
      const out = JSON.stringify(prune({ a: `x ${form} y`, [form]: 1 }, undefined, m.text).value);
      expect(out).not.toContain(form);
      expect(out).toContain('***');
    });
  }

  it('masks a credential with ~ ! or a space echoed in a next link', () => {
    const spaced = masker({ queryValue: 'a key with spaces ~!' }, 'k');
    const link = `https://api.x/items?page=2&k=${new URLSearchParams({ k: 'a key with spaces ~!' }).toString().slice(2)}`;
    expect(spaced.text(link)).not.toMatch(/spaces|%7E|%21|\+key/);
  });

  it('masks the credential query parameter by name and the value anywhere in a URL', () => {
    expect(m.url('https://x.test/a?api_key=zzz&q=1')).toBe('https://x.test/a?api_key=***&q=1');
    expect(m.url(`https://x.test/a?other=${encodeURIComponent(secret)}`)).toBe(
      'https://x.test/a?other=***',
    );
  });

  it('shows only allow-listed headers, masked, and a configured header only as a number', () => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Set-Cookie': 'a=b',
      Authorization: 'x',
      'X-Next-Page': '2',
      'RateLimit-Remaining': '5',
      'X-Custom-Total': '9',
      'X-Other': '9',
      Link: `<https://x.test/?k=${encodeURIComponent(secret)}>; rel="next"`,
    });
    expect(m.headers(headers, ['X-Custom-Total'])).toEqual({
      'content-type': 'application/json',
      'x-next-page': '2',
      'ratelimit-remaining': '5',
      'x-custom-total': '9',
      link: '<https://x.test/?k=***>; rel="next"',
    });
    expect(m.headers(new Headers({ 'X-Custom-Total': 'abc-token' }), ['x-custom-total'])).toEqual(
      {},
    );
  });

  it('masks a header name that carries a credential', () => {
    const out = m.headers(new Headers({ [`x-next-${hex(secret)}`]: '1' }));
    expect(Object.keys(out)[0]).toBe('x-next-***');
  });

  it('a short secret is masked only as a whole value, never inside other text', () => {
    const short = masker({ username: 'svc', password: 'pw' });
    expect(short.text('svc')).toBe('***');
    expect(short.text('a svc pw b')).toBe('a svc pw b');
  });

  it('with no secrets it changes nothing', () => {
    expect(masker(undefined).text('b')).toBe('b');
  });
});

describe('probe token', () => {
  it('round-trips for the same binding and refuses anything else', async () => {
    const token = { p: { n: 2, k: 1 }, k: 1, n: 2, ids: ['a1', 'b2'] };
    const out = await encodeToken(token, kit());
    expect(await decodeToken(out, kit())).toEqual(token);
    expect(await decodeToken(out, kit('org|other|https://x.test|/v1'))).toBeNull();
    expect(await decodeToken(out, kit('org2|conn|https://x.test|/v1'))).toBeNull();
    expect(await decodeToken(out, kit('org|conn|https://y.test|/v1'))).toBeNull();
    const [head, body] = out.split('.');
    expect(await decodeToken(`${head}.${body}.${'0'.repeat(32)}`, kit())).toBeNull();
    for (const bad of ['', 'x', 'p2.', 'p2.!!!', 'p2.a.b.c', `p1.${body}`]) {
      expect(await decodeToken(bad, kit())).toBeNull();
    }
  });

  it('shrinks the ID list to fit 4 KB', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => idHash(`record-${i}`) ?? '');
    const out = await encodeToken(
      { p: { u: `/v1/m?${'q'.repeat(2500)}` }, k: 1, n: 1000, ids },
      kit(),
    );
    expect(out.length).toBeLessThanOrEqual(4096);
    expect((await decodeToken(out, kit()))?.ids.length).toBeLessThan(200);
  });

  it('hashes strings and numbers the same way and ignores the rest', () => {
    expect(idHash(5)).toBe(idHash('5'));
    expect(idHash(null)).toBeNull();
    expect(idHash('')).toBeNull();
  });
});
