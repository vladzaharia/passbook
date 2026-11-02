import { describe, expect, it } from 'vitest';
import {
  breakglassPage,
  confirmPage,
  expiredPage,
  messagePage,
  noAccessPage,
} from '../modules/auth/pages.ts';
import { renderErrorPage } from './error-page.tsx';

const NONCE = 'n0nce';
const primaries = (html: string) => html.match(/class="btn"/g)?.length ?? 0;

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

  it('offers email and another Polaris ID on no access', () => {
    const html = noAccessPage(NONCE);
    expect(html).toContain('This Polaris ID account cannot use Wallet.');
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
    [404, 'Page not found', 'Go home', 'torn'],
    [429, 'Too many requests', 'Retry', 'wallet'],
    [500, 'Something went wrong', 'Retry', 'unplugged'],
  ])('renders %i as a hosted card with one action', (status, title, action, art) => {
    const html = renderErrorPage({ status, nonce: NONCE });
    expect(html).toContain('<section class="card"');
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`data-art="${art}"`);
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
