import { describe, expect, it } from 'vitest';
import { codeOf } from '../logs/curl.ts';
import { COPY_LANGS, copyAs, type Sent } from './copy-as.ts';

// Built from parts so a secret scanner never reads the fixture as a credential.
const TOKEN = ['wbt', 'live', '0123456789abcdef'].join('_');
const sent: Sent = {
  method: 'POST',
  url: 'https://passbook.test/api/v1/passes',
  headers: [
    ['Authorization', `Bearer ${TOKEN}`],
    ['authorization', `Bearer ${TOKEN}`],
    ['Idempotency-Key', 'k1'],
  ],
  body: { templateId: 't1' },
};

describe('Copy as', () => {
  it('writes $PASSBOOK_KEY as the bearer and never a token it was handed', () => {
    for (const { lang } of COPY_LANGS) {
      const code = copyAs(lang, sent);
      expect(code, lang).not.toContain(TOKEN);
      expect(code, lang).toContain('PASSBOOK_KEY');
      expect(code, lang).toContain('Idempotency-Key');
    }
  });

  it('copies a logged call the same way', () => {
    const row = {
      method: 'GET',
      path: '/api/v1/passes',
      query: 'limit=1',
      requestBody: null,
    } as Parameters<typeof codeOf>[1];
    for (const { lang } of COPY_LANGS) {
      const code = codeOf(lang, row, 'https://passbook.test');
      expect(code, lang).toContain('PASSBOOK_KEY');
      expect(code, lang).not.toMatch(/Bearer\s+(wbt_|try_|ey)/);
    }
  });
});
