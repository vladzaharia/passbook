import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';

const broadcast = (over: Partial<BroadcastDto> = {}): BroadcastDto => ({
  id: 'b1',
  orgId: 'o1',
  mode: 'live',
  kind: 'message',
  name: 'Doors open late',
  state: 'sent',
  target: { templateIds: ['t1'] },
  patch: { message: 'Doors open at 8.' },
  notify: true,
  at: null,
  clearAfter: null,
  parentId: null,
  followUp: null,
  counts: { targeted: 2, updated: 2, unchanged: 0, overBudget: 0, failed: 0 },
  errorCode: null,
  createdAt: Date.now() - 60_000,
  startedAt: Date.now() - 60_000,
  finishedAt: Date.now() - 30_000,
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

const modeOf = (calls: unknown[][], path: string) => {
  const call = calls.find(([u]) => String(u).startsWith(path));
  return ((call?.[1] as RequestInit | undefined)?.headers as Record<string, string>)?.[
    'x-passbook-mode'
  ];
};

describe('Messages in Test mode', () => {
  it('lists with the Test header and marks test messages', async () => {
    setMode('test');
    const { container, fetchMock } = await renderApp('/admin/messages', {
      session: 'admin',
      handlers: {
        '/api/v1/broadcasts': () =>
          json({ items: [broadcast({ mode: 'test' })], nextCursor: null }),
      },
    });
    expect(await screen.findByText('Doors open late')).toBeInTheDocument();
    expect(modeOf(fetchMock.mock.calls, '/api/v1/broadcasts')).toBe('test');
    expect(screen.getByRole('button', { name: /^Test\. Test mode/ })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('sends no header live, and a live message has no Test pill', async () => {
    const { fetchMock } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: { '/api/v1/broadcasts/b1': () => json(broadcast()) },
    });
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    expect(modeOf(fetchMock.mock.calls, '/api/v1/broadcasts/b1')).toBeUndefined();
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
  });

  it('badges a test message opened in live mode', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: { '/api/v1/broadcasts/b1': () => json(broadcast({ mode: 'test' })) },
    });
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();
  });
});
