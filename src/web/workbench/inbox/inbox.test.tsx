import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { forgetTokens } from '../host/token.ts';
import { handlers } from '../shell/test-fixtures.ts';

/** A wide window: the pane sits beside the list and a close is immediate. */
beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('1180') || q.includes('720') || q.includes('reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetTokens();
  localStorage.clear();
  sessionStorage.clear();
  location.hash = '';
});

const email = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  orgId: 'nw',
  kind: 'pass',
  passId: 'p1',
  bundleId: null,
  to: 'holder@example.com',
  subject: 'Your Gym pass',
  attached: false,
  failed: false,
  createdAt: Date.now() - 3_600_000,
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...email(over),
  html: '<p>Hi</p>',
  text: 'Hi there',
  forwarding: 'none',
});
const member = membershipFixture('nw', { userId: 'u1' });
const setup = (items: unknown[], extra: Record<string, () => Response> = {}) => ({
  session: 'developer' as const,
  memberships: [member],
  handlers: {
    ...handlers(),
    '/api/v1/test-inbox': () => json({ items, nextCursor: null }),
    '/api/v1/test-inbox/e1': () => json(detail()),
    '/api/v1/test-inbox/e2': () => json(detail({ id: 'e2', failed: true })),
    '/api/v1/me/emails': () =>
      json({
        items: [{ email: 'me@example.com', verifiedAt: 1, verifiedVia: 'oidc', primary: true }],
        nextCursor: null,
      }),
    ...extra,
  },
});
const headersOf = (init: RequestInit | undefined) =>
  Object.fromEntries(new Headers(init?.headers).entries());
const callsTo = (fetchMock: { mock: { calls: unknown[][] } }, match: (path: string) => boolean) =>
  fetchMock.mock.calls
    .map(([url, init]) => ({
      path: new URL(String(url), 'http://localhost').pathname,
      init: init as RequestInit | undefined,
    }))
    .filter(({ path }) => match(path));

describe('the Workbench inbox', () => {
  it('lists Test emails with the simulated failed flag, all through the token', async () => {
    const { fetchMock } = await renderApp(
      '/workbench/o/nw/inbox',
      setup([email(), email({ id: 'e2', subject: 'Second pass', failed: true })]),
    );
    const list = await screen.findByRole('listbox', { name: 'Test emails' });
    expect(within(list).getByText('Your Gym pass')).toBeInTheDocument();
    const failed = within(list).getByText('Second pass').closest('[role="option"]') as HTMLElement;
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    expect(within(list).getAllByText('Failed')).toHaveLength(1);
    const calls = callsTo(fetchMock, (p) => p === '/api/v1/test-inbox');
    expect(calls.length).toBeGreaterThan(0);
    for (const { init } of calls) {
      expect(headersOf(init).authorization).toBe('Bearer pbtry_nw');
      expect(Object.keys(headersOf(init)).some((h) => /mode/i.test(h))).toBe(false);
    }
  });

  it('shows the empty line when nothing was captured', async () => {
    await renderApp('/workbench/o/nw/inbox', setup([]));
    expect(await screen.findByText('No test emails')).toBeInTheDocument();
  });

  it('opens a message by its id and marks a failed one', async () => {
    location.hash = '#e2';
    await renderApp('/workbench/o/nw/inbox', setup([email(), email({ id: 'e2', failed: true })]));
    const pane = await screen.findByRole('heading', { name: 'Your Gym pass', level: 2 });
    expect(pane).toBeInTheDocument();
    expect(await screen.findByTitle('Email preview')).toHaveAttribute(
      'src',
      expect.stringContaining('/api/v1/test-inbox/e2/html'),
    );
    expect(await screen.findByText('Delivery')).toBeInTheDocument();
  });

  it('sends a copy to me with the token, and reads the account email from the session', async () => {
    let sent = 0;
    location.hash = '#e1';
    const { fetchMock } = await renderApp(
      '/workbench/o/nw/inbox',
      setup([email()], {
        '/api/v1/test-inbox/e1/send-to-me': () => {
          sent++;
          return json({ to: 'me@example.com' });
        },
      }),
    );
    const button = await screen.findByRole('button', { name: 'Send to me' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(sent).toBe(1));
    const [post] = callsTo(fetchMock, (p) => p.endsWith('/send-to-me'));
    expect(headersOf(post?.init).authorization).toBe('Bearer pbtry_nw');
    expect(Object.keys(headersOf(post?.init)).some((h) => /mode/i.test(h))).toBe(false);
    for (const { init } of callsTo(fetchMock, (p) => p === '/api/v1/me/emails'))
      expect(headersOf(init).authorization).toBeUndefined();
  });
});
