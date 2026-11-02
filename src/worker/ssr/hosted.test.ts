import { describe, expect, it } from 'vitest';
import {
  breakglassPage,
  confirmPage,
  expiredPage,
  messagePage,
  noAccessPage,
  SIGN_IN_ERRORS,
} from '../modules/auth/pages.ts';
import { renderErrorPage } from './error-page.tsx';
import { HOSTED_CSS } from './hosted.ts';
import { HOSTED_ART_CSS } from './hosted-art.tsx';
import { renderNotFoundPage } from './pass-page.tsx';

const NONCE = 'n0nce';
const primaries = (html: string) => html.match(/class="btn"/g)?.length ?? 0;
const mood = (html: string) => /data-part="w"[^>]*data-mood="([a-z]+)"/.exec(html)?.[1];
const back = (code: string) => {
  const e = SIGN_IN_ERRORS[code];
  if (!e) throw new Error(code);
  return messagePage(NONCE, { ...e, href: '/login', action: 'Back to sign in' });
};

describe('hosted auth pages', () => {
  it.each([
    [
      'confirm',
      confirmPage(NONCE, { token: 't'.repeat(20), email: 'ada@example.com', purpose: 'sign_in' }),
    ],
    ['expired', expiredPage(NONCE)],
    ['no-access', noAccessPage(NONCE)],
    ['break-glass', breakglassPage(NONCE, {})],
  ])('renders the %s card with its own art, script-free', (state, html) => {
    expect(html).toContain(`<section class="card" data-state="${state}">`);
    expect(html).toContain(`data-art="wallet" data-state="${state}"`);
    expect(html).toContain('data-beat="off"');
    expect(html).toContain(`<style nonce="${NONCE}">`);
    expect(html).not.toMatch(/<script/);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toContain('theme-toggle');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(primaries(html)).toBe(1);
  });

  it.each([
    [
      'confirm',
      confirmPage(NONCE, { token: 't'.repeat(20), email: 'a@b.co', purpose: 'sign_in' }),
      ['ck'],
    ],
    ['expired', expiredPage(NONCE), []],
    ['no-access', noAccessPage(NONCE), ['lk', 'sh']],
    ['break-glass', breakglassPage(NONCE, {}), ['key', 'kt']],
  ])('gives %s its own beat on the fanned wallet', (_state, html, parts) => {
    expect(html.match(/data-part="c[123]"/g)).toHaveLength(3);
    expect(html).toContain('data-fan=""');
    expect(html).toContain('data-look=""');
    for (const part of parts) expect(html).toContain(`data-part="${part}"`);
    if (_state === 'expired') expect(html).toContain('class="dim"');
  });

  it('sizes the scene like /login and keeps fields at 16 px or more', () => {
    expect(HOSTED_CSS).toContain(HOSTED_ART_CSS);
    expect(HOSTED_CSS).toContain('.scene{position:relative;z-index:2;width:128px;height:96px');
    expect(HOSTED_CSS).toMatch(/input\{[^}]*font-size:max\(16px,1rem\)/);
  });

  it('seats the wallet on the card: above it, legs over the edge, a contact shadow', () => {
    // The base (y 66 of 72) meets the card's top edge: 8 px at 128×96, 7 px at 112×84.
    expect(HOSTED_CSS).toMatch(/\.scene\{[^}]*margin:1rem 0 -8px;pointer-events:none\}/);
    expect(HOSTED_CSS).toMatch(/\.scene\{margin-bottom:-7px\}/);
    expect(HOSTED_CSS).toMatch(/\.card\{position:relative;z-index:1;/);
    const html = noAccessPage(NONCE);
    expect(html).toMatch(/data-part="w"[^>]*data-seat=""/);
    for (const part of ['l1', 'l2', 'sd']) expect(html).toContain(`data-part="${part}"`);
  });

  it.each([
    ['no access', noAccessPage(NONCE)],
    ['an expired or used link', expiredPage(NONCE)],
    ['sign-in failed', messagePage(NONCE, { title: 'Sign-in failed', message: 'Try again.' })],
    ['provider unavailable', messagePage(NONCE, { title: 'Sign-in unavailable', message: 'x' })],
    ['an email conflict', back('EMAIL_CONFLICT')],
    ['an email taken', back('EMAIL_TAKEN')],
    ['no email', back('NO_EMAIL')],
    ['a missing session', back('SESSION_REQUIRED')],
    ['a disabled account', back('ACCOUNT_DISABLED')],
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
    ['confirm', confirmPage(NONCE, { token: 't'.repeat(20), email: 'a@b.co', purpose: 'sign_in' })],
    ['break-glass', breakglassPage(NONCE, {})],
    ['proof sent', back('EMAIL_PROOF_SENT')],
  ])('keeps the wallet content on %s', (_case, html) => {
    expect(mood(html)).toBeUndefined();
    expect(html).not.toContain('data-part="br"');
  });

  it('animates the auth states once, on transform and opacity, within the art budget', () => {
    const css = HOSTED_ART_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const ms = (v: string | undefined) => (v ? Number(/(\d+)ms/.exec(v)?.[1] ?? 0) : 0);
    for (const [, body] of css.matchAll(/[^{}]+\{([^{}]*)\}/g)) {
      const u = /--u:\s*([^;]+)/.exec(body ?? '')?.[1];
      if (!u) continue;
      expect(ms(u)).toBeLessThanOrEqual(480);
      expect(ms(/--d:\s*([^;]+)/.exec(body ?? '')?.[1]) + ms(u)).toBeLessThanOrEqual(600);
    }
    for (const [, frames] of css.matchAll(/@keyframes[^{]+\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
      for (const [, decls] of (frames ?? '').matchAll(/\{([^{}]*)\}/g)) {
        for (const prop of (decls ?? '').matchAll(/([a-z-]+)\s*:/g))
          expect(['transform', 'opacity']).toContain(prop[1]);
      }
    }
    // Animations run only when motion is allowed; reduce shows the final frame.
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{[^{}]*\{[^{}]*\}\s*\}/g,
      '',
    );
    expect(outside).not.toMatch(/(^|[\s;{])(animation|transition)(-[a-z]+)?\s*:/);
  });

  it('offers email and another Polaris ID on no access', () => {
    const html = noAccessPage(NONCE);
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
    const html = confirmPage(NONCE, {
      token: 't'.repeat(20),
      email: '<b>@x.y',
      purpose: 'verify_email',
      requester: 'a"b',
    });
    expect(html).not.toContain('<b>@x.y');
    expect(html).toContain('&lt;b&gt;@x.y');
    expect(html).toContain('a&quot;b');
    const msg = messagePage(NONCE, { title: '<x>', message: 'm', href: '/login' });
    expect(msg).toContain('<h1>&lt;x&gt;</h1>');
  });
});

describe('renderErrorPage', () => {
  it.each([
    [404, 'Page not found', 'Go home', 'lost'],
    [429, 'Too many requests', 'Retry', 'login'],
    [500, 'Something went wrong', 'Retry', 'login'],
  ])('renders %i as a hosted card with one action', (status, title, action, state) => {
    const html = renderErrorPage({ status, nonce: NONCE });
    expect(html).toContain('<section class="card"');
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`data-art="wallet" data-state="${state}"`);
    expect(html.includes('data-part="hg"')).toBe(status === 429);
    expect(primaries(html)).toBe(1);
    expect(html).toMatch(new RegExp(`<a class="btn" href="[^"]*">${action}</a>`));
    expect(html).not.toMatch(/<script/);
  });

  it('says how long to wait from Retry-After', () => {
    expect(renderErrorPage({ status: 429, nonce: NONCE })).toContain('Try again in a minute.');
    expect(renderErrorPage({ status: 429, nonce: NONCE, retryAfter: 600 })).toContain(
      'Try again in 10 minutes.',
    );
  });
});
