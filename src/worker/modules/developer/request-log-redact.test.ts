import { describe, expect, it } from 'vitest';
import { BODY_MAX_BYTES, redactBody, redactQuery } from './request-log-redact.ts';

const S = 'SENTINEL';
const redacted = (body: unknown, type = 'application/json') => {
  const text = JSON.stringify(body);
  return redactBody(text, type, text.length).text;
};

describe('redactBody keeps only what is known to be safe', () => {
  it('keeps ids, states, kinds, versions, times and counts, and blanks every other scalar', () => {
    const out = JSON.parse(
      redacted({
        id: 'p1',
        templateId: 'tpl_1',
        status: 'active',
        mode: 'test',
        version: 2,
        createdAt: 1700000000000,
        scopes: ['passes:read'],
        key: { passId: 'p2', unknown: 'visible?' },
        items: [{ id: 'a', label: 'visible?' }],
        flag: true,
      }),
    );
    expect(out).toMatchObject({
      id: 'p1',
      templateId: 'tpl_1',
      status: 'active',
      mode: 'test',
      version: 2,
      createdAt: 1700000000000,
      scopes: ['passes:read'],
    });
    expect(out.key).toEqual({ passId: 'p2', unknown: '[redacted]' });
    expect(out.items).toEqual([{ id: 'a', label: '[redacted]' }]);
    expect(out.flag).toBe('[redacted]');
  });

  it('blanks cursors and state, in bodies and in queries', () => {
    const out = JSON.parse(redacted({ items: [], nextCursor: 'Sm9obiBTbWl0aA', state: 'abc123' }));
    expect(out).toEqual({ items: [], nextCursor: '[redacted]', state: '[redacted]' });
    expect(redactQuery('?limit=5&cursor=Sm9obiBTbWl0aA&state=abc')).toBe(
      'limit=5&cursor=%5Bredacted%5D&state=%5Bredacted%5D',
    );
  });

  it('blanks the reviewer’s probes: names, notes, city, ip, pins, pairing codes, links, secrets', () => {
    const out = redacted({
      name: `${S}-name`,
      givenName: `${S}-given`,
      surname: `${S}-surname`,
      notes: `${S}-notes`,
      message: `${S}-message`,
      city: `${S}-city`,
      ip: `${S}-ip`,
      pin: `${S}-pin`,
      pairing: { code: `${S}-pair`, url: `https://x.test/scan#pair=${S}-hash` },
      whsecField: `whsec_${S}abc`,
      google: { saveUrl: `https://pay.google.com/gp/v/save/eyJ${S}.eyJ${S}b.sig${S}` },
      export: { link: `https://x.test/org-exports/1/download?exp=1&sig=${S}` },
      nfc: { url: `https://x.test/t/slug?p=${S}&m=${S}` },
      holderName: `${S}-holder`,
      email: `${S}@example.com`,
      secret: S,
      token: S,
      password: S,
      input: { level: `${S}-level` },
      externalId: `${S}-ext`,
      deviceId: `${S}-dev`,
    });
    expect(out).not.toContain(S);
  });

  it('keeps a problem answer readable: its code, title and detail, but a pairing code stays hidden', () => {
    const problem = JSON.parse(
      redacted({
        type: 'https://passbook.mobile/developers/errors/VALIDATION',
        title: 'Invalid',
        status: 422,
        code: 'VALIDATION',
        detail: 'templateId is required.',
        requestId: 'r1',
      }),
    );
    expect(problem).toMatchObject({
      code: 'VALIDATION',
      title: 'Invalid',
      detail: 'templateId is required.',
      status: 422,
      requestId: 'r1',
    });
    const pair = JSON.parse(redacted({ code: `${S}-123456`, expires: 1 }));
    expect(pair.code).toBe('[redacted]');
    expect(JSON.stringify(pair)).not.toContain(S);
  });

  it('scrubs capability shapes inside a safe string: links, JWTs, webhook secrets, signatures', () => {
    const out = redacted({
      detail: `see https://x.test/preview/abcdefghijklmnopqrstuv1234 or eyJabc.eyJdef.sigsig or whsec_abc123 or /d?exp=1&sig=${S} #pair=${S}`,
      title: 'x',
      status: 400,
    });
    expect(out).not.toContain(S);
    for (const leak of ['abcdefghijklmnopqrstuv', 'eyJabc', 'whsec_abc123'])
      expect(out, leak).not.toContain(leak);
  });

  it('keeps no text of a body that is not JSON, too large, or not parseable', () => {
    expect(redactBody(`a,b\n${S}`, 'text/csv; charset=utf-8', 10).text).toBe('[text/csv]');
    expect(redactBody('x', null, 1).text).toBe('[no type]');
    expect(redactBody(S, 'application/json', 17_000)).toEqual({
      text: '[json, too large to keep]',
      truncated: true,
    });
    expect(redactBody(`{"a":${S}`, 'application/json', 12).text).not.toContain(S);
  });

  it('cuts a long body and is bounded in depth', () => {
    const long = redactBody(
      JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ i, id: 'x'.repeat(400) })) }),
      'application/json',
      16_000,
    );
    expect(new TextEncoder().encode(long.text).length).toBeLessThanOrEqual(BODY_MAX_BYTES + 20);
    expect(long.truncated).toBe(true);
    expect(long.text).toMatch(/…\[truncated\]$/);
    expect(redactBody('{"id":"a"}', 'application/json', 10).truncated).toBe(false);
    expect(redacted({ a: { b: { c: { d: { e: { f: { g: S } } } } } } })).not.toContain(S);
  });
});

describe('free-form maps are blanked whole', () => {
  it('stores nothing of input, data, config, rows, metadata or their keys', () => {
    const out = redacted({
      id: 'p1',
      input: {
        customerId: `${S}-C-998877`,
        studentId: `${S}-S-1`,
        birthdayAt: 315532800000,
        visitCount: 4,
        [`ada${S}@x.com`]: { patientId: `${S}-P` },
      },
      data: { accountId: `${S}-acct` },
      config: { clientId: `${S}-client`, accountId: `${S}-a` },
      rows: [{ patientId: `${S}-row` }],
      metadata: { loyaltyCardId: `${S}-card` },
      personalization: { visitCount: 3 },
      [`user-${S}@example.com`]: { id: 'x' },
    });
    expect(out).not.toContain(S);
    expect(out).not.toContain('998877');
    expect(JSON.parse(out)).toMatchObject({ id: 'p1', input: '[redacted]', config: '[redacted]' });
  });

  it('keeps no value under a key that is not on the list, at any depth', () => {
    const out = redacted({
      customerId: `${S}-c`,
      studentId: `${S}-s`,
      dobAt: 315532800000,
      ticketVersion: 7,
      Input: { id: `${S}-i`, memberId: `${S}-m` },
      inputs: [{ passId: `${S}-p`, createdAt: 9 }],
      overrides: { templateId: `${S}-t`, status: `${S}-st` },
      scope: { orgId: `${S}-o`, name: `${S}-n` },
      meta: { holderId: `${S}-h`, 'Ada Lovelace': 1 },
      id: 'ok',
    });
    expect(out).not.toContain(S);
    expect(out).not.toContain('Ada');
    expect(out).not.toContain('315532800000');
    expect(JSON.parse(out)).toMatchObject({ id: 'ok', Input: '[redacted]', scope: '[redacted]' });
  });

  it('keeps the platform’s own top-level ids and times', () => {
    expect(JSON.parse(redacted({ passId: 'p', createdAt: 5, usedCount: 2 }))).toEqual({
      passId: 'p',
      createdAt: 5,
      usedCount: 2,
    });
  });
});

describe('redactQuery', () => {
  it('blanks the values of any parameter that is not one of the platform’s own filters', () => {
    const q = redactQuery(`?customerId=${S}-C-9&cardId=${S}&limit=5&passId=p1&externalId=${S}`);
    expect(q).not.toContain(S);
    expect(q).toContain('limit=5');
    expect(q).toContain('passId=p1');
  });

  it('keeps the value of a known-safe parameter and blanks every other', () => {
    const q = redactQuery(
      `?limit=20&status=active&email=ada@example.com&token=${S}&key=${S}&holderName=${S}&sig=${S}&p=${S}&pin=${S}&name=${S}&templateId=t1`,
    );
    expect(q).not.toContain(S);
    expect(q).not.toContain('ada%40example.com');
    for (const kept of ['limit=20', 'status=active', 'templateId=t1']) expect(q).toContain(kept);
    expect(redactQuery('')).toBeNull();
    expect(redactQuery('?')).toBeNull();
  });
});
