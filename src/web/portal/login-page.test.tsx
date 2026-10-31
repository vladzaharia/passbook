import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp, sessionFixture } from '../lib/test-utils.tsx';
import { goTo } from './goto.ts';

vi.mock('./goto.ts', () => ({ goTo: vi.fn() }));

let turnstileCallback: ((token: string) => void) | undefined;
const render = vi.fn((_el: HTMLElement, options: Record<string, unknown>) => {
  turnstileCallback = options.callback as (token: string) => void;
  return 'w1';
});

beforeEach(() => {
  turnstileCallback = undefined;
  vi.mocked(goTo).mockClear();
  render.mockClear();
  window.turnstile = { render, reset: vi.fn(), remove: vi.fn() };
});
afterEach(() => {
  window.turnstile = undefined;
  vi.unstubAllGlobals();
});

async function requestLink(user: ReturnType<typeof userEvent.setup>, email = 'sam@example.com') {
  await user.type(await screen.findByLabelText('Email'), email);
  await waitFor(() => expect(turnstileCallback).toBeDefined());
  turnstileCallback?.('tok-1');
  await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
}

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
    ['not_in_group', 'Your Polaris ID is not allowed to use Wallet.'],
    ['expired_link', 'That link expired. Request a new one.'],
    ['weird', 'Sign-in failed. Try again.'],
  ])('shows one line for ?error=%s', async (code, text) => {
    await renderApp(`/login?error=${code}`, { session: 'anon' });
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
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

  it('renders the Turnstile widget with the site key', async () => {
    await renderApp('/login', { session: 'anon' });
    await waitFor(() => expect(render).toHaveBeenCalled());
    expect(render.mock.calls[0]?.[1]).toMatchObject({ sitekey: '1x00000000000000000000AA' });
  });
});

describe('magic link', () => {
  it('requests a link, then signs in with the code', async () => {
    const user = userEvent.setup();
    const requests: unknown[] = [];
    const consumed: unknown[] = [];
    await renderApp('/login?next=%2Fpasses%2Fp1', {
      session: 'anon',
      handlers: {
        '/auth/magic/request': async (_u, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return json({ ok: true }, 202);
        },
        '/auth/magic/consume': async (_u, init) => {
          consumed.push(JSON.parse(String(init?.body)));
          return json({});
        },
      },
    });
    await requestLink(user);
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(requests).toEqual([
      { email: 'sam@example.com', turnstileToken: 'tok-1', next: '/passes/p1' },
    ]);

    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/passes/p1'));
    expect(consumed).toEqual([{ email: 'sam@example.com', code: '123456' }]);
  });

  it('validates email and the challenge before sending', async () => {
    const user = userEvent.setup();
    const fetchMock = (await renderApp('/login', { session: 'anon' })).fetchMock;
    await user.type(await screen.findByLabelText('Email'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText('Enter a valid email.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText('Complete the check first.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/magic'))).toBe(false);
  });

  it('shows a rate-limit error and resets the challenge', async () => {
    const user = userEvent.setup();
    await renderApp('/login', {
      session: 'anon',
      handlers: {
        '/auth/magic/request': () => problem(429, 'rate_limited', 'Too many requests. Try later.'),
      },
    });
    await requestLink(user);
    expect(await screen.findByText('Too many requests. Try later.')).toBeInTheDocument();
    await waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'Check your email' })).toBeNull();
  });

  it('shows a wrong-code error and stays on the page', async () => {
    const user = userEvent.setup();
    await renderApp('/login', {
      session: 'anon',
      handlers: {
        '/auth/magic/request': () => json({ ok: true }, 202),
        '/auth/magic/consume': () => problem(400, 'invalid_code', 'Code is wrong or expired.'),
      },
    });
    await requestLink(user);
    await user.type(await screen.findByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Code is wrong or expired.')).toBeInTheDocument();
    expect(goTo).not.toHaveBeenCalled();
  });

  it('rejects a short code locally and can go back', async () => {
    const user = userEvent.setup();
    await renderApp('/login', {
      session: 'anon',
      handlers: { '/auth/magic/request': () => json({ ok: true }, 202) },
    });
    await requestLink(user);
    await user.type(await screen.findByLabelText('6-digit code'), '12ab34');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter the 6-digit code.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('reports a challenge that fails to load', async () => {
    window.turnstile = {
      render: () => {
        throw new Error('boom');
      },
      reset: vi.fn(),
      remove: vi.fn(),
    };
    await renderApp('/login', { session: 'anon' });
    expect(
      await screen.findByText('The check failed to load. Reload the page.'),
    ).toBeInTheDocument();
  });
});
