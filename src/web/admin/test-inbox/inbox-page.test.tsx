import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';

const email = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  orgId: 'o1',
  kind: 'pass',
  passId: 'p1',
  bundleId: null,
  to: 'holder@example.com',
  subject: 'Your Gym pass',
  attached: false,
  createdAt: Date.now() - 3_600_000,
  ...over,
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

const handlers = {
  '/api/v1/test-inbox': () => json({ items: [email()], nextCursor: null }),
  '/api/v1/test-inbox/e1': () =>
    json({ ...email(), html: '<p>Hi</p>', text: 'Hi there from the pass email.' }),
};

describe('Test inbox', () => {
  it('asks to turn Test mode on, and does so', async () => {
    const { fetchMock } = await renderApp('/admin/test-inbox', { session: 'admin', handlers });
    expect(await screen.findByText('Test mode is off')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/v1/test-inbox'))).toBe(
      false,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn on Test mode' }));
    expect(await screen.findByText('Your Gym pass')).toBeInTheDocument();
  });

  it('lists mail with the Test header and opens a sandboxed preview', async () => {
    setMode('test');
    const { container, fetchMock } = await renderApp('/admin/test-inbox', {
      session: 'admin',
      handlers,
    });
    expect(await screen.findByText('Your Gym pass')).toBeInTheDocument();
    const listCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/v1/test-inbox'));
    const headers = (listCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['x-passbook-mode']).toBe('test');
    expect(screen.getByText(/To holder@example.com/)).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Open Your Gym pass' }));
    const frame = await screen.findByTitle('Email preview');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('src', '/api/v1/test-inbox/e1/html');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).not.toHaveAttribute('srcdoc');
    expect(frame.style.colorScheme).toBe('light');
    expect(screen.getByRole('link', { name: 'A pass' })).toHaveAttribute(
      'href',
      '/admin/passes/p1',
    );
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Text' }));
    expect(screen.getByText('Hi there from the pass email.')).toBeInTheDocument();
  });

  it('sends the message to the signed-in admin', async () => {
    setMode('test');
    const sent: string[] = [];
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1/send-to-me': (_u, init) => {
          sent.push(String(init?.method));
          return json({ to: 'me@example.com' });
        },
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Send to me' }));
    await waitFor(() => expect(sent).toEqual(['POST']));
    expect(await screen.findByText('Sent to me@example.com')).toBeInTheDocument();
  });

  it('offers Account when the admin has no verified address', async () => {
    setMode('test');
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1/send-to-me': () =>
          problem(422, 'NO_VERIFIED_EMAIL', 'Verify your email address first.'),
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Send to me' }));
    expect(await screen.findByText('Verify your email address first.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account');
  });

  it('says so when nothing was captured', async () => {
    setMode('test');
    await renderApp('/admin/test-inbox', {
      session: 'admin',
      handlers: { '/api/v1/test-inbox': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No test emails yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New pass' })).toHaveAttribute(
      'href',
      '/admin/passes/new',
    );
  });
});
