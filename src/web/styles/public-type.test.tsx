import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '../lib/test-utils.tsx';

// The web project runs with css: false, so the brand defaults and the holder scale go in by hand.
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const style = document.createElement('style');
style.textContent = `${read('node_modules/@polaris-key/brand/css/tokens.css')}\n${read('src/web/styles/public-type.css')}`;
beforeAll(() => document.head.append(style));
afterAll(() => style.remove());
afterEach(() => vi.unstubAllGlobals());

/** A rem custom property in px at the default 16 px root. */
function px(el: Element, name: string): number {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  expect(value, name).toMatch(/^[\d.]+rem$/);
  return Number.parseFloat(value) * 16;
}

const root = () => document.documentElement;
const ACCOUNT = {
  '/api/v1/me/emails': () =>
    json({
      items: [{ email: 'test@example.com', verifiedAt: 1, verifiedVia: 'oidc', primary: true }],
    }),
  '/api/v1/me/sessions': () => json({ items: [] }),
};

/**
 * jsdom does not substitute var() into font-size, so: kit fields use text-sm, which reads
 * --pk-font-size-sm, at 16 px or more here; sign-in card fields are pinned by login-card.css.
 */
function expectFieldsAtLeast16px() {
  const fields = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')];
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    if (field.closest('.wl-login-card')) continue;
    expect(field.className).toMatch(/\btext-sm\b/);
    expect(px(field, '--pk-font-size-sm')).toBeGreaterThanOrEqual(16);
  }
}
const CARD_FIELDS = /\.wl-login-card input \{\s*font-size: max\(16px, 1rem\);/;

describe('holder type scale', () => {
  it('sets portal pages, their fields and portalled overlays in the holder scale', async () => {
    await renderApp('/account', { session: 'user', handlers: ACCOUNT });
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    await screen.findByLabelText('Add email');
    expect(screen.getByRole('main').closest('.wl-portal')).not.toBeNull();
    // On the root, so menus, dialogs and toasts portalled to <body> match the page.
    expect(px(root(), '--pk-font-size-sm')).toBe(16);
    expect(px(root(), '--pk-font-size-xs')).toBe(14);
    expect(px(root(), '--pk-font-size-2xl')).toBe(28);
    expectFieldsAtLeast16px();
  });

  it('sets the sign-in page in the holder scale', async () => {
    await renderApp('/login', { session: 'anon' });
    await screen.findByRole('heading', { name: 'Sign in', level: 1 });
    expect(px(root(), '--pk-font-size-sm')).toBe(16);
    expect((await screen.findByLabelText('Email')).closest('.wl-login-card')).not.toBeNull();
    expectFieldsAtLeast16px();
    expect(read('src/web/portal/login-card.css')).toMatch(CARD_FIELDS);
  });

  it('leaves the console on the brand scale', async () => {
    await renderApp('/admin/api-keys', { session: 'admin' });
    await screen.findByRole('navigation', { name: 'Admin' });
    expect(document.querySelector('.wl-portal')).toBeNull();
    expect(px(root(), '--pk-font-size-sm')).toBe(14);
    expect(px(root(), '--pk-font-size-xs')).toBe(12);
    expect(px(root(), '--pk-font-size-2xl')).toBe(24);
  });
});
