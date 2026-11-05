import { describe, expect, it } from 'vitest';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import type { SignInErrorCode } from '../../shared/copy/sign-in.ts';
import {
  breakglassPage,
  confirmPage,
  expiredPage,
  noAccessPage,
  oidcFailurePage,
  signInErrorPage,
  verifyPage,
} from '../modules/auth/pages.ts';
import { contentSecurityPolicy } from '../platform/security-headers.ts';
import { renderErrorPage } from './error-page.tsx';
import { HOSTED_CSS, REPLAY_SCRIPT } from './hosted.ts';
import { HOSTED_ART_CSS } from './hosted-art.tsx';
import { renderNotFoundPage } from './pass-page.tsx';
import { THEME_CSS, WORDMARK_CSS } from './theme.ts';

const NONCE = 'n0nce';
const TOKEN = 't'.repeat(20);
/** The only script a hosted page loads: same-origin, never inline. */
const scripts = (html: string) => html.match(/<script[^>]*>[\s\S]*?<\/script>/g) ?? [];
const primaries = (html: string) => html.match(/class="btn"/g)?.length ?? 0;
const mood = (html: string) => /data-part="w"[^>]*data-mood="([a-z]+)"/.exec(html)?.[1];
const refusal = (code: SignInErrorCode) => signInErrorPage(NONCE, code).html;
/** The acted buddy's scene and prop, as state-art.test.tsx reads the app's. */
const act = (html: string) => ({
  scene: /data-buddy=""[^>]*data-scene="([a-z]+)"/.exec(html)?.[1],
  prop: /<span class="wl-buddy-prop"><svg[^>]*data-art="([a-z-]+)"/.exec(html)?.[1] ?? null,
});
/** An outline link-button: its href and label (after any icon). */
const outline = (html: string) =>
  [...html.matchAll(/<a class="btn outline" href="([^"]*)">(?:<svg.*?<\/svg>)?([^<]*)<\/a>/g)].map(
    (m) => [m[1], m[2]],
  );

describe('hosted auth pages', () => {
  it.each([
    ['confirm', confirmPage(NONCE, { token: TOKEN, email: 'ada@example.com' }), 1],
    ['expired', expiredPage(NONCE), 0],
    ['no-access', noAccessPage(NONCE), 1],
    ['break-glass', breakglassPage(NONCE, {}), 1],
  ])('renders the %s card with its own art and no inline script', (state, html, primary) => {
    expect(html).toContain(`<section class="card" data-state="${state}">`);
    // At L; the band wallet keeps the idle beat (B11), an acting buddy gives it to its scene.
    const wallet = state === 'no-access' ? 'login' : state;
    expect(html).toContain(`data-art="wallet" data-size="xl" data-state="${wallet}"`);
    expect(html.includes('data-beat="off"')).toBe(state === 'no-access');
    expect(html).toContain(`<style nonce="${NONCE}">`);
    expect(scripts(html)).toEqual([REPLAY_SCRIPT]);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toContain('theme-toggle');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('rel="apple-touch-icon"');
    // Primary moves the flow on; a way back is outline, as in the app.
    expect(primaries(html)).toBe(primary);
  });

  it.each([
    ['confirm', confirmPage(NONCE, { token: TOKEN, email: 'a@b.co' }), ['ck']],
    ['expired', expiredPage(NONCE), []],
    ['break-glass', breakglassPage(NONCE, {}), ['key', 'kt']],
    ['rate limit', renderErrorPage({ status: 429, nonce: NONCE }), ['hg']],
  ])('gives %s its own beat on the fanned wallet', (_state, html, parts) => {
    expect(html.match(/data-part="c[123]"/g)).toHaveLength(3);
    expect(html).toContain('data-fan=""');
    expect(html).toContain('data-look=""');
    for (const part of parts) expect(html).toContain(`data-part="${part}"`);
    if (_state === 'expired') expect(html).toContain('class="dim"');
  });

  it('sizes the scene like /login and wears the kit controls', () => {
    expect(HOSTED_CSS).toContain(HOSTED_ART_CSS);
    expect(HOSTED_CSS).toContain(
      '.scene{position:relative;z-index:2;flex:none;width:128px;height:96px',
    );
    // The controls themselves (16 px fields on touch) are generated: tools/ssr-parity.test.ts.
    expect(HOSTED_CSS.startsWith(THEME_CSS)).toBe(true);
  });

  it('wears the console mark and its sheet (brand-mark.test.ts), never the hello', () => {
    // Raw CSS imports are empty under test; the sheet is checked from the file.
    expect(HOSTED_CSS).toContain(WORDMARK_CSS);
    const html = expiredPage(NONCE);
    expect(html).toContain('<a class="mark" href="/"><svg viewBox="0 0 20 20" class="wl-mark"');
    expect(html.match(/data-p="[123]"/g)).toHaveLength(3);
    expect(html).not.toContain('data-hello');
  });

  it('seats the wallet on the card: above it, legs over the edge, a contact shadow', () => {
    // The base (y 66 of 72) meets the card's top edge: 8 px at 128×96, 7 px at 112×84.
    expect(HOSTED_CSS).toMatch(/\.scene\{[^}]*margin-bottom:-8px;pointer-events:none\}/);
    expect(HOSTED_CSS).toMatch(/\.scene\{margin-bottom:-7px\}/);
    expect(HOSTED_CSS).toMatch(/\.card\{position:relative;z-index:1;/);
    const html = noAccessPage(NONCE);
    expect(html).toMatch(/data-part="w"[^>]*data-seat=""/);
    for (const part of ['l1', 'l2', 'sd']) expect(html).toContain(`data-part="${part}"`);
  });

  it('puts the wordmark left and the wallet right in one band, then the card', () => {
    const html = expiredPage(NONCE);
    expect(html).toMatch(
      /<main class="hosted"><div class="band"><div class="brand"><a class="mark" href="\/"><svg viewBox="0 0 20 20" class="wl-mark" aria-hidden="true">.*?<\/svg>PassBook<\/a><\/div><div class="scene" aria-hidden="true"><span data-replay="" data-scene="hello"><svg[^>]*data-art="wallet"/,
    );
    expect(html).toMatch(/<\/svg><\/span><\/div><\/div><section class="card"/);
    expect(HOSTED_CSS).toContain('.band .mark{gap:.625rem;font-size:1.25rem;line-height:1.75rem;');
    expect(HOSTED_CSS).toContain('.band .mark>svg{width:1.5rem;height:1.5rem}');
  });

  it('keeps the wallet calm when the holder cancelled sign-in', () => {
    expect(mood(oidcFailurePage(NONCE, 'cancelled', null))).toBeUndefined();
  });

  it.each([
    ['no access', noAccessPage(NONCE)],
    ['an expired or used link', expiredPage(NONCE)],
    ['unverified sign-in', oidcFailurePage(NONCE, 'unverified', null)],
    ['provider unavailable', oidcFailurePage(NONCE, 'unavailable', null)],
    ['an email conflict', refusal('EMAIL_CONFLICT')],
    ['an email taken', refusal('EMAIL_TAKEN')],
    ['no email', refusal('NO_EMAIL')],
    ['a missing session', refusal('SESSION_REQUIRED')],
    ['a disabled account', refusal('ACCOUNT_DISABLED')],
    ['a wrong break-glass token', breakglassPage(NONCE, { error: 'Wrong token.' })],
    ['a dead pass link', renderNotFoundPage(NONCE)],
    ['a 404', renderErrorPage({ status: 404, nonce: NONCE })],
    ['a rate limit', renderErrorPage({ status: 429, nonce: NONCE })],
    ['a server error', renderErrorPage({ status: 500, nonce: NONCE })],
  ])('makes the wallet sad on %s', (_case, html) => {
    expect(mood(html)).toBe('sad');
    expect(html).toContain('data-part="br"');
  });

  it.each([
    ['confirm', confirmPage(NONCE, { token: TOKEN, email: 'a@b.co' })],
    ['break-glass', breakglassPage(NONCE, {})],
    ['proof sent', refusal('EMAIL_PROOF_SENT')],
    // Cancelling is a choice, not a failure: the waiting scene.
    ['oidc cancelled', oidcFailurePage(NONCE, 'cancelled', null)],
  ])('keeps the wallet content on %s', (_case, html) => {
    expect(mood(html)).toBeUndefined();
    expect(html).not.toContain('data-part="br"');
  });

  // One prop per meaning (the buddy spec): forbidden tugs the padlock, an error plugs in.
  const forbidden: SignInErrorCode[] = [
    'NO_ACCESS',
    'ACCOUNT_DISABLED',
    'NO_EMAIL',
    'EMAIL_CONFLICT',
    'SESSION_REQUIRED',
    'EMAIL_TAKEN',
  ];
  it.each<[string, string, string, string]>([
    ...forbidden.map((code): [string, string, string, string] => [
      code,
      refusal(code),
      'tug',
      'lock',
    ]),
    ['VALIDATION', refusal('VALIDATION'), 'plug', 'unplugged'],
    ['MAGIC_LINK_DISABLED', refusal('MAGIC_LINK_DISABLED'), 'plug', 'unplugged'],
    ['oidc unverified', oidcFailurePage(NONCE, 'unverified', null), 'plug', 'unplugged'],
    ['oidc unavailable', oidcFailurePage(NONCE, 'unavailable', null), 'plug', 'unplugged'],
  ])('acts out %s by its meaning', (_case, html, scene, prop) => {
    expect(act(html)).toEqual({ scene, prop });
    expect(mood(html)).toBe('sad');
  });

  it('droops the gold pass when expired; the hourglass waits out a rate limit', () => {
    expect(refusal('LINK_INVALID')).toContain('class="dim"');
    expect(oidcFailurePage(NONCE, 'expired', null)).toContain('class="dim"');
    expect(refusal('RATE_LIMITED')).toContain('data-part="hg"');
    expect(signInErrorPage(NONCE, 'RATE_LIMITED').status).toBe(429);
  });

  it('leads every refusal back to sign-in in outline, keeping next', () => {
    const { html, status } = signInErrorPage(NONCE, 'NO_EMAIL', { next: '/account' });
    expect(status).toBe(403);
    expect(primaries(html)).toBe(0);
    expect(outline(html)).toEqual([['/login?next=%2Faccount', 'Back to sign in']]);
    expect(outline(oidcFailurePage(NONCE, 'expired', '/admin'))).toEqual([
      ['/login?next=%2Fadmin', 'Back to sign in'],
    ]);
    expect(html).toContain(HOLDER_COPY.signInFooter);
  });

  it('words a dead link by its purpose: an add-email link leads to Account', () => {
    const signIn = expiredPage(NONCE, { next: '/passes/1', purpose: 'sign_in' });
    expect(signIn).toContain('Request a new one to sign in.');
    expect(outline(signIn)).toEqual([['/login?next=%2Fpasses%2F1', 'Back to sign in']]);
    const verify = expiredPage(NONCE, { next: null, purpose: 'verify_email' });
    expect(verify).toMatch(/<h1>Link expired<\/h1>/);
    expect(verify).toContain('Add the email again in Account.');
    expect(verify).not.toContain('sign in');
    expect(verify).not.toContain(HOLDER_COPY.signInFooter);
    expect(outline(verify)).toEqual([['/account', 'Go to Account']]);
  });

  it('renders no access once: the refusal route offers the same two ways, keeping next', () => {
    const { html, status } = signInErrorPage(NONCE, 'NO_ACCESS', { next: '/account' });
    expect(status).toBe(403);
    expect(html).toBe(noAccessPage(NONCE, '/account'));
    expect(html).toContain('Sign in with email instead');
  });

  it('offers a way out of a forbidden page by signing in as someone else', () => {
    const html = renderErrorPage({ status: 403, nonce: NONCE });
    expect(html).toContain('action="/auth/logout?next=%2Flogin"');
    expect(html).toContain('Sign in as someone else');
  });

  it('words a disabled account without repeating its title', () => {
    const html = refusal('ACCOUNT_DISABLED');
    expect(html).toContain('<h1>Account disabled</h1>');
    expect(html).toContain('Contact the organization that sent your pass.');
    expect(html).not.toContain('Ask an admin');
  });

  it('offers email and another Polaris ID on no access, worded as the app forbids', () => {
    const html = noAccessPage(NONCE);
    expect(html).toContain('<h1>You do not have access</h1>');
    expect(html).toContain('This Polaris ID account cannot use PassBook.');
    expect(html).toMatch(/<a class="btn" href="\/login\?focus=email">Sign in with email instead/);
    expect(html).toMatch(/<a class="btn outline" href="[^"]*prompt=login">Use another Polaris ID/);
  });

  it('puts errors in a callout at the top of the card body', () => {
    const html = breakglassPage(NONCE, { error: 'Wrong token.', next: '/admin' });
    expect(html).toMatch(/<p class="callout" role="alert">.*Wrong token\./);
    expect(html.indexOf('class="callout"')).toBeLessThan(html.indexOf('<form'));
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('name="next" value="/admin"');
  });

  it('escapes what it prints', () => {
    const html = verifyPage(NONCE, {
      token: TOKEN,
      email: '<b>@x.y',
      requester: 'a"b',
      viewer: 'requester',
    });
    expect(html).not.toContain('<b>@x.y');
    expect(html).toContain('&lt;b&gt;@x.y');
    expect(html).toContain('a&quot;b');
    const msg = renderErrorPage({ status: 500, nonce: NONCE, title: '<x>' });
    expect(msg).toContain('<h1>&lt;x&gt;</h1>');
  });
});

describe('click to replay the wallet', () => {
  const pages = [
    expiredPage(NONCE),
    noAccessPage(NONCE),
    renderErrorPage({ status: 404, nonce: NONCE }),
    renderNotFoundPage(NONCE),
  ];

  it('wraps the art in the replay hooks, decorative', () => {
    for (const html of [expiredPage(NONCE), renderNotFoundPage(NONCE)]) {
      expect(html).toMatch(
        /<div class="scene" aria-hidden="true"><span data-replay="" data-scene="hello"><svg data-art="wallet"/,
      );
    }
    for (const html of pages) expect(html).not.toMatch(/data-replay[^>]*tabindex/);
    expect(HOSTED_CSS).toContain('.scene>[data-replay]{display:block}');
  });

  // The app's compositions (state-art.test.tsx), played once on load with no script (F7).
  it.each([
    ['a server error', renderErrorPage({ status: 500, nonce: NONCE }), 'plug', 'unplugged'],
    ['a 404', renderErrorPage({ status: 404, nonce: NONCE }), 'peek', null],
    ['a refused form post', renderErrorPage({ status: 403, nonce: NONCE }), 'tug', 'lock'],
    ['no access', noAccessPage(NONCE), 'tug', 'lock'],
  ])('acts out %s, seated, with its prop', (_case, html, scene, prop) => {
    expect(html).toMatch(
      new RegExp(
        `<div class="scene" aria-hidden="true"><span aria-hidden="true" data-buddy="" data-replay="" data-scene="${scene}"[^>]*data-run="load" class="wl-buddy">`,
      ),
    );
    expect(act(html).prop).toBe(prop);
    expect(mood(html)).toBe('sad');
  });

  it('loads one same-origin deferred script the CSP already allows, nothing inline', () => {
    expect(REPLAY_SCRIPT).toBe('<script src="/buddy-replay.js" defer></script>');
    const csp = contentSecurityPolicy(NONCE);
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).not.toMatch(/script-src [^;]*unsafe-inline/);
    for (const html of pages) {
      expect(html).not.toMatch(/<script(?![^>]*\ssrc="\/)/);
      expect(html).not.toMatch(/\son[a-z]+="/);
    }
  });
});

describe('renderErrorPage', () => {
  // The SPA's words and weights: not found leads to My passes, an error retries, all outline.
  it.each([
    [404, 'Page not found', 'Check the link, or open My passes.', '/', 'Go to My passes', 'lost'],
    [
      403,
      'You do not have access',
      'Sign in with the account that has access.',
      '/',
      'Go to My passes',
      'login',
    ],
    [429, 'Too many requests', 'Try again in a minute.', '', 'Retry', 'login'],
    [500, 'Something went wrong', 'Try again.', '', 'Retry', 'login'],
  ])(
    'renders %i as a hosted card with one outline action',
    (status, title, line, href, label, state) => {
      const html = renderErrorPage({ status, nonce: NONCE });
      expect(html).toContain('<section class="card"');
      expect(html).toContain(`<h1>${title}</h1>`);
      if (line) expect(html).toContain(`<p class="lede">${line}</p>`);
      else expect(html).not.toContain('class="lede"');
      expect(html).toContain(`data-art="wallet" data-size="xl" data-state="${state}"`);
      expect(html.includes('data-part="hg"')).toBe(status === 429);
      expect(primaries(html)).toBe(0);
      expect(outline(html)).toEqual([[href, label]]);
      expect(scripts(html)).toEqual([REPLAY_SCRIPT]);
    },
  );

  it('says how long to wait from Retry-After', () => {
    expect(renderErrorPage({ status: 429, nonce: NONCE })).toContain('Try again in a minute.');
    expect(renderErrorPage({ status: 429, nonce: NONCE, retryAfter: 600 })).toContain(
      'Try again in 10 minutes.',
    );
  });
});

describe('holder text size', () => {
  it('follows Dynamic Type on iOS only (macOS Safari would set a 13 px root)', () => {
    expect(THEME_CSS).toContain(
      '@supports (font:-apple-system-body) and (-webkit-touch-callout:none){html{font:-apple-system-body;',
    );
    expect(THEME_CSS.match(/-apple-system-body/g)).toHaveLength(2);
  });
});
