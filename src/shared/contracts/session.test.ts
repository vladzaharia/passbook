import { describe, expect, it } from 'vitest';
import { MagicLinkRequestSchema } from './session.ts';

const base = { email: 'sam@example.com', turnstileToken: 'tok' };

describe('MagicLinkRequestSchema prefer', () => {
  it('is optional: absent means the email leads with the link', () => {
    expect(MagicLinkRequestSchema.parse(base)).toEqual(base);
  });

  it('takes link or code', () => {
    expect(MagicLinkRequestSchema.parse({ ...base, prefer: 'code' }).prefer).toBe('code');
    expect(MagicLinkRequestSchema.parse({ ...base, prefer: 'link' }).prefer).toBe('link');
  });

  it('refuses anything else', () => {
    for (const prefer of ['sms', 'Code', '', null, 1, ['code']]) {
      expect(MagicLinkRequestSchema.safeParse({ ...base, prefer }).success).toBe(false);
    }
  });
});
