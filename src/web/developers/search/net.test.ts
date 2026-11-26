import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../workbench/console/session.ts';

const loadSession = vi.fn<() => Promise<Session>>();
vi.mock('../../workbench/console/session.ts', () => ({ loadSession: () => loadSession() }));

afterEach(() => {
  loadSession.mockReset();
  vi.unstubAllGlobals();
});

describe('codeActivity', () => {
  it.each([
    { kind: 'out' },
    { kind: 'none', csrf: 'c', siteKey: '' },
    { kind: 'closed', csrf: 'c', siteKey: '' },
  ] as Session[])('makes no logs call with the session $kind', async (session) => {
    loadSession.mockResolvedValue(session);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { codeActivity } = await import('./net.ts');
    expect(await codeActivity('UNSAFE_URL')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the log when the sandbox is ready', async () => {
    loadSession.mockResolvedValue({
      kind: 'ready',
      csrf: 'c',
      siteKey: '',
      sandbox: { id: 's', orgId: 'org-1', orgSlug: 'o', templateId: null },
    });
    const fetchMock = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    const { codeActivity } = await import('./net.ts');
    expect(await codeActivity('UNSAFE_URL')).toEqual({ count: 0, more: false, lastAt: null });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
