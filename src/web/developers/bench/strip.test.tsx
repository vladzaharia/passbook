import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripModel } from './strip.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => vi.resetModules());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const route = (table: Record<string, () => Response>) => {
  const fetchMock = vi.fn(async (url: string) => table[url]?.() ?? json({}, 404));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const signedIn = {
  '/api/v1/session': () => json({ authenticated: true, csrfToken: 'c', roles: ['developer'] }),
  '/api/v1/developer/sandbox': () =>
    json({ sandbox: { id: 's', orgId: 'org-1', orgSlug: 'acme-dev' } }),
  '/api/v1/developer/rail': () =>
    json({ mode: 'test', key: { id: 'k1', name: 'Default', prefix: 'pbp_test_PB8a' } }),
};

describe('what the strip knows', () => {
  it('reads the key in use on every tool but the console, which never holds one', async () => {
    route(signedIn);
    const { stripModel } = await import('./strip.tsx');
    expect(await stripModel('logs')).toEqual({
      kind: 'ready',
      slug: 'acme-dev',
      orgId: 'org-1',
      mode: 'test',
      key: { id: 'k1', name: 'Default', prefix: 'pbp_test_PB8a' },
    });
    vi.resetModules();
    const fetchMock = route(signedIn);
    const again = await import('./strip.tsx');
    expect((await again.stripModel('console')) as StripModel).toMatchObject({ key: null });
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain('/api/v1/developer/rail');
  });

  it('shows nothing signed out, and the way to a sandbox without one', async () => {
    route({ '/api/v1/session': () => json({ authenticated: false }) });
    const { stripModel } = await import('./strip.tsx');
    expect(await stripModel('keys')).toEqual({ kind: 'hidden' });
    vi.resetModules();
    route({ ...signedIn, '/api/v1/developer/sandbox': () => json({ sandbox: null }) });
    expect(await (await import('./strip.tsx')).stripModel('keys')).toEqual({ kind: 'none' });
  });
});

describe('the context strip', () => {
  const ready: StripModel = {
    kind: 'ready',
    slug: 'acme-dev',
    orgId: 'org-1',
    mode: 'test',
    key: { id: 'k1', name: 'Default', prefix: 'pbp_test_PB8a' },
  };

  it('says Test, the sandbox and the key in use', async () => {
    const { ContextStrip } = await import('./strip.tsx');
    render(<ContextStrip tool="logs" model={ready} />);
    for (const text of ['Test', 'acme-dev', 'Default', 'pbp_test_PB8a…'])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Default/ }).getAttribute('href')).toBe(
      '/developers/logs?key=k1',
    );
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('on the console: Run here and the Run budget instead of a key', async () => {
    const { ContextStrip } = await import('./strip.tsx');
    render(<ContextStrip tool="console" model={{ ...ready, key: null }} />);
    expect(screen.getByText('Run here').getAttribute('title')).toMatch(/short-lived token/);
    expect(screen.getByRole('meter', { name: 'Runs left this minute' })).toBeTruthy();
  });

  it('says Live with a live key, and draws nothing signed out', async () => {
    const { ContextStrip } = await import('./strip.tsx');
    const { container, rerender } = render(
      <ContextStrip tool="keys" model={{ ...ready, mode: 'live' }} />,
    );
    expect(screen.getByText('Live').className).toContain('accent');
    rerender(<ContextStrip tool="keys" model={{ kind: 'hidden' }} />);
    expect(container.textContent).toBe('');
  });
});
