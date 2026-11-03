import { describe, expect, it } from 'vitest';
import headersFile from '../../../public/_headers?raw';
import { EMAIL_BUDDY } from '../../shared/email-art.ts';
import { emailAssetUrl } from './buddy.ts';
import { EMAIL_LIGHT, FONT } from './shell.ts';
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

describe('seated buddy', () => {
  const top = (mood: string, scheme: string, d: number) =>
    `${BASE}/email/buddy-${mood}-${scheme}-top-${d}x.png`;

  it('is happy when a sign-in link is sent and curious when an address is confirmed', () => {
    expect(SIGN_IN_MOOD).toEqual({ sign_in: 'happy', verify_email: 'curious' });
    expect(buddyTag(signIn().html)).toContain(`src="${top('happy', 'light', 2)}"`);
    expect(buddyTag(verify().html)).toContain(`src="${top('curious', 'light', 2)}"`);
    expect(signIn().html).not.toContain('buddy-curious');
    expect(verify().html).not.toContain('buddy-happy');
  });

  it('is decorative, fixed-size, from PUBLIC_BASE_URL, with 3x and dark sources', () => {
    const tag = buddyTag(signIn().html) ?? '';
    expect(tag).toContain('alt=""');
    expect(tag).toContain('role="presentation"');
    expect(tag).toContain(`width="${EMAIL_BUDDY.width}" height="${EMAIL_BUDDY.seam}"`);
    expect(tag).toContain('border="0"');
    expect(tag).toContain(
      `srcset="${top('happy', 'light', 2)} 2x, ${top('happy', 'light', 3)} 3x"`,
    );
    expect(tag).not.toMatch(/transform|position:/);
    expect(signIn().html).toContain(
      `<picture><source srcset="${top('happy', 'dark', 2)} 2x, ${top('happy', 'dark', 3)} 3x" media="(prefers-color-scheme: dark)">`,
    );
  });

  it('sits on the card: its top in the band, its legs in the first card row over the foil', () => {
    const { html } = signIn();
    const at = html.indexOf('-top-2x.png');
    const legs = html.indexOf('-legs-2x.png');
    expect(html.indexOf('PassBook</td>')).toBeLessThan(at);
    expect(at).toBeLessThan(html.indexOf('class="e-card"'));
    expect(html.indexOf('class="e-seam"')).toBeLessThan(legs);
    expect(legs).toBeLessThan(html.indexOf('Sign in to PassBook</p>'));
    expect(legs).toBeLessThan(html.indexOf('class="e-btn"'));
    // Table cells only: the top on the band's bottom edge, the legs from the seam row's top.
    expect(html).toMatch(
      new RegExp(
        `<td valign="bottom" align="right" width="${EMAIL_BUDDY.width}" style="[^"]*vertical-align:bottom;font-size:0;line-height:0"><picture>`,
      ),
    );
    expect(html).toMatch(
      new RegExp(
        `<td class="e-seam" align="right" valign="top" style="height:${EMAIL_BUDDY.legs}px;[^"]*background-size:100% 2px;`,
      ),
    );
  });

  it('is left out without an absolute base URL: the band is the word alone', () => {
    const { html } = signIn({ base: '/relative' });
    expect(buddyTag(html)).toBeUndefined();
    expect(html).not.toContain('apple-touch-icon.png');
    expect(html).toContain('padding:14px 0 14px 25px');
  });

  it('is served cross-origin with a day of caching, under names without @', () => {
    const rule = headersFile.split(/\n\s*\n/).find((block) => block.startsWith('/email/*'));
    expect(rule).toContain('Cache-Control: public, max-age=86400');
    expect(rule).toContain('! Cross-Origin-Resource-Policy');
    expect(rule).toContain('Cross-Origin-Resource-Policy: cross-origin');
    expect(signIn().html).not.toMatch(/buddy-[^"]*(@|%40)/);
  });
});

describe('hosted card metrics', () => {
  const { html } = signIn();

  it('uses the SPA tokens: 18 px card, 24/600 title, 20 px wordmark, 14/500 buttons at 6 px', () => {
    expect(html).toContain('border-radius:18px;border-collapse:separate');
    expect(html).toMatch(
      /font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0\.015em;[^"]*">Sign in to PassBook/,
    );
    expect(html).toMatch(/font-size:20px;line-height:28px;font-weight:600;[^"]*">.*PassBook<\/td>/);
    expect(html).toMatch(
      /class="e-btn"[^>]*font-size:14px;line-height:20px;font-weight:500;padding:11px 24px;border-radius:6px/,
    );
  });

  it('draws a 2 px foil and a page-tone band in the light scheme', () => {
    expect(html).toContain(
      `background-image:linear-gradient(115deg,${EMAIL_LIGHT.foil1},${EMAIL_LIGHT.foil2} 55%,${EMAIL_LIGHT.foil3});background-size:100% 2px`,
    );
    expect(html).toContain(`class="e-page" style="background:${EMAIL_LIGHT.page}"`);
    expect(html).not.toContain('background:#060912;padding');
  });

  it('sets Rubik first, then its fallback and the system faces', () => {
    expect(FONT.startsWith("'Rubik', 'Rubik Fallback', ")).toBe(true);
    expect(html).toContain(`font-family:${FONT}`);
  });
});

describe('emailAssetUrl', () => {
  it('writes @ as %40, the URL static assets serve without a 307', () => {
    expect(emailAssetUrl('https://w.test', '/apple/badge/en/black@2x.png')).toBe(
      'https://w.test/apple/badge/en/black%402x.png',
    );
  });
});
