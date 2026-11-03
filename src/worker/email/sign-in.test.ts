import { describe, expect, it } from 'vitest';
import headersFile from '../../../public/_headers?raw';
import { EMAIL_BUDDY } from './buddy.ts';
import { renderSignInEmail, SIGN_IN_MOOD, type SignInEmailInput } from './sign-in.ts';

const BASE = 'https://wallet.test';
const signIn = (over: Partial<SignInEmailInput> = {}) =>
  renderSignInEmail({
    purpose: 'sign_in',
    link: `${BASE}/auth/magic?t=abc`,
    base: BASE,
    code: '123456',
    expiresMinutes: 15,
    ...over,
  });
const verify = (over: Partial<SignInEmailInput> = {}) =>
  signIn({ purpose: 'verify_email', code: undefined, requester: 'me@example.test', ...over });

/** The buddy's <img> tag, or undefined. */
const buddyTag = (html: string) => /<img [^>]*src="[^"]*\/email\/buddy-[^>]*>/.exec(html)?.[0];

describe('renderSignInEmail', () => {
  it('includes link and code in both parts for sign-in', () => {
    const mail = signIn();
    expect(mail.subject).toBe('Your sign-in link');
    expect(mail.text).toContain('https://wallet.test/auth/magic?t=abc');
    expect(mail.text).toContain('123456');
    expect(mail.html).toContain('123456');
    expect(mail.html).toContain('lang="en"');
  });

  it('uses the shared fluid shell with a title and color-scheme meta', () => {
    const mail = signIn();
    expect(mail.html).toContain('max-width:480px');
    expect(mail.html).not.toContain('width="420"');
    expect(mail.html).toContain('Sign in to PassBook');
    expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(mail.html).toContain('prefers-color-scheme:dark');
  });

  it('omits the code for email verification', () => {
    const mail = verify({ requester: undefined });
    expect(mail.subject).toBe('Confirm your email');
    expect(mail.text).not.toContain('Code');
    expect(mail.html).not.toContain('Code');
  });

  it('escapes the link in HTML', () => {
    const mail = signIn({ link: 'https://wallet.test/?a="><script>', code: '000000' });
    expect(mail.html).not.toContain('<script>');
  });

  it('names the requesting account for verification', () => {
    const mail = verify();
    expect(mail.text).toContain('account of me@example.test');
    expect(mail.html).toContain('account of me@example.test');
  });

  it('keeps the plain-text parts word for word', () => {
    expect(signIn().text).toBe(
      'Sign in to PassBook\n\nSign in: https://wallet.test/auth/magic?t=abc\n\nCode: 123456\n\nExpires in 15 minutes. Ignore this email if you did not ask for it.',
    );
    expect(verify().text).toBe(
      'Confirm your email\n\nAdds this address to the account of me@example.test.\n\nConfirm email: https://wallet.test/auth/magic?t=abc\n\nExpires in 15 minutes. Ignore this email if you did not ask for it.',
    );
  });
});

describe('header buddy', () => {
  it('is happy when a sign-in link is sent and curious when an address is confirmed', () => {
    expect(SIGN_IN_MOOD).toEqual({ sign_in: 'happy', verify_email: 'curious' });
    expect(buddyTag(signIn().html)).toContain(`src="${BASE}/email/buddy-happy@2x.png"`);
    expect(buddyTag(verify().html)).toContain(`src="${BASE}/email/buddy-curious@2x.png"`);
    expect(signIn().html).not.toContain('buddy-curious');
    expect(verify().html).not.toContain('buddy-happy');
  });

  it('is a decorative, fixed-size image from PUBLIC_BASE_URL with a 3x source', () => {
    const tag = buddyTag(signIn().html) ?? '';
    expect(tag).toContain('alt=""');
    expect(tag).toContain('role="presentation"');
    expect(tag).toContain(`width="${EMAIL_BUDDY.width}" height="${EMAIL_BUDDY.height}"`);
    expect(tag).toContain('border="0"');
    expect(tag).toContain(
      `style="display:block;width:${EMAIL_BUDDY.width}px;height:${EMAIL_BUDDY.height}px;`,
    );
    expect(tag).toContain(
      `srcset="${BASE}/email/buddy-happy@2x.png 2x, ${BASE}/email/buddy-happy@3x.png 3x"`,
    );
    expect(tag).not.toMatch(/transform|position:/);
  });

  it('stands at the header right, after the wordmark and before the title, button and code', () => {
    const { html } = signIn();
    const at = html.indexOf('/email/buddy-');
    expect(html.indexOf('PassBook</td>')).toBeLessThan(at);
    expect(at).toBeLessThan(html.indexOf('Sign in to PassBook</p>'));
    expect(at).toBeLessThan(html.indexOf('class="e-btn"'));
    expect(at).toBeLessThan(html.indexOf('class="e-chip'));
    // A table cell of fixed width with the image on its bottom edge: no absolute positioning.
    expect(html).toMatch(
      new RegExp(
        `<td valign="bottom" align="right" width="${EMAIL_BUDDY.width}" style="[^"]*vertical-align:bottom;font-size:0;line-height:0"><img [^>]*buddy-happy`,
      ),
    );
  });

  it('is left out without an absolute base URL', () => {
    const { html } = signIn({ base: '/relative' });
    expect(buddyTag(html)).toBeUndefined();
    expect(html).not.toContain('apple-touch-icon.png');
    expect(html).toContain('padding:20px 24px;color:#ffffff');
  });

  it('is served cross-origin with a day of caching', () => {
    const rule = headersFile.split(/\n\s*\n/).find((block) => block.startsWith('/email/*'));
    expect(rule).toContain('Cache-Control: public, max-age=86400');
    expect(rule).toContain('! Cross-Origin-Resource-Policy');
    expect(rule).toContain('Cross-Origin-Resource-Policy: cross-origin');
  });
});
