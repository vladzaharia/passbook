import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSignedOut,
  endSession,
  signedOutJustNow,
  signedOutNext,
  signOut,
} from '../lib/session.ts';
import { renderApp } from '../lib/test-utils.tsx';

const MARK = 'wallet-signed-out';
const NEXT_MARK = 'wallet-signed-out-next';
const answer = (body: unknown, status = 200) =>
  vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('goodbye wave', () => {
  it('signing out marks the tab; the mark counts for two minutes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, redirect: '/login' }))),
    );
    // jsdom cannot navigate; the mark is written before the page leaves.
    await signOut('csrf');
    const at = Number(sessionStorage.getItem(MARK));
    expect(signedOutJustNow(at + 119_000)).toBe(true);
    expect(signedOutJustNow(at + 121_000)).toBe(false);
  });

  it('the sign-in scene waves once after a sign-out and clears the mark', async () => {
    window.turnstile = { render: vi.fn(() => 'w1'), reset: vi.fn(), remove: vi.fn() };
    sessionStorage.setItem(MARK, String(Date.now()));
    const { container } = await renderApp('/login', { session: 'anon' });
    await screen.findByLabelText('Email');
    const scene = container.querySelector('.wl-login-scene');
    expect(scene).toHaveAttribute('data-bye');
    expect(scene).toHaveAttribute('aria-hidden', 'true');
    await waitFor(() => expect(sessionStorage.getItem(MARK)).toBeNull());
    window.turnstile = undefined;
  });
});

describe('sign out to switch', () => {
  it('asks the server to keep next and keeps it in the tab for the Pocket ID round trip', async () => {
    const fetch = answer({ ok: true, redirect: 'https://id.test/end-session' });
    vi.stubGlobal('fetch', fetch);
    await signOut('csrf', { next: '/admin/passes?q=1' });
    expect(fetch.mock.calls[0]?.[0]).toBe('/auth/logout?next=%2Fadmin%2Fpasses%3Fq%3D1');
    const at = Number(sessionStorage.getItem(MARK));
    expect(signedOutNext(at + 1000)).toBe('/admin/passes?q=1');
    expect(signedOutNext(at + 121_000)).toBeNull();
  });

  it('never keeps an unsafe next', async () => {
    const fetch = answer({ ok: true, redirect: '/login' });
    vi.stubGlobal('fetch', fetch);
    await signOut('csrf', { next: '//evil.example' });
    expect(fetch.mock.calls[0]?.[0]).toBe('/auth/logout');
    expect(sessionStorage.getItem(NEXT_MARK)).toBeNull();
    sessionStorage.setItem(NEXT_MARK, 'https://evil.example');
    expect(signedOutNext()).toBeNull();
  });

  it('a plain sign-out drops a next kept by an earlier switch', async () => {
    vi.stubGlobal('fetch', answer({ ok: true, redirect: 'https://id.test/end-session' }));
    sessionStorage.setItem(NEXT_MARK, '/admin/users');
    await signOut('csrf');
    expect(signedOutNext()).toBeNull();
  });

  it('the sign-in page picks the kept next up when the URL has none', async () => {
    window.turnstile = { render: vi.fn(() => 'w1'), reset: vi.fn(), remove: vi.fn() };
    sessionStorage.setItem(MARK, String(Date.now()));
    sessionStorage.setItem(NEXT_MARK, '/admin/users');
    await renderApp('/login', { session: 'anon' });
    expect(await screen.findByRole('link', { name: 'Sign in with Polaris ID' })).toHaveAttribute(
      'href',
      '/auth/oidc/start?next=%2Fadmin%2Fusers',
    );
    await waitFor(() => expect(sessionStorage.getItem(NEXT_MARK)).toBeNull());
    window.turnstile = undefined;
  });

  it('reads, once, the next an SSR switch left in the cookie through Pocket ID', () => {
    window.history.replaceState(null, '', '/login');
    try {
      // biome-ignore lint/suspicious/noDocumentCookie: the cookie the logout POST sets
      document.cookie = `wallet-next=${encodeURIComponent('/auth/magic?t=abc')}; Path=/login`;
      // No goodbye mark in this tab: the server's cookie is enough.
      expect(signedOutNext()).toBe('/auth/magic?t=abc');
      clearSignedOut();
      expect(document.cookie).not.toContain('wallet-next=');
      expect(signedOutNext()).toBeNull();
      // biome-ignore lint/suspicious/noDocumentCookie: a forged value is not a same-origin path
      document.cookie = 'wallet-next=https%3A%2F%2Fevil.example; Path=/login';
      expect(signedOutNext()).toBeNull();
      clearSignedOut();
      expect(document.cookie).not.toContain('wallet-next=');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('"Sign in as someone else" on the forbidden page keeps the page as next', async () => {
    const user = userEvent.setup();
    const logout: string[] = [];
    await renderApp('/admin/passes?status=active', {
      session: 'user',
      handlers: {
        '/auth/logout': (url) => {
          logout.push(`${url.pathname}${url.search}`);
          return new Response(JSON.stringify({ ok: true, redirect: '/login' }));
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sign in as someone else' }));
    await waitFor(() =>
      expect(logout).toEqual([
        `/auth/logout?next=${encodeURIComponent('/admin/passes?status=active')}`,
      ]),
    );
  });

  it('signing out everywhere sends all=1 with the CSRF token and throws when refused', async () => {
    const ok = answer({ ok: true, redirect: '/login' });
    vi.stubGlobal('fetch', ok);
    await expect(endSession('csrf', { everywhere: true })).resolves.toBe('/login');
    expect(ok.mock.calls[0]?.[0]).toBe('/auth/logout?all=1');
    expect(new Headers(ok.mock.calls[0]?.[1]?.headers).get('x-csrf-token')).toBe('csrf');
    vi.stubGlobal('fetch', answer({ code: 'CSRF_TOKEN', status: 403, detail: 'Reload.' }, 403));
    await expect(endSession('stale', { everywhere: true })).rejects.toThrow();
    // A single sign-out still leaves: the sign-in page re-checks the session.
    await expect(endSession('stale')).resolves.toBe('/login');
  });
});
