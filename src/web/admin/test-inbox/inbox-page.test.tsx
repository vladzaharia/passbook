import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { CapturedEmailDetailSchema, CapturedEmailListSchema } from '@/shared/contracts/sandbox.ts';
import { setMode } from '@/web/lib/mode.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import {
  detail,
  email,
  handlers,
  orgAccess,
  reader,
  setupInboxTest,
} from './inbox-page-test-fixtures.ts';

setupInboxTest();

describe('Test inbox', () => {
  it('asks to turn Test mode on, and does so', async () => {
    const { fetchMock } = await renderApp('/admin/test-inbox', {
      session: 'admin',
      ...orgAccess,
      handlers,
    });
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
      ...orgAccess,
      handlers,
    });
    expect(await screen.findByText('Your Gym pass')).toBeInTheDocument();
    expect(screen.getByText(/captured here instead of being sent/i)).toBeInTheDocument();
    expect(screen.getByText(/send a copy to your verified account email/i)).toBeInTheDocument();
    const listCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/v1/test-inbox'));
    expect(new URL(String(listCall?.[0]), 'http://localhost').searchParams.get('orgId')).toBe('o1');
    const headers = (listCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['x-passbook-mode']).toBe('test');
    expect(screen.getByText(/To holder@example.com/)).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Open Your Gym pass' }));
    const frame = await screen.findByTitle('Email preview');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('src', '/api/v1/test-inbox/e1/html?orgId=o1&mode=test');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).not.toHaveAttribute('srcdoc');
    expect(frame.style.colorScheme).toBe('light');
    expect(screen.getByRole('link', { name: 'A pass' })).toHaveAttribute(
      'href',
      '/admin/passes/p1?orgId=o1',
    );
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Text' }));
    const detailCall = fetchMock.mock.calls.find(
      ([u]) => new URL(String(u), 'http://localhost').pathname === '/api/v1/test-inbox/e1',
    );
    expect(new URL(String(detailCall?.[0]), 'http://localhost').searchParams.get('orgId')).toBe(
      'o1',
    );
    expect(
      (detailCall?.[1]?.headers as Record<string, string> | undefined)?.['x-passbook-mode'],
    ).toBe('test');
    expect(screen.getByText('Hi there from the pass email.')).toBeInTheDocument();
  });

  it('keeps content and the status region mounted while its capture is revalidated, holding Send', async () => {
    setMode('test');
    let calls = 0;
    const { queryClient } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1': () => {
          calls++;
          return calls === 1 ? json(detail()) : new Promise<Response>(() => {});
        },
      },
    });
    await userEvent.setup().click(await screen.findByRole('radio', { name: 'Text' }));
    expect(screen.getByText('Hi there from the pass email.')).toBeInTheDocument();
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['test-inbox', 'detail', 'e1'] });
    });
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByText('Hi there from the pass email.')).toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toBe(live);
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
  });

  it('requires the forwarding state only on details and strips sensitive list additions', () => {
    const summary = email();
    const content = { ...summary, html: '<p>Hi</p>', text: 'Hi' };
    expect(CapturedEmailDetailSchema.safeParse(content).success).toBe(false);
    for (const forwarding of ['none', 'sending', 'sent', 'failed', 'unknown']) {
      expect(CapturedEmailDetailSchema.parse({ ...content, forwarding }).forwarding).toBe(
        forwarding,
      );
    }
    expect(
      CapturedEmailDetailSchema.safeParse({ ...content, forwarding: 'retrying' }).success,
    ).toBe(false);
    const list = CapturedEmailListSchema.parse({
      items: [
        {
          ...content,
          forwarding: 'sent',
          forwardingTo: 'admin@example.com',
          capabilityUrl: 'https://example.com/secret',
        },
      ],
      nextCursor: null,
    });
    expect(list.items).toEqual([summary]);
  });

  it('says so when nothing was captured', async () => {
    setMode('test');
    await renderApp('/admin/test-inbox', {
      session: 'admin',
      ...orgAccess,
      handlers: { '/api/v1/test-inbox': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No test emails yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New pass' })).toHaveAttribute(
      'href',
      '/admin/passes/new?orgId=o1',
    );
  });

  it('does not offer pass creation to a reader with an empty inbox', async () => {
    setMode('test');
    await renderApp('/admin/test-inbox', {
      session: 'admin',
      memberships: [reader],
      selectedOrg: 'o1',
      handlers: { '/api/v1/test-inbox': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No test emails yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New pass' })).not.toBeInTheDocument();
  });
});
