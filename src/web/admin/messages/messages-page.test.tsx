import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { broadcast } from './test-fixtures.ts';

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
