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
});

const sent = () => json({ ok: true }, 202);

async function requestLink(user: ReturnType<typeof userEvent.setup>, email = 'sam@example.com') {
  await user.type(await screen.findByLabelText('Email'), email);
  await waitFor(() => expect(callbacks.callback).toBeDefined());
  token('tok-1');
  await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  return screen.findByRole('heading', { name: 'Enter the code from your email' });
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
          return json({});
        },
      },
    });
    await requestLink(user);
    expect(requests).toEqual([
      { email: 'sam@example.com', turnstileToken: 'tok-1', next: '/passes/p1' },
    ]);
    expect(screen.getByText('sam@example.com')).toBeInTheDocument();
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
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/passes/p1'));
    expect(consumed).toEqual([{ email: 'sam@example.com', code: '123456' }]);
    expect(container.querySelector('.wl-login-scene')).toHaveAttribute('data-beat', 'success');
  });

  it('shows the first letter of a valid address on the top card', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/login', { session: 'anon' });
    await user.type(await screen.findByLabelText('Email'), 'ada@example');
    expect(container.querySelector('.wl-login-letter [data-on]')).toBeNull();
    await user.type(screen.getByLabelText('Email'), '.com');
    expect(container.querySelector('.wl-login-letter [data-on] text')).toHaveTextContent('A');
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
    expect(await screen.findByText('Enter a valid email.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/magic'))).toBe(false);
    token('tok-late');
    expect(
      await screen.findByRole('heading', { name: 'Enter the code from your email' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a rate limit in a callout, shakes the wallet and gets a fresh challenge', async () => {
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Try later.');
    expect(container.querySelector('.wl-login-pocket[data-shake]')).not.toBeNull();
    await waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Email')).toBeVisible();
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
    expect(container.querySelector('.wl-login-pocket[data-shake]')).not.toBeNull();
    expect(goTo).not.toHaveBeenCalled();
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
