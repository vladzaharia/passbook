import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGS_COPY, RAIL_COPY } from '../../../shared/copy/developers-ops.ts';
import type { Session } from '../console/session.ts';

const loadSession = vi.fn<() => Promise<Session>>();
vi.mock('../console/session.ts', () => ({ loadSession: () => loadSession() }));
vi.mock('./island.ts', () => ({ mountLogs: vi.fn() }));
vi.mock('./rail.ts', () => ({ mountRail: vi.fn() }));
vi.mock('./ops.ts', () => ({ loadOps: vi.fn() }));

afterEach(() => {
  document.body.innerHTML = '';
  loadSession.mockReset();
  vi.unstubAllGlobals();
});

async function mountBoth(session: Session) {
  loadSession.mockResolvedValue(session);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const { logsIsland, railIsland } = await import('./entry.ts');
  const list = document.createElement('div');
  const rail = document.createElement('div');
  document.body.append(list, rail);
  await logsIsland.mount(list);
  await railIsland.mount(rail);
  return { list, rail, fetchMock };
}

describe('the logs islands are gated on the session', () => {
  it('says "No sandbox yet" once: the card stays, the rail goes, and nothing is called', async () => {
    const { list, rail, fetchMock } = await mountBoth({ kind: 'none', csrf: 'c', siteKey: '' });
    expect(list.textContent).toContain(LOGS_COPY.noSandbox);
    expect(list.querySelector('a.btn')?.textContent).toBe(LOGS_COPY.create);
    expect(rail.isConnected).toBe(false);
    expect(document.body.textContent?.match(/No sandbox yet/g)).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says a closed sandbox is closed, with no Create link', async () => {
    const { list, rail } = await mountBoth({ kind: 'closed', csrf: 'c', siteKey: '' });
    expect(rail.isConnected).toBe(false);
    expect(list.textContent).toContain(LOGS_COPY.closed);
    expect(list.querySelector('a.btn')).toBeNull();
  });

  it('shows an error with Retry, and the rail says it could not load', async () => {
    const { list, rail } = await mountBoth({ kind: 'failed', csrf: 'c' });
    expect(list.textContent).toContain(LOGS_COPY.notLoaded);
    expect(list.querySelector('button')?.textContent).toBe('Retry');
    expect(rail.textContent).toContain(RAIL_COPY.failed);
  });

  it('leaves the prerendered sign-in state when signed out', async () => {
    const { list, rail } = await mountBoth({ kind: 'out' });
    expect(list.childElementCount).toBe(0);
    expect(rail.childElementCount).toBe(0);
  });
});
