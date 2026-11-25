import { describe, expect, it } from 'vitest';
import { masker } from './probe-mask.ts';
import { decodeToken, encodeToken, idHash } from './probe-token.ts';

describe('masker', () => {
  const m = masker({ token: 'sekret', username: 'svc', password: 'pw/1' }, 'api_key');

  it('masks the raw value, Bearer, URL-encoded and base64 forms, in strings, keys and numbers', () => {
    const out = JSON.stringify(
      m.json({
        a: 'Bearer sekret',
        sekret: 'key',
        b: [btoa('svc:pw/1'), encodeURIComponent('pw/1'), 'safe'],
        c: { d: 'x sekret y sekret' },
      }),
    );
    expect(out).not.toMatch(/sekret|pw|c3Zj|pw%2F1/);
    expect(out).toContain('safe');
    expect(masker({ queryValue: '12345' }).json({ n: 12345, m: 1 })).toEqual({ n: '***', m: 1 });
  });

  it('masks the credential query parameter by name and the value anywhere in a URL', () => {
    expect(m.url('https://x.test/a?api_key=zzz&q=1')).toBe('https://x.test/a?api_key=***&q=1');
    expect(m.url('https://x.test/a?other=sekret')).toBe('https://x.test/a?other=***');
  });

  it('shows only allow-listed headers, lower-cased', () => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Set-Cookie': 'a=b',
      Authorization: 'x',
      'X-Next-Page': '2',
      'RateLimit-Remaining': '5',
      'X-Custom-Total': '9',
      Link: '<https://x.test/?k=sekret>; rel="next"',
    });
    expect(m.headers(headers, ['X-Custom-Total'])).toEqual({
      'content-type': 'application/json',
      'x-next-page': '2',
      'ratelimit-remaining': '5',
      'x-custom-total': '9',
      link: '<https://x.test/?k=***>; rel="next"',
    });
  });

  it('with no secrets it changes nothing', () => {
    expect(masker(undefined).json({ a: 'b' })).toEqual({ a: 'b' });
  });
});

describe('probe token', () => {
  it('round-trips and rejects what it did not issue', () => {
    const token = { p: { n: 2, k: 1 }, k: 1, n: 2, ids: ['a1', 'b2'] };
    expect(decodeToken(encodeToken(token))).toEqual(token);
    for (const bad of ['', 'x', 'p1.', 'p1.!!!', `p1.${btoa('{"k":-1,"n":0,"ids":[]}')}`]) {
      expect(decodeToken(bad)).toBeNull();
    }
  });

  it('shrinks the ID list to fit 4 KB', () => {
    const ids = Array.from({ length: 200 }, (_, i) => idHash(`record-${i}`) ?? '');
    const out = encodeToken({ p: { u: `/v1/m?${'q'.repeat(2500)}` }, k: 1, n: 1000, ids });
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(decodeToken(out)?.ids.length).toBeLessThan(200);
  });

  it('hashes strings and numbers the same way and ignores the rest', () => {
    expect(idHash(5)).toBe(idHash('5'));
    expect(idHash(null)).toBeNull();
    expect(idHash('')).toBeNull();
  });
});
