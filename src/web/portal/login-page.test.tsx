import { act, screen, waitFor, within } from '@testing-library/react';
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
  vi.restoreAllMocks();
});

describe('login page', () => {
  it('links Polaris ID with the next path', async () => {
    const { container } = await renderApp('/login?next=%2Fpasses%2Fp1', { session: 'anon' });
    const link = await screen.findByRole('link', { name: 'Sign in with Polaris ID' });
    expect(link).toHaveAttribute('href', '/auth/oidc/start?next=%2Fpasses%2Fp1');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('drops an unsafe next, leaving the landing to the server', async () => {
    await renderApp('/login?next=https%3A%2F%2Fevil.test', { session: 'anon' });
    const link = await screen.findByRole('link', { name: 'Sign in with Polaris ID' });
    expect(link).toHaveAttribute('href', '/auth/oidc/start');
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

  it('says in one line that the session ended, without a sad wallet', async () => {
    const { container } = await renderApp('/login?next=%2Faccount&reason=expired', {
      session: 'anon',
    });
    await screen.findByLabelText('Email');
    expect(screen.getByText('Your session ended. Sign in again.')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.wl-login-scene')).not.toHaveAttribute('data-sad');
    expect(screen.getByRole('link', { name: 'Sign in with Polaris ID' })).toHaveAttribute(
      'href',
      '/auth/oidc/start?next=%2Faccount',
    );
  });

  it('ignores an unknown reason and the old ?error=', async () => {
    await renderApp('/login?reason=weird&error=not_in_group', { session: 'anon' });
    await screen.findByLabelText('Email');
    expect(screen.queryByText(/session ended/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leads with the code when installed to the home screen', async () => {
    const original = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...original(query),
      matches: query.includes('display-mode: standalone') || original(query).matches,
    }));
    await renderApp('/login', { session: 'anon' });
    expect(await screen.findByRole('button', { name: 'Email me a code' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email me a sign-in link' })).toBeNull();
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

  it('lands a signed-in admin in the console without next, a holder on My passes', async () => {
    const admin = await renderApp('/login', { session: 'admin' });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/admin'));
    admin.unmount();
    vi.mocked(goTo).mockClear();
    await renderApp('/login', { session: 'user' });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/'));
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
    expect(container.querySelector('[data-hello]')).toBeNull();
    expect(screen.queryByAltText('Add to Apple Wallet')).toBeNull();
    expect(screen.queryByRole('button', { name: /theme/i })).toBeNull();
  });

  it('puts the wordmark left and the wallet right in one band straight above the card', async () => {
    const { container } = await renderApp('/login', { session: 'anon' });
    await screen.findByLabelText('Email');
    const band = container.querySelector('.wl-login-band') as HTMLElement;
    const [brand, scene, ...rest] = band.children;
    expect(rest).toHaveLength(0);
    expect(brand).toHaveClass('wl-login-brand');
    expect(scene).toHaveClass('wl-login-scene');
    // The brand mark: still the home link with its name, 20 px with the 24 px face.
    const mark = within(brand as HTMLElement).getByRole('link', { name: 'PassBook' });
    expect(mark).toHaveAttribute('href', '/');
    expect(mark).toHaveClass('text-xl', 'font-semibold');
    expect(mark.querySelector('svg.wl-mark')).toHaveClass('size-6');
    expect(band.nextElementSibling?.querySelector('.wl-login-card')).not.toBeNull();
  });

  it('leaves the once-per-session hello for the first page that plays it', async () => {
    const { container, unmount } = await renderApp('/login', { session: 'anon' });
    await screen.findByLabelText('Email');
    expect(container.querySelector('[data-hello]')).toBeNull();
    expect(sessionStorage.getItem('wallet-wordmark-hello')).toBeNull();
    unmount();
    const admin = await renderApp('/admin', { session: 'admin' });
    await waitFor(() => expect(admin.container.querySelector('[data-hello]')).not.toBeNull());
    expect(sessionStorage.getItem('wallet-wordmark-hello')).toBe('1');
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
    // The band is final from the first paint: the skeleton sits where the form will.
    expect(container.querySelector('.wl-login-band > .wl-login-scene')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'PassBook' })).toBeInTheDocument();
    const card = container.querySelector('.wl-login-flipper');
    expect(card?.querySelectorAll('[data-side]')).toHaveLength(2);
    expect(card?.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('renders the Turnstile widget with the site key', async () => {
    await renderApp('/login', { session: 'anon' });
    await waitFor(() => expect(render).toHaveBeenCalled());
    expect(render.mock.calls[0]?.[1]).toMatchObject({ sitekey: '1x00000000000000000000AA' });
  });

  it('keeps the challenge slot collapsed unless Turnstile asks for the visitor', async () => {
    await renderApp('/login', { session: 'anon' });
    await waitFor(() => expect(render).toHaveBeenCalled());
    const slot = screen.getByTestId('turnstile').parentElement as HTMLElement;
    expect(slot).toHaveClass('h-0', 'overflow-hidden');
    const options = render.mock.calls[0]?.[1] as Record<string, () => void>;
    act(() => options['before-interactive-callback']?.());
    expect(slot).toHaveAttribute('data-shown');
    expect(slot).not.toHaveClass('h-0');
    act(() => options['after-interactive-callback']?.());
    expect(slot).toHaveClass('h-0');
  });
});
