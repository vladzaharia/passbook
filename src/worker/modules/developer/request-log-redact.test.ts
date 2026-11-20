import { describe, expect, it } from 'vitest';
import { BODY_MAX_CHARS, redactBody, redactQuery } from './request-log-redact.ts';

const S = 'SENTINEL';
const redacted = (body: unknown, type = 'application/json') => {
  const text = JSON.stringify(body);
  return redactBody(text, type, text.length);
};

describe('redactBody', () => {
  it('blanks secrets, keys, tokens and passwords by key, as the logger does', () => {
    const out = redacted({
      secret: S,
      apiKey: S,
      token: S,
      password: S,
      authorization: S,
      pushToken: S,
      csrfSecret: S,
      nested: { client_secret: S, list: [{ bearer: S }] },
      keep: 'visible',
    });
    expect(out).not.toContain(S);
    expect(out).toContain('visible');
  });

  it('blanks personal data: holder fields, names, contact details, ids of a person and pass inputs', () => {
    const out = redacted({
      holderName: S,
      memberName: S,
      email: `${S}@example.com`,
      firstName: S,
      phone: S,
      address: S,
      dateOfBirth: S,
      passportNumber: S,
      photoUrl: S,
      deviceId: S,
      externalId: S,
      personalization: { a: S },
      input: { level: S, nested: { seat: S }, tags: [S] },
      fields: [{ value: S }],
      templateId: 'tpl_1',
    });
    expect(out).not.toContain(S);
    // The shape of an input stays, so a bad field is still debuggable.
    expect(out).toContain('"level":"[redacted]"');
    expect(out).toContain('"seat":"[redacted]"');
    expect(out).toContain('tpl_1');
  });

  it('blanks secrets that sit inside values: emails, capability links, key shapes, PEM and bearer text', () => {
    const out = redacted({
      note: 'mail ada@example.com now',
      previewUrl: 'https://passbook.mobile/preview/abcdefghijklmnopqrstuv1234567890',
      link: 'https://passbook.mobile/p/abcdefghijklmnopqrstuv1234567890?t=abc',
      shown: 'pb_test_abcdefgh_zzzzzzzzzzzzzzzzzzzz',
      pem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
      header: 'Bearer abc.def.ghi',
      tryToken: 'pbtry_abc.def',
    });
    for (const leak of ['ada@example.com', 'abcdefghijklmnopqrstuv', 'zzzzzzzz', 'AAAA', 'abc.def'])
      expect(out, leak).not.toContain(leak);
  });

  it('keeps no text of a body that is not JSON, too large, or not parseable', () => {
    expect(redactBody(`a,b\n${S}`, 'text/csv; charset=utf-8', 10)).toBe('[text/csv]');
    expect(redactBody('x', null, 1)).toBe('[no type]');
    expect(redactBody(S, 'application/json', 70_000)).toBe('[json, too large to keep]');
    expect(redactBody(`{"a":${S}`, 'application/json', 12)).not.toContain(S);
  });

  it('cuts a long body and is bounded in depth', () => {
    const long = redactBody(
      JSON.stringify({
        rows: Array.from({ length: 50 }, (_, i) => ({ i, text: 'x'.repeat(1500) })),
      }),
      'application/json',
      60_000,
    );
    expect(long.length).toBeLessThanOrEqual(BODY_MAX_CHARS + 20);
    expect(long).toMatch(/…\[truncated\]$/);
    const deep = redacted({ a: { b: { c: { d: { e: { f: { g: S } } } } } } });
    expect(deep).not.toContain(S);
  });
});

describe('redactQuery', () => {
  it('blanks values that could be a secret or a person, keeps the rest', () => {
    const q = redactQuery(
      `?limit=20&email=ada@example.com&token=${S}&key=${S}&holderName=${S}&status=active`,
    );
    expect(q).not.toContain(S);
    expect(q).not.toContain('ada%40example.com');
    expect(q).toContain('limit=20');
    expect(q).toContain('status=active');
    expect(redactQuery('')).toBeNull();
    expect(redactQuery('?')).toBeNull();
  });
});
