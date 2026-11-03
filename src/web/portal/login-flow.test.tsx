import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import { goTo } from './goto.ts';

vi.mock('./goto.ts', () => ({ goTo: vi.fn() }));

let callbacks: Record<string, (...args: never[]) => void> = {};
const render = vi.fn((_el: HTMLElement, options: Record<string, unknown>) => {
  callbacks = options as typeof callbacks;
  return 'w1';
});
const token = (value: string) => (callbacks.callback as (t: string) => void)(value);

beforeEach(() => {
  callbacks = {};
  vi.mocked(goTo).mockClear();
  render.mockClear();
  window.turnstile = { render, reset: vi.fn(), remove: vi.fn() };
});
afterEach(() => {
  window.turnstile = undefined;
  vi.restoreAllMocks();
});

const sent = () => json({ ok: true }, 202);

async function requestLink(user: ReturnType<typeof userEvent.setup>, email = 'sam@example.com') {
  await user.type(await screen.findByLabelText('Email'), email);
  await waitFor(() => expect(callbacks.callback).toBeDefined());
  token('tok-1');
  await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  return screen.findByRole('heading', { name: 'Enter the code' });
}

describe('magic link', () => {
  it('flips to the code face, focuses the code, then signs in', async () => {
    const user = userEvent.setup();
    const requests: unknown[] = [];
    const consumed: unknown[] = [];
    const { container } = await renderApp('/login?next=%2Fpasses%2Fp1', {
      session: 'anon',
      handlers: {
        '/auth/magic/request': async (_u, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return sent();
        },
        '/auth/magic/consume': async (_u, init) => {
          consumed.push(JSON.parse(String(init?.body)));
          // The server applies the landing rule; the face follows its answer.
          return json({ ok: true, next: '/passes/p1#from-server' });
        },
      },
    });
    await requestLink(user);
    expect(requests).toEqual([
      { email: 'sam@example.com', turnstileToken: 'tok-1', next: '/passes/p1' },
    ]);
    // Neutral: unknown or throttled addresses get no mail, so the face never says "sent".
    expect(screen.getByText('sam@example.com').parentElement).toHaveTextContent(
      'Check sam@example.com for a code.',
    );
    expect(container.querySelector('[data-side="email"]')).toHaveAttribute('inert');
    expect(screen.queryByRole('link', { name: 'Sign in with Polaris ID' })).toBeNull();
    const code = screen.getByLabelText('Code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(container.querySelector('.wl-login-scene')).toHaveAttribute('data-beat', 'sent');
    expect((await axe(container)).violations).toEqual([]);

    await user.type(code, '123 456');
    expect(code).toHaveValue('123456');
    expect(container.querySelector('.wl-code')).toHaveAttribute('data-complete');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/passes/p1#from-server'));
    expect(consumed).toEqual([{ email: 'sam@example.com', code: '123456' }]);
    expect(container.querySelector('.wl-login-scene')).toHaveAttribute('data-beat', 'success');
    // The wallet fills: the eyes smile.
    expect(container.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'happy');
    expect(container.querySelector('[data-look] [data-part="joy"]')).not.toBeNull();
  });

  it('shows the first letter of a valid address on the top card, in place under reduced motion', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/login', { session: 'anon' });
    await user.type(await screen.findByLabelText('Email'), 'ada@example');
    expect(container.querySelector('.wl-login-initial')).toBeNull();
    await user.type(screen.getByLabelText('Email'), '.com');
    const initial = container.querySelector('[data-part="c2"] .wl-login-initial');
    expect(initial).toHaveTextContent('A');
    expect(container.querySelector('[data-lift]')).toBeNull();
    await user.clear(screen.getByLabelText('Email'));
    expect(container.querySelector('.wl-login-initial')).toBeNull();
  });

  it('lifts the top card when motion is allowed', async () => {
    const original = window.matchMedia;
    // Motion allowed: every query answers false, so prefers-reduced-motion: reduce is off.
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...original(query),
      matches: false,
    }));
    const user = userEvent.setup();
    const { container } = await renderApp('/login', { session: 'anon' });
    await user.type(await screen.findByLabelText('Email'), 'bo@example.com');
    expect(container.querySelector('[data-part="w"]')).toHaveAttribute('data-lift');
    expect(container.querySelector('.wl-login-initial')).toHaveTextContent('B');
  });

  it('turns the eyes toward typing, then lets go on blur', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/login', { session: 'anon' });
    const email = await screen.findByLabelText('Email');
    const scene = container.querySelector('.wl-login-scene') as HTMLElement;
    // At 1440 the field spans x 553–887 and the wallet's box 779–907, at the card's right.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const [left, width] = this === scene ? [779, 128] : this === email ? [553, 334] : [0, 0];
      return DOMRect.fromRect({ x: left, y: 0, width, height: 0 });
    });
    expect(scene).not.toHaveAttribute('data-gaze');
    await user.type(email, 'ada@example.com');
    expect(scene).toHaveAttribute('data-gaze');
    // 15 characters in, the caret is left of the wallet: the eyes look left.
    expect(Number(scene.style.getPropertyValue('--gx'))).toBeCloseTo((565 + 15 * 8.3 - 843) / 160);
    await user.tab();
    expect(scene).not.toHaveAttribute('data-gaze');
  });

  it('pauses the scene while the tab is hidden', async () => {
    const { container } = await renderApp('/login', { session: 'anon' });
    await screen.findByLabelText('Email');
    const scene = container.querySelector('.wl-login-scene');
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(scene).toHaveAttribute('data-paused');
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(scene).not.toHaveAttribute('data-paused');
  });

  it('checks the address, then waits for the challenge instead of failing', async () => {
    const user = userEvent.setup();
    const fetchMock = (
      await renderApp('/login', {
        session: 'anon',
        handlers: { '/auth/magic/request': sent },
      })
    ).fetchMock;
    await user.type(await screen.findByLabelText('Email'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    // A slip, not a failure: flat, never sad (B4b).
    expect(document.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'flat');
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/magic'))).toBe(false);
    token('tok-late');
    expect(await screen.findByRole('heading', { name: 'Enter the code' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a rate limit in a callout, stands the hourglass by the sad wallet, gets a fresh challenge', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/login', {
      session: 'anon',
      handlers: {
        '/auth/magic/request': () => problem(429, 'RATE_LIMITED', 'Too many requests. Try later.'),
      },
    });
    await user.type(await screen.findByLabelText('Email'), 'sam@example.com');
    await waitFor(() => expect(callbacks.callback).toBeDefined());
    token('tok-1');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    // Worded as the hosted pages word it: a title and one sentence.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Too many requests\s*Try again in a minute\./,
    );
    // The hourglass means a wait, here and on the SSR 429 page (art/wallet-states.tsx).
    expect(container.querySelector('.wl-login-scene')).toHaveAttribute('data-sad', 'wait');
    expect(container.querySelector('[data-part="hg"]')).not.toBeNull();
    expect(container.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'sad');
    // Sad drops the lifted card back into the fan.
    expect(container.querySelector('[data-lift]')).toBeNull();
    await waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Email')).toBeVisible();
  });

  it('goes sad without a shake when the network fails, and perks up on typing', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/login', {
      session: 'anon',
      handlers: { '/auth/magic/request': () => Promise.reject(new TypeError('Failed to fetch')) },
    });
    await user.type(await screen.findByLabelText('Email'), 'sam@example.com');
    await waitFor(() => expect(callbacks.callback).toBeDefined());
    token('tok-1');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const scene = container.querySelector('.wl-login-scene');
    expect(scene).toHaveAttribute('data-sad', 'error');
    expect(container.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'sad');
    expect(container.querySelector('.wl-login-pocket[data-shake]')).toBeNull();
    await user.type(screen.getByLabelText('Email'), 'm');
    expect(scene).not.toHaveAttribute('data-sad');
    expect(container.querySelector('[data-part="w"]')).not.toHaveAttribute('data-mood');
  });

  it('says a wrong code is wrong or expired, without mentioning links', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/login', {
      session: 'anon',
      handlers: {
        '/auth/magic/request': sent,
        '/auth/magic/consume': () =>
          problem(400, 'LINK_INVALID', 'This link or code is invalid or expired.'),
      },
    });
    await requestLink(user);
    await user.type(screen.getByLabelText('Code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const error = await screen.findByText('That code is wrong or expired.');
    expect(error.textContent).not.toMatch(/link/i);
    expect(screen.getByLabelText('Code')).toHaveAttribute('aria-invalid', 'true');
    // A slip: one shake and a flat face, not sad (B4b); no hourglass, no drooping pass.
    expect(container.querySelector('.wl-login-pocket[data-shake]')).not.toBeNull();
    expect(container.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'flat');
    expect(container.querySelector('[data-look] [data-part="br"]')).toBeNull();
    expect(container.querySelector('[data-part="hg"]')).toBeNull();
    expect(container.querySelector('[data-art="wallet"]')).toHaveAttribute('data-state', 'login');
    expect(goTo).not.toHaveBeenCalled();
    // Another try cheers it up.
    await user.type(screen.getByLabelText('Code'), '{Backspace}');
    expect(container.querySelector('[data-part="w"]')).not.toHaveAttribute('data-mood');
  });

  it('greys and droops the gold pass when the code has run out', async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const { container } = await renderApp('/login', {
      session: 'anon',
      handlers: {
        '/auth/magic/request': sent,
        '/auth/magic/consume': () =>
          problem(400, 'LINK_INVALID', 'This link or code is invalid or expired.'),
      },
    });
    await requestLink(user);
    await user.type(screen.getByLabelText('Code'), '000000');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('That code is wrong or expired.');
    // Expired, as on the SSR "Link expired" page: sad, the gold pass greyed and drooping.
    expect(container.querySelector('[data-art="wallet"]')).toHaveAttribute('data-state', 'expired');
    expect(container.querySelector('[data-part="c3"].dim')).not.toBeNull();
    expect(container.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'sad');
    expect(container.querySelector('[data-part="hg"]')).toBeNull();
    expect(clock).toHaveBeenCalled();
  });

  it('rejects a short code locally and goes back to the email face', async () => {
    const user = userEvent.setup();
    await renderApp('/login', { session: 'anon', handlers: { '/auth/magic/request': sent } });
    await requestLink(user);
    await user.type(screen.getByLabelText('Code'), '12ab34');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter the 6-digit code.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    const email = await screen.findByLabelText('Email');
    await waitFor(() => expect(document.activeElement).toBe(email));
    expect(screen.getByRole('link', { name: 'Sign in with Polaris ID' })).toBeVisible();
    // The posted card comes back to the pocket.
    expect(document.querySelector('.wl-login-scene')).toHaveAttribute('data-beat', 'back');
  });

  it('counts down before a resend, then sends again', async () => {
    const user = userEvent.setup();
    const requests: unknown[] = [];
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await renderApp('/login', {
      session: 'anon',
      handlers: {
        '/auth/magic/request': async (_u, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return sent();
        },
      },
    });
    await requestLink(user);
    expect(screen.getByRole('button', { name: 'Resend in 30s' })).toBeDisabled();
    spy.mockReturnValue(now + 31_000);
    const resend = await screen.findByRole('button', { name: 'Resend code' }, { timeout: 2500 });
    token('tok-2');
    await user.click(resend);
    expect(await screen.findByRole('button', { name: 'Sent again' })).toBeInTheDocument();
    expect(requests).toHaveLength(2);
    spy.mockRestore();
  });

  it('says so when the challenge cannot load', async () => {
    window.turnstile = {
      render: () => {
        throw new Error('boom');
      },
      reset: vi.fn(),
      remove: vi.fn(),
    };
    await renderApp('/login', { session: 'anon' });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not verify this browser. Reload and try again.',
    );
  });
});
