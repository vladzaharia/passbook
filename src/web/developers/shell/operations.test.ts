import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISLANDS } from './islands.ts';
import { operationsIsland } from './operations.ts';

const mountTray = vi.hoisted(() => vi.fn());
vi.mock('./operations-island.tsx', () => ({ mountTray }));

const session = (body: unknown, ok = true) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  mountTray.mockClear();
});

describe('the operations island', () => {
  it('is registered for the bar slot', () => {
    expect(ISLANDS.operations).toBeTypeOf('function');
  });

  it('mounts the tray with the session write token for a signed-in reader', async () => {
    session({ authenticated: true, csrfToken: 'tok' });
    const el = document.createElement('span');
    await operationsIsland.mount(el);
    expect(mountTray).toHaveBeenCalledWith(el, 'tok');
  });

  it.each([
    ['signed out', { authenticated: false }, true],
    ['no token', { authenticated: true }, true],
    ['a failed session read', {}, false],
  ])('loads nothing when %s', async (_name, body, ok) => {
    session(body, ok);
    await operationsIsland.mount(document.createElement('span'));
    expect(mountTray).not.toHaveBeenCalled();
  });

  it('loads nothing when the session cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await operationsIsland.mount(document.createElement('span'));
    expect(mountTray).not.toHaveBeenCalled();
  });
});
