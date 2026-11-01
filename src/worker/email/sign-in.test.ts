import { describe, expect, it } from 'vitest';
import { renderSignInEmail } from './sign-in.ts';

describe('renderSignInEmail', () => {
  it('includes link and code in both parts for sign-in', () => {
    const mail = renderSignInEmail({
      purpose: 'sign_in',
      link: 'https://wallet.test/auth/magic?t=abc',
      code: '123456',
      expiresMinutes: 15,
    });
    expect(mail.subject).toBe('Your sign-in link');
    expect(mail.text).toContain('https://wallet.test/auth/magic?t=abc');
    expect(mail.text).toContain('123456');
    expect(mail.html).toContain('123456');
    expect(mail.html).toContain('lang="en"');
  });

  it('uses the shared fluid shell with a title and color-scheme meta', () => {
    const mail = renderSignInEmail({
      purpose: 'sign_in',
      link: 'https://wallet.test/auth/magic?t=abc',
      code: '123456',
      expiresMinutes: 15,
    });
    expect(mail.html).toContain('max-width:480px');
    expect(mail.html).not.toContain('width="420"');
    expect(mail.html).toContain('Sign in to Wallet');
    expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(mail.html).toContain('prefers-color-scheme:dark');
  });

  it('omits the code for email verification', () => {
    const mail = renderSignInEmail({
      purpose: 'verify_email',
      link: 'https://wallet.test/auth/magic?t=abc',
      expiresMinutes: 15,
    });
    expect(mail.subject).toBe('Confirm your email');
    expect(mail.text).not.toContain('Code');
    expect(mail.html).not.toContain('Code');
  });

  it('escapes the link in HTML', () => {
    const mail = renderSignInEmail({
      purpose: 'sign_in',
      link: 'https://wallet.test/?a="><script>',
      code: '000000',
      expiresMinutes: 15,
    });
    expect(mail.html).not.toContain('<script>');
  });

  it('names the requesting account for verification', () => {
    const mail = renderSignInEmail({
      purpose: 'verify_email',
      link: 'https://wallet.test/auth/magic?t=abc',
      expiresMinutes: 15,
      requester: 'me@example.test',
    });
    expect(mail.text).toContain('account of me@example.test');
    expect(mail.html).toContain('account of me@example.test');
  });
});
