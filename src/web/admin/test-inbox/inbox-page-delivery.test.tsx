import { onlineManager } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setMode } from '@/web/lib/mode.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import {
  deferredResponse,
  detail,
  enabledSendButton,
  handlers,
  orgAccess,
  sendRequests,
  setupInboxTest,
} from './inbox-page-test-fixtures.ts';

setupInboxTest();

describe('Test inbox', () => {
  it.each([
    ['sending', 'Copy pending'],
    ['sent', 'Copy accepted by email provider'],
    ['unknown', 'Delivery outcome unknown'],
  ])('disables sending for a persisted %s outcome', async (forwarding, title) => {
    setMode('test');
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1': () => json(detail(forwarding)),
      },
    });
    expect(await screen.findByText(title)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Send to me' });
    expect(button).toBeDisabled();
    expect(screen.queryByText(/admin@example\.com/)).not.toBeInTheDocument();
    await user.click(button);
    expect(sendRequests(fetchMock)).toHaveLength(0);
  });

  it('waits for provider acknowledgement and refreshes the saved state', async () => {
    setMode('test');
    const user = userEvent.setup();
    let forwarding = 'none';
    let reads = 0;
    let sends = 0;
    const response = deferredResponse();
    const { fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1': () => {
          reads++;
          return json(detail(forwarding));
        },
        '/api/v1/test-inbox/e1/send-to-me': () => {
          sends++;
          return response.promise;
        },
      },
    });
    const button = await enabledSendButton();
    await user.click(button);
    await waitFor(() => expect(sends).toBe(1));
    const sent = fetchMock.mock.calls.find(([u]) =>
      new URL(String(u), 'http://localhost').pathname.endsWith('/send-to-me'),
    );
    expect(new URL(String(sent?.[0]), 'http://localhost').searchParams.get('orgId')).toBe('o1');
    expect((sent?.[1]?.headers as Record<string, string> | undefined)?.['x-passbook-mode']).toBe(
      'test',
    );
    expect(sent?.[1]?.body).toBeUndefined();
    expect(await screen.findByText('Sending copy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
    expect(screen.queryByText(/admin@example\.com/)).not.toBeInTheDocument();
    forwarding = 'sent';
    await act(async () => response.resolve(json({ to: 'admin@example.com' })));
    expect(
      await screen.findByText(/provider accepted a copy for admin@example\.com/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(sends).toBe(1);
  });

  it.each([
    ['none', 'Send request failed', 422, 'NO_VERIFIED_EMAIL'],
    ['none', 'Send request failed', 422, 'NOT_A_USER'],
    ['none', 'Send request failed', 409, 'TEST_FORWARD_CHANGED'],
    ['none', 'Send request failed', 429, 'RATE_LIMITED'],
    ['none', 'Send request failed', 503, 'RATE_LIMIT_UNAVAILABLE'],
    ['failed', 'Copy not sent', 429, 'RATE_LIMITED'],
    ['failed', 'Copy not sent', 503, 'TEST_FORWARD_PREPARATION_FAILED'],
  ] as const)(
    'allows a manual retry for definitive failure with state %s',
    async (outcome, title, status, code) => {
      setMode('test');
      const user = userEvent.setup();
      let forwarding = 'none';
      let sends = 0;
      await renderApp('/admin/test-inbox?email=e1', {
        session: 'admin',
        ...orgAccess,
        handlers: {
          ...handlers,
          '/api/v1/test-inbox/e1': () => json(detail(forwarding)),
          '/api/v1/test-inbox/e1/send-to-me': () => {
            sends++;
            forwarding = sends === 1 ? outcome : 'sent';
            if (sends !== 1) return json({ to: 'admin@example.com' });
            return problem(status, code, 'The send request failed.');
          },
        },
      });
      await user.click(await enabledSendButton());
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(sends).toBe(1);
      expect(screen.queryByText(/admin@example\.com/)).not.toBeInTheDocument();
      const button = screen.getByRole('button', { name: 'Send to me' });
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      expect(
        await screen.findByText(/provider accepted a copy for admin@example\.com/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
      expect(sends).toBe(2);
    },
  );

  it('waits for a durable failed state after a definite preparation failure', async () => {
    setMode('test');
    const user = userEvent.setup();
    let forwarding = 'none';
    let sends = 0;
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1': () => json(detail(forwarding)),
        '/api/v1/test-inbox/e1/send-to-me': () => {
          sends++;
          return problem(503, 'TEST_FORWARD_PREPARATION_FAILED', 'The request failed.');
        },
      },
    });
    await user.click(await enabledSendButton());
    expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
    expect(screen.getByText(/failed before contacting the provider/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
    forwarding = 'failed';
    await user.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(await screen.findByText('Copy not sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeEnabled();
    expect(sends).toBe(1);
  });

  it('keeps an acknowledged send fenced after reopening with stale detail', async () => {
    setMode('test');
    const user = userEvent.setup();
    let sends = 0;
    const inboxHandlers = {
      ...handlers,
      '/api/v1/test-inbox/e1/send-to-me': () => {
        sends++;
        return json({ to: 'admin@example.com' });
      },
    };
    const { unmount } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: inboxHandlers,
    });
    await user.click(await enabledSendButton());
    expect(
      await screen.findByText(/provider accepted a copy for admin@example\.com/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
    unmount();
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: inboxHandlers,
    });
    expect(await screen.findByText('Copy accepted by email provider')).toBeInTheDocument();
    expect(screen.getByText(/saved forwarding status is not confirmed/i)).toBeInTheDocument();
    expect(screen.queryByText(/admin@example\.com/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
    expect(sends).toBe(1);
  });

  it.each([false, true])('reloads only after refresh fails, offline: %s', async (offline) => {
    setMode('test');
    const user = userEvent.setup();
    let reads = 0;
    let sends = 0;
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1': () => {
          reads++;
          return reads === 2
            ? problem(503, 'UNAVAILABLE', 'Could not load email.')
            : json(detail(reads === 1 ? 'none' : 'unknown'));
        },
        '/api/v1/test-inbox/e1/send-to-me': () => {
          sends++;
          return problem(503, 'FORWARD_FAILED', 'The send request failed.');
        },
      },
    });
    const button = await enabledSendButton();
    const wasOnline = onlineManager.isOnline();
    if (offline) onlineManager.setOnline(false);
    try {
      await user.click(button);
      const reload = await screen.findByRole('button', { name: 'Reload email' });
      expect(await screen.findByText(/Reloading checks this email/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send to me' })).not.toBeInTheDocument();
      await user.click(reload);
      expect(await screen.findByText('Delivery outcome unknown')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
      expect(sends).toBe(1);
    } finally {
      if (offline) onlineManager.setOnline(wasOnline);
    }
  });
});
