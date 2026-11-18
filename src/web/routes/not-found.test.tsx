import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATE_COPY } from '@/shared/copy/states.ts';
import { renderApp } from '../lib/test-utils.tsx';

afterEach(() => vi.unstubAllGlobals());

describe('unknown URLs', () => {
  it('show the not-found page with Sign in to a signed-out visitor', async () => {
    await renderApp('/no-such-page', { session: 'anon' });
    expect(await screen.findByRole('heading', { name: STATE_COPY.pageNotFound })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('send a signed-out visitor from a real holder page to Sign in', async () => {
    await renderApp('/account', { session: 'anon' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  it('offer My passes to a signed-in visitor', async () => {
    await renderApp('/no-such-page', { session: 'user' });
    expect(await screen.findByRole('link', { name: STATE_COPY.goToMyPasses })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });
});
