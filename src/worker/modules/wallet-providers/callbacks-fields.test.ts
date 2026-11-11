import { describe, expect, it } from 'vitest';
import { readSamsungCallbackBody, SAMSUNG_CALLBACK_BODY_LIMIT } from './callbacks-body.ts';
import {
  filterSamsungCardFields,
  samsungCountryHint,
  samsungRequestedFields,
} from './callbacks-fields.ts';
import type { SamsungCardProjection } from './samsung.ts';

const projection: SamsungCardProjection = {
  card: {
    type: 'loyalty',
    subType: 'others',
    data: [
      {
        refId: 'A'.repeat(32),
        createdAt: 1,
        updatedAt: 2,
        state: 'ACTIVE',
        language: 'en',
        attributes: { title: 'Private member', providerName: 'Issuer', 'barcode.value': 'secret' },
      },
    ],
  },
};

describe('Samsung request boundaries', () => {
  it('only narrows approved attributes and retains required card metadata', () => {
    const fields = samsungRequestedFields(
      new URL('https://example.test/cards/a/b?fields=title,barcode.value'),
    );
    const result = filterSamsungCardFields(projection, fields);
    expect(result.card.data[0]).toMatchObject({
      refId: 'A'.repeat(32),
      state: 'ACTIVE',
      language: 'en',
      attributes: { title: 'Private member', 'barcode.value': 'secret' },
    });
    expect(result.card.data[0]?.attributes).not.toHaveProperty('providerName');
    expect(projection.card.data[0]?.attributes).toHaveProperty('providerName');
    expect(() => filterSamsungCardFields(projection, ['notApproved'])).toThrow();
  });

  it('rejects malformed, duplicated, oversized and unsupported selectors', () => {
    for (const query of [
      '?fields=',
      '?fields=title&fields=title',
      '?fields=title,title',
      '?fields=title%2Fsecret',
      '?select=title',
      `?fields=${'x'.repeat(129)}`,
    ]) {
      expect(() =>
        samsungRequestedFields(new URL(`https://example.test/cards/a/b${query}`)),
      ).toThrow();
    }
    expect(samsungRequestedFields(new URL('https://example.test/cards/a/b'))).toBeNull();
  });

  it('keeps country as a bounded untrusted fixed-host hint', () => {
    expect(samsungCountryHint(new URL('https://example.test/?event=ADDED&cc2=gb'))).toBe('GB');
    for (const query of ['', '?cc2=gb&cc2=us', '?cc2=gb%2F..', '?cc2=USA', '?cc2=1A']) {
      expect(samsungCountryHint(new URL(`https://example.test/${query}`))).toBeNull();
    }
  });

  it('counts actual bytes rather than trusting an understated Content-Length', async () => {
    const body = new Uint8Array(SAMSUNG_CALLBACK_BODY_LIMIT + 1);
    const request = new Request('https://example.test/', {
      method: 'POST',
      headers: { 'content-length': '1' },
      body,
    });
    await expect(readSamsungCallbackBody(request)).rejects.toMatchObject({ status: 413 });
    const small = new Request('https://example.test/', {
      method: 'POST',
      body: 'untrusted callback',
    });
    expect(new TextDecoder().decode(await readSamsungCallbackBody(small))).toBe(
      'untrusted callback',
    );
  });
});
