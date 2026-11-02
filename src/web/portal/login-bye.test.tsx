import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedOutJustNow, signOut } from '../lib/session.ts';
import { renderApp } from '../lib/test-utils.tsx';

const MARK = 'wallet-signed-out';

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
