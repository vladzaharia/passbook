import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATION_STARTED, watchBusy } from './chip-busy.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const active = (...kinds: string[]) =>
  vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify({ items: kinds.map((kind) => ({ kind })) }), { status: 200 }),
  );
const chip = () => {
  const node = document.createElement('details');
  document.body.append(node);
  return node;
};

describe('the sandbox chip while an operation runs', () => {
  it('rings while one of the person’s sandbox operations is active', async () => {
    const fetchMock = active('sandbox.delete');
    vi.stubGlobal('fetch', fetchMock);
    const node = chip();
    watchBusy(node);
    await vi.waitFor(() => expect(node.dataset.busy).toBe('true'));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/operations?active=true&mine=true');
  });

  it('stays quiet for another kind, and for nothing running', async () => {
    vi.stubGlobal('fetch', active('pass.bulk'));
    const node = chip();
    watchBusy(node);
    await vi.waitFor(() => expect(node.dataset.busy).toBe('false'));
    vi.stubGlobal('fetch', active());
    window.dispatchEvent(new Event(OPERATION_STARTED));
    await vi.waitFor(() => expect(node.dataset.busy).toBe('false'));
  });

  it('looks again when the page starts one', async () => {
    vi.stubGlobal('fetch', active());
    const node = chip();
    watchBusy(node);
    await vi.waitFor(() => expect(node.dataset.busy).toBe('false'));
    vi.stubGlobal('fetch', active('sandbox.recreate'));
    window.dispatchEvent(new Event(OPERATION_STARTED));
    await vi.waitFor(() => expect(node.dataset.busy).toBe('true'));
  });

  it('keeps the last state when the lookup fails', async () => {
    vi.stubGlobal('fetch', async () => Promise.reject(new TypeError('offline')));
    const node = chip();
    watchBusy(node);
    await vi.waitFor(() => expect(node.dataset.busy).toBe('false'));
  });
});
