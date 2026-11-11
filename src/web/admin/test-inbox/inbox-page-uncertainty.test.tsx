import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setMode } from '@/web/lib/mode.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import {
  deferredResponse,
  detail,
  enabledSendButton,
  handlers,
  orgAccess,
  setupInboxTest,
} from './inbox-page-test-fixtures.ts';

setupInboxTest();

describe('Test inbox', () => {
  it.each([
    ['server error', 'none'],
    ['network error', 'none'],
    ['server error', 'failed'],
    ['network error', 'failed'],
  ])(
    'keeps an ambiguous %s fenced after %s across refresh and reopening',
    async (failure, initial) => {
      setMode('test');
      const user = userEvent.setup();
      const response = deferredResponse();
      let forwarding = initial;
      let reads = 0;
      let sends = 0;
      const inboxHandlers = {
        ...handlers,
        '/api/v1/test-inbox/e1': () => {
          reads++;
          return json(detail(forwarding));
        },
        '/api/v1/test-inbox/e1/send-to-me': () => {
          sends++;
          return response.promise;
        },
      };
      const { unmount } = await renderApp('/admin/test-inbox?email=e1', {
        session: 'admin',
        ...orgAccess,
        handlers: inboxHandlers,
      });
      await user.click(await enabledSendButton());
      expect(await screen.findByText('Sending copy')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Close' }));
      await user.click(await screen.findByRole('link', { name: 'Open Your Gym pass' }));
      expect(await screen.findByText('Sending copy')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
      await act(async () => {
        if (failure === 'network error') response.reject(new TypeError('Disconnected'));
        else response.resolve(problem(503, 'FORWARD_FAILED', 'The send request failed.'));
      });
      expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
      const beforeRefresh = reads;
      await user.click(screen.getByRole('button', { name: 'Refresh status' }));
      await waitFor(() => expect(reads).toBeGreaterThan(beforeRefresh));
      expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Close' }));
      await user.click(await screen.findByRole('link', { name: 'Open Your Gym pass' }));
      expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
      expect(sends).toBe(1);

      forwarding = 'failed';
      const beforeFailed = reads;
      await user.click(screen.getByRole('button', { name: 'Refresh status' }));
      await waitFor(() => expect(reads).toBeGreaterThan(beforeFailed));
      expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
      unmount();
      await renderApp('/admin/test-inbox?email=e1', {
        session: 'admin',
        ...orgAccess,
        handlers: inboxHandlers,
      });
      expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
      expect(sends).toBe(1);
    },
  );

  it('keeps an ambiguous outcome fenced in the tab when storage is blocked', async () => {
    setMode('test');
    const blocked = () => {
      throw new Error('Storage blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    const user = userEvent.setup();
    let sends = 0;
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1/send-to-me': () => {
          sends++;
          return problem(503, 'FORWARD_FAILED', 'The send request failed.');
        },
      },
    });
    await user.click(await enabledSendButton());
    expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(await screen.findByRole('link', { name: 'Open Your Gym pass' }));
    expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
    expect(sends).toBe(1);
  });

  it.each([
    ['sending', 'Copy pending'],
    ['unknown', 'Delivery outcome unknown'],
  ])('does not retry a failed request with a %s reservation', async (outcome, title) => {
    setMode('test');
    const user = userEvent.setup();
    let forwarding = 'none';
    let sends = 0;
    const { queryClient } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1': () => json(detail(forwarding)),
        '/api/v1/test-inbox/e1/send-to-me': () => {
          sends++;
          forwarding = outcome;
          return problem(503, 'FORWARD_FAILED', 'The send request failed.');
        },
      },
    });
    await enabledSendButton();
    queryClient.setDefaultOptions({
      ...queryClient.getDefaultOptions(),
      mutations: { retry: 3, retryDelay: 0 },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['test-inbox', 'detail', 'e1'] });
    });
    await user.click(await enabledSendButton());
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(sends).toBe(1);
    expect(screen.queryByText(/admin@example\.com/)).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Send to me' });
    expect(button).toBeDisabled();
    await user.click(button);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['test-inbox', 'detail', 'e1'] });
    });
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(sends).toBe(1);
  });
});
