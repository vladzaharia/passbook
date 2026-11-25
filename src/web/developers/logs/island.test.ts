import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountLogs } from './island.ts';

const entry = (id: string) => ({
  id,
  requestId: `req-${id}`,
  at: Date.now(),
  method: 'POST',
  route: '/api/v1/passes',
  path: '/api/v1/passes',
  query: null,
  status: 409,
  code: 'PASS_CONFLICT',
  durationMs: 12,
  keyId: null,
  mode: 'test',
  via: null,
  hasBodies: false,
});

/** The log API: a page of `listed` rows, and `old` reachable only by id. */
function stub(listed: string[], old: string[] = []) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      urls.push(input);
      const [path = '', query = ''] = input.split('?');
      const ok = (body: unknown) => Response.json(body);
      if (path === '/api/v1/developer/logs')
        return ok({
          items: listed.map(entry),
          nextCursor: null,
          capped: null,
          ...(query.includes('code=') ? { items: [] } : {}),
        });
      const id = path.split('/').pop() ?? '';
      if (listed.includes(id) || old.includes(id))
        return ok({ ...entry(id), requestBody: null, responseBody: null, bodiesExpireAt: null });
      return new Response('{}', { status: 404 });
    }),
  );
  return urls;
}

const mount = async () => {
  const el = document.createElement('div');
  document.body.append(el);
  await mountLogs(el, Promise.resolve({}));
  return el;
};
const rowOf = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLDetailsElement>(`details[data-id="${id}"]`);

beforeEach(() => {
  document.body.replaceChildren();
  window.location.hash = '';
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => vi.unstubAllGlobals());

describe('the log opened from search', () => {
  it('opens the row a link names, from the list', async () => {
    stub(['a', 'b']);
    window.location.hash = '#b';
    const el = await mount();
    await vi.waitFor(() => expect(rowOf(el, 'b')?.open).toBe(true));
    expect(rowOf(el, 'a')?.open).toBe(false);
  });

  it('fetches a row older than the page and pins it on top', async () => {
    const urls = stub(['a', 'b'], ['old']);
    window.location.hash = '#old';
    const el = await mount();
    await vi.waitFor(() => expect(rowOf(el, 'old')?.open).toBe(true));
    expect(urls).toContain('/api/v1/developer/logs/old');
    expect(el.querySelector('details[data-id]')?.getAttribute('data-id')).toBe('old');
  });

  it('shows the list as it is when the id is not the caller’s', async () => {
    const urls = stub(['a']);
    window.location.hash = '#nope';
    const el = await mount();
    await vi.waitFor(() => expect(urls).toContain('/api/v1/developer/logs/nope'));
    expect(el.querySelectorAll('details[data-id]')).toHaveLength(1);
    expect(rowOf(el, 'a')?.open).toBe(false);
  });

  it('filters by the code a link names', async () => {
    const urls = stub(['a']);
    window.location.hash = '#code=pass_conflict';
    const el = await mount();
    expect(el.querySelector<HTMLSelectElement>('select[name="code"]')?.value).toBe('PASS_CONFLICT');
    // The first read already carries it: no second read for the same filter.
    expect(urls[0]).toContain('code=PASS_CONFLICT');
    expect(urls.filter((u) => u.includes('code=PASS_CONFLICT'))).toHaveLength(1);
  });

  it('opens the list as it is on a hash that does not decode', async () => {
    const urls = stub(['a']);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    window.location.hash = '#%E0';
    const el = await mount();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((done) => setTimeout(done, 50));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(el.querySelectorAll('details[data-id]')).toHaveLength(1);
    expect(urls.some((u) => u.includes('%E0'))).toBe(false);
  });
});
