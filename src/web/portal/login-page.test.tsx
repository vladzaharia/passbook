import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp, sessionFixture } from '../lib/test-utils.tsx';
import { goTo } from './goto.ts';

vi.mock('./goto.ts', () => ({ goTo: vi.fn() }));

const render = vi.fn((_el: HTMLElement, _options: Record<string, unknown>) => 'w1');

beforeEach(() => {
  vi.mocked(goTo).mockClear();
  render.mockClear();
  window.turnstile = { render, reset: vi.fn(), remove: vi.fn() };
});
afterEach(() => {
  window.turnstile = undefined;
  vi.unstubAllGlobals();
});

describe('login page', () => {
  it('links Polaris ID with the next path', async () => {
    const { container } = await renderApp('/login?next=%2Fpasses%2Fp1', { session: 'anon' });
    const link = await screen.findByRole('link', { name: 'Sign in with Polaris ID' });
    expect(link).toHaveAttribute('href', '/auth/oidc/start?next=%2Fpasses%2Fp1');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('drops an unsafe next', async () => {
    await renderApp('/login?next=https%3A%2F%2Fevil.test', { session: 'anon' });
    const link = await screen.findByRole('link', { name: 'Sign in with Polaris ID' });
    expect(link).toHaveAttribute('href', '/auth/oidc/start?next=%2F');
  });

  it('hides disabled methods', async () => {
    await renderApp('/login', {
      handlers: {
        '/api/v1/session': () =>
          json({ ...sessionFixture('anon'), oidcEnabled: false, magicLinkEnabled: true }),
      },
      session: 'anon',
    });
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in with Polaris ID' })).toBeNull();
  });

  it('says so when no method is enabled', async () => {
    await renderApp('/login', {
      handlers: {
        '/api/v1/session': () =>
          json({ ...sessionFixture('anon'), oidcEnabled: false, magicLinkEnabled: false }),
      },
      session: 'anon',
    });
    expect(await screen.findByText('Sign-in is unavailable.')).toBeInTheDocument();
  });

  it.each([
    ['not_in_group', 'Your Polaris ID is not allowed to use PassBook.'],
    ['expired_link', 'That link expired. Request a new one.'],
    ['weird', 'Sign-in failed. Try again.'],
  ])('shows one line for ?error=%s, the wallet sad', async (code, text) => {
    const { container } = await renderApp(`/login?error=${code}`, { session: 'anon' });
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(container.querySelector('.wl-login-scene')).toHaveAttribute('data-sad', 'load');
    expect(container.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'sad');
  });

  it('is sad when the session fails to load or no method is enabled', async () => {
    const failed = await renderApp('/login', {
      session: 'anon',
      handlers: { '/api/v1/session': () => problem(500, 'INTERNAL', 'Something went wrong.') },
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(failed.container.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'sad');
    failed.unmount();
    const off = await renderApp('/login', {
      handlers: {
        '/api/v1/session': () =>
          json({ ...sessionFixture('anon'), oidcEnabled: false, magicLinkEnabled: false }),
      },
      session: 'anon',
    });
    await screen.findByText('Sign-in is unavailable.');
    expect(off.container.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'sad');
  });

  it('does not follow a next that URL parsing turns into another origin', async () => {
    await renderApp('/login?next=%2F%09%2Fevil.test', { session: 'user' });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/'));
    expect(goTo).not.toHaveBeenCalledWith(expect.stringContaining('evil'));
  });

  it('sends a signed-in visitor on to next', async () => {
    await renderApp('/login?next=%2Faccount', { session: 'user' });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/account'));
  });

  it('leads with the email path: Email first, one primary button', async () => {
    const { container } = await renderApp('/login', { session: 'anon' });
    const email = await screen.findByLabelText('Email');
    expect(document.activeElement).toBe(email);
    const front = container.querySelector('[data-side="email"]') as HTMLElement;
    expect(front.querySelector('input, button, a')).toBe(email);
    const primaries = [...front.querySelectorAll('button, a')].filter((el) =>
      el.className.includes('bg-accent'),
    );
    expect(primaries.map((el) => el.textContent)).toEqual(['Email me a sign-in link']);
    expect(screen.getByRole('link', { name: 'Sign in with Polaris ID' })).toHaveClass('border');
    expect(
      within(front).getByText('Signing in shows the passes sent to your email.'),
    ).toBeVisible();
  });

  it('draws the hosted shell: wordmark, the wallet scene, no badge and no theme toggle', async () => {
    const { container } = await renderApp('/login', { session: 'anon' });
    await screen.findByLabelText('Email');
    expect(container.querySelector('.wl-login-scene .wl-art[data-art="wallet"]')).not.toBeNull();
    expect(container.querySelector('[data-flip]')).toBeNull();
    expect(screen.queryByAltText('Add to Apple Wallet')).toBeNull();
    expect(screen.queryByRole('button', { name: /theme/i })).toBeNull();
  });

  it('leaves the once-per-session wordmark flip for the first page that plays it', async () => {
    const { container, unmount } = await renderApp('/login', { session: 'anon' });
    await screen.findByLabelText('Email');
    expect(container.querySelector('[data-flip]')).toBeNull();
    expect(sessionStorage.getItem('wallet-wordmark-flipped')).toBeNull();
    unmount();
    const admin = await renderApp('/admin', { session: 'admin' });
    await waitFor(() => expect(admin.container.querySelector('[data-flip]')).not.toBeNull());
    expect(sessionStorage.getItem('wallet-wordmark-flipped')).toBe('1');
  });

  it('sits the wallet on the card: fanned cards, eyes in a look group, decorative', async () => {
    const { container } = await renderApp('/login', { session: 'anon' });
    await screen.findByLabelText('Email');
    const scene = container.querySelector('.wl-login-scene');
    expect(scene).toHaveAttribute('aria-hidden', 'true');
    expect(scene).not.toHaveAttribute('data-beat');
    expect(scene).not.toHaveAttribute('data-sad');
    expect(scene).not.toHaveAttribute('data-bye');
    expect(scene?.querySelector('[data-part="w"]')).toHaveAttribute('data-seat');
    expect(scene?.querySelectorAll('[data-part="l1"], [data-part="l2"]')).toHaveLength(2);
    expect(scene?.querySelector('#wl-login-slot')).not.toBeNull();
    expect(scene?.querySelectorAll('[data-fan] [data-part^="c"]')).toHaveLength(3);
    expect(scene?.querySelector('[data-look] [data-part="eyes"]')).not.toBeNull();
    expect(scene?.querySelector('text')).toBeNull();
  });

  it('keeps the card height while the session loads', async () => {
    const { container } = await renderApp('/login', {
      session: 'anon',
      handlers: { '/api/v1/session': () => new Promise<Response>(() => {}) },
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    const card = container.querySelector('.wl-login-flipper');
    expect(card?.querySelectorAll('[data-side]')).toHaveLength(2);
    expect(card?.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('renders the Turnstile widget with the site key', async () => {
    await renderApp('/login', { session: 'anon' });
    await waitFor(() => expect(render).toHaveBeenCalled());
    expect(render.mock.calls[0]?.[1]).toMatchObject({ sitekey: '1x00000000000000000000AA' });
  });
});
