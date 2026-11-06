import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { AppProviders } from '@/web/lib/providers.tsx';
import { createQueryClient } from '@/web/lib/query-client.ts';
import { type FetchHandler, json, sessionFixture, stubFetch } from '@/web/lib/test-utils.tsx';
import { PairingFace } from './pairing-face.tsx';
import { pairingFixture } from './test-fixtures.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function renderFace(handlers: Record<string, FetchHandler>, onClose = vi.fn()) {
  const fetchMock = stubFetch({
    '/api/v1/session': () => json(sessionFixture('admin')),
    ...handlers,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const utils = render(
    <AppProviders queryClient={queryClient}>
      <PairingFace
        scanner={{ id: 's1', name: 'Front door', mode: 'live' }}
        pairing={pairingFixture({ expiresAt: Date.now() + 582_000 })}
        onClose={onClose}
        pollMs={20}
      />
    </AppProviders>,
  );
  return { ...utils, fetchMock, onClose };
}

const polls = (m: ReturnType<typeof stubFetch>) =>
  m.mock.calls.filter(([u]) => String(u).endsWith('/s1/pairing')).length;

afterEach(() => vi.restoreAllMocks());

describe('pairing face', () => {
  it('shows the code, the host, the Home Screen line and a countdown outside the live region', async () => {
    const { container } = renderFace({
      '/api/v1/scanners/s1/pairing': () => json({ state: 'waiting', device: null }),
    });
    expect(screen.getByText('K7QH2-M9XTR')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Open ${window.location.host}/scan`))).toBeInTheDocument();
    expect(screen.getByText('Using the Home Screen app? Pair inside it.')).toBeInTheDocument();
    const countdown = screen.getByText(/^Expires in \d:\d\d$/);
    expect(countdown.closest('[role="status"]')).toBeNull();
    expect(screen.getByText('Waiting for the scanner…').closest('[role="status"]')).not.toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('polls until the scanner pairs, then stops and waves once', async () => {
    let n = 0;
    const { fetchMock, container } = renderFace({
      '/api/v1/scanners/s1/pairing': () =>
        json(
          ++n < 3
            ? { state: 'waiting', device: null }
            : { state: 'paired', device: { label: 'Safari on iPhone', at: Date.now() } },
        ),
    });
    expect(await screen.findByText('Safari on iPhone · Paired just now')).toBeInTheDocument();
    expect(screen.getByText('Front door is paired')).toBeInTheDocument();
    const buddy = container.querySelector('[data-buddy]');
    expect(buddy).toHaveAttribute('data-scene', 'wave');
    const seen = polls(fetchMock);
    await sleep(150);
    expect(polls(fetchMock)).toBe(seen);
    expect(container.querySelectorAll('[data-scene="wave"]')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Pair this browser' })).toBeNull();
  });

  it('stops polling while the tab is hidden', async () => {
    const { fetchMock } = renderFace({
      '/api/v1/scanners/s1/pairing': () => json({ state: 'waiting', device: null }),
    });
    await waitFor(() => expect(polls(fetchMock)).toBeGreaterThan(1));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await sleep(60);
    const seen = polls(fetchMock);
    await sleep(150);
    expect(polls(fetchMock)).toBe(seen);
  });

  it('droops when the code expires, and New code replaces it', async () => {
    const { container, fetchMock } = renderFace({
      '/api/v1/scanners/s1/pairing': (_url, init) =>
        init?.method === 'POST'
          ? json(pairingFixture({ code: 'ABCDE12345' }))
          : json({ state: 'expired', device: null }),
    });
    expect(await screen.findByText('Code expired.')).toBeInTheDocument();
    expect(container.querySelector('[data-buddy] [data-state="expired"]')).not.toBeNull();
    expect(container.querySelector('.wl-add-scan')).toHaveAttribute('data-dim');
    expect(screen.queryByText(/^Expires in/)).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'New code' }));
    expect(await screen.findByText('ABCDE-12345')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) => String(u).endsWith('/s1/pairing') && i?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('pairs this browser without ever sending the code', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let posted = false;
    renderFace({
      '/api/v1/scanners/s1/pairing': () => json({ state: 'waiting', device: null }),
      '/api/v1/scanners/s1/pair-here': (_url, init) => {
        posted = init?.method === 'POST';
        return new Response(null, { status: 204 });
      },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pair this browser' }));
    await waitFor(() => expect(posted).toBe(true));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(`${window.location.origin}/scan`, '_blank', 'noopener'),
    );
  });
});
