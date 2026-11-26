import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATHS } from '../../../shared/developers.ts';
import { installDomShims } from '../../lib/test-utils.tsx';
import type { Session } from '../console/session.ts';
import { loadInputs } from '../model/load.ts';
import { buildSite } from '../model/site.ts';
import { buildSearchIndex } from './build.ts';
import * as nav from './nav.ts';
import type { SearchIndex } from './types.ts';

const DEMO = 'pb_test_demo_demo_demo_demo';

vi.mock('./nav.ts', () => ({ goTo: vi.fn(), openTab: vi.fn() }));
// The sandbox's count is read only with a sandbox: signed out (the default here) nothing is asked.
let session: Session = { kind: 'out' };
vi.mock('../console/session.ts', () => ({ loadSession: async () => session }));

const root = resolve(import.meta.dirname, '../../../..');
const INDEX = buildSearchIndex(buildSite(loadInputs(root)));
const SECRETS = [
  'pb_test_9fK2xQ7mLp3sD8vA9fK2',
  'pb_live_ab12cd_9fK2xQ7mLp3sD8vA',
  'pbp_test_9fK2xQ7mLp3sD8vA',
  'pbo_9fK2xQ7mLp3sD8vA',
  'pbtry_eyJ2MTprZXk6c2Vz.9fK2xQ7mLp3sD8vA',
  'wlt_9fK2xQ7mLp3sD8vA',
  `curl -H "Authorization: Bearer ${DEMO}"`,
];
const ID = '0193a1b2-7c00-7000-8000-0000000000c1';

interface Call {
  url: string;
  method: string;
  init: RequestInit;
}
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A `fetch` that records every call and answers the portal's few endpoints; others are 404. */
function stubFetch(handlers: Record<string, Handler> = {}, index: SearchIndex = INDEX) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost:5173');
    calls.push({ url: String(input), method: init.method ?? 'GET', init });
    if (url.pathname === PATHS.searchIndex) return Response.json(index);
    if (url.pathname === PATHS.searchMiss) return new Response(null, { status: 204 });
    const handler = handlers[url.pathname];
    return handler ? handler(url, init) : new Response('{}', { status: 401 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

/** A fresh module graph per test: the index cache and the reported-terms set start empty. */
async function mount() {
  vi.resetModules();
  const { SearchPalette } = await import('./palette.tsx');
  const user = userEvent.setup({ delay: null });
  render(<SearchPalette open onOpenChange={() => {}} />);
  const box = await screen.findByRole('combobox');
  return { user, box };
}

const rows = () => screen.queryAllByRole('option').map((o) => o.textContent ?? '');
const headings = () =>
  [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent ?? '');
const settle = (ms = 1000) => new Promise((done) => setTimeout(done, ms));

beforeEach(() => installDomShims());
afterEach(() => {
  session = { kind: 'out' };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a pasted secret', () => {
  it('stays on the page: no request but the fixed index, no log, no beacon, no storage', async () => {
    const calls = stubFetch();
    const sent = vi.fn();
    Object.defineProperty(navigator, 'sendBeacon', { value: sent, configurable: true });
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((l) =>
      vi.spyOn(console, l).mockImplementation(() => {}),
    );
    const { user, box } = await mount();
    for (const secret of SECRETS) {
      await user.clear(box);
      await user.click(box);
      await user.paste(secret);
      expect(await screen.findByRole('alert')).toHaveTextContent('This is a secret key.');
      expect(screen.getByRole('link', { name: /Roll key/ })).toHaveAttribute(
        'href',
        '/admin/api-keys',
      );
    }
    await settle(1200);
    // The index is the one fixed GET; nothing carries any part of what was pasted.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${PATHS.searchIndex}`]);
    const everything = JSON.stringify([calls, sent.mock.calls, spies.map((s) => s.mock.calls)]);
    for (const secret of SECRETS)
      for (const part of secret.split(/[\s"]+/).filter((p) => p.length > 5))
        expect(everything).not.toContain(part.slice(-10));
    expect(sent).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(window.location.href).toBe('http://localhost:5173/');
    expect(window.location.hash).toBe('');
  });

  it('stays on the page even typed key by key, half-typed prefixes included', async () => {
    const calls = stubFetch();
    const { user, box } = await mount();
    await user.click(box);
    await user.keyboard('pb_test_9fK2xQ7mLp3sD8vA');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await settle(1200);
    expect(calls.map((c) => c.url)).toEqual([PATHS.searchIndex]);
  });

  it('shows the last four, lists no results from it, and clears on request', async () => {
    stubFetch();
    const { user, box } = await mount();
    await user.click(box);
    await user.paste(SECRETS[0] ?? '');
    expect(await screen.findByRole('link', { name: 'Roll key …9fK2' })).toBeInTheDocument();
    expect(headings()).toEqual(['Also']);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(box).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('turns the browser’s spell checker off, which can send text to a server', async () => {
    stubFetch();
    const { box } = await mount();
    expect(box).toHaveAttribute('spellcheck', 'false');
    expect(box).toHaveAttribute('autocomplete', 'off');
  });
});

describe('a search that finds nothing', () => {
  it('reports the term alone, once, with no cookie and no referrer', async () => {
    const calls = stubFetch();
    const { user, box } = await mount();
    await user.type(box, 'zzqxv');
    expect(await screen.findByText('No results for “zzqxv”')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    const [post] = calls.filter((c) => c.method === 'POST');
    expect(post?.url).toBe(PATHS.searchMiss);
    expect(JSON.parse(String(post?.init.body))).toEqual({ term: 'zzqxv' });
    expect(post?.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(post?.init.headers).not.toHaveProperty('cookie');
    // The same term again is not a second report.
    await user.clear(box);
    await user.type(box, 'zzqxv');
    await settle(1000);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('waits for the reader to stop typing', async () => {
    const calls = stubFetch();
    const { user, box } = await mount();
    await user.type(box, 'zzq');
    await settle(300);
    await user.type(box, 'xv');
    await settle(300);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await settle(700);
    expect(JSON.parse(String(calls.find((c) => c.method === 'POST')?.init.body))).toEqual({
      term: 'zzqxv',
    });
  });

  it('keeps ids, addresses, links and keys out of the report', async () => {
    const calls = stubFetch();
    const { user, box } = await mount();
    for (const text of ['maya@example.com', 'https://example.com/zz', ID, ...SECRETS.slice(0, 2)]) {
      await user.clear(box);
      await user.paste(text);
      await settle(900);
    }
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('says what to do instead when the index has a hint', async () => {
    stubFetch();
    const { user, box } = await mount();
    await user.type(box, 'refund');
    expect(
      await screen.findByText('Passes are voided or removed, not refunded.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Void a pass' })).toHaveAttribute(
      'href',
      expect.stringContaining('/developers/reference/passes/void'),
    );
  });
});

describe('a pasted id', () => {
  it('is looked up with the session, and opens the request it names', async () => {
    const calls = stubFetch({
      '/api/v1/developer/resolve': () =>
        Response.json({
          kind: 'request',
          href: '/developers/logs#row1',
          label: 'POST /passes, 409',
        }),
    });
    const { user, box } = await mount();
    await user.click(box);
    await user.paste('8A1B2C3D4E5F6A7B-LHR');
    const row = await screen.findByRole('option', { name: /POST \/passes, 409/ });
    expect(headings()[0]).toBe('Open');
    const lookup = calls.find((c) => c.url.includes('/resolve'));
    expect(lookup?.url).toBe('/api/v1/developer/resolve?id=8a1b2c3d4e5f6a7b-lhr');
    expect(lookup?.init.credentials).toBe('same-origin');
    await user.keyboard('{Enter}');
    expect(nav.goTo).toHaveBeenCalledWith('/developers/logs#row1');
    expect(row).toBeDefined();
  });

  it('says so when signed out, or when the id is not in the sandbox', async () => {
    stubFetch();
    const first = await mount();
    await first.user.click(first.box);
    await first.user.paste(ID);
    expect(await screen.findByRole('status')).toHaveTextContent('Sign in to look up an id');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?next=%2Fdevelopers',
    );
  });

  it('says so when nothing has the id', async () => {
    stubFetch({ '/api/v1/developer/resolve': () => new Response('{}', { status: 404 }) });
    const { user, box } = await mount();
    await user.click(box);
    await user.paste(ID);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'No request or object with this id',
    );
  });
});

describe('results while typing', () => {
  it('only lose rows while keys go in, then rank afresh when the reader pauses', async () => {
    // For "r" the five shortest prefix matches show; RELEASE_A and OTHER_RELEASE are below the cut.
    const codes = [
      'RELEASE_B',
      'REFUND_X',
      'RELEASE_A',
      'RENEW_Y',
      'RESET_Z',
      'RETRY_Q',
      'OTHER_RELEASE',
    ];
    const errors = codes.map((code) => ({
      code,
      status: null,
      title: '',
      when: '',
      fix: '',
      retryable: null,
      href: `/developers/errors/${code}`,
    }));
    stubFetch({}, { ...INDEX, errors, ops: [], guides: [], events: [], actions: [] });
    const { user, box } = await mount();
    await user.click(box);
    await user.keyboard('r');
    await waitFor(() => expect(rows().length).toBe(5));
    let before = rows();
    expect(before).not.toContain('OTHER_RELEASE');
    for (const key of 'elease') {
      await user.keyboard(key);
      const now = rows();
      // Nothing new appears and nothing changes place: the list is only narrowed.
      expect(now.every((r) => before.includes(r))).toBe(true);
      expect(now).toEqual(before.filter((r) => now.includes(r)));
      before = now;
    }
    expect(before).toEqual(['RELEASE_B']);
    // The reader pauses: ranked afresh, and the word-start match joins.
    await waitFor(() => expect(rows()).toEqual(['RELEASE_B', 'RELEASE_A', 'OTHER_RELEASE']));
    // The same words pasted in one go give the same list.
    await user.clear(box);
    await user.paste('release');
    await waitFor(() => expect(rows()).toEqual(['RELEASE_B', 'RELEASE_A', 'OTHER_RELEASE']));
  });

  it('are not moved by a slow answer in the preview pane', async () => {
    let release: (res: Response) => void = () => {};
    stubFetch({
      '/api/v1/developer/logs': () => new Promise<Response>((done) => (release = done)),
    });
    const { user, box } = await mount();
    await user.type(box, 'TEMPLATE_RELEASE_REQUIRED');
    await screen.findByRole('complementary', { name: 'Preview' });
    // Let the ranking settle first: a second error code holds the same words.
    await settle(400);
    await user.keyboard('{ArrowDown}');
    const picked = screen.getByRole('option', { selected: true }).textContent;
    const order = rows();
    release(Response.json({ items: [{ at: Date.now() - 1000 }], nextCursor: null }));
    await settle(100);
    expect(rows()).toEqual(order);
    expect(screen.getByRole('option', { selected: true }).textContent).toBe(picked);
  });
});

describe('the preview', () => {
  it('shows the fix and the sandbox’s own count for an error, and opens it in a tab on ⌘↵', async () => {
    session = {
      kind: 'ready',
      csrf: 'c',
      siteKey: '',
      sandbox: { id: 's', orgId: 'org-1', orgSlug: 'o', templateId: null },
    };
    stubFetch({
      '/api/v1/developer/logs': () =>
        Response.json({
          items: [{ at: Date.now() - 60_000 }, { at: Date.now() - 120_000 }],
          nextCursor: null,
        }),
    });
    const { user, box } = await mount();
    await user.type(box, 'TEMPLATE_RELEASE_REQUIRED');
    const pane = await screen.findByRole('complementary', { name: 'Preview' });
    expect(within(pane).getByText('Fix')).toBeInTheDocument();
    expect(await within(pane).findByText(/in the last 24 h/)).toHaveTextContent(
      '2 in the last 24 h',
    );
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(nav.openTab).toHaveBeenCalledWith('/developers/errors/TEMPLATE_RELEASE_REQUIRED');
  });

  it('leaves the sandbox line out, and asks for no log, without a sandbox', async () => {
    session = { kind: 'none', csrf: 'c', siteKey: '' };
    const calls = stubFetch();
    const { user, box } = await mount();
    await user.type(box, 'TEMPLATE_RELEASE_REQUIRED');
    const pane = await screen.findByRole('complementary', { name: 'Preview' });
    await settle(500);
    expect(within(pane).queryByText('In your request log')).toBeNull();
    expect(calls.some((c) => c.url.includes('/developer/logs'))).toBe(false);
  });
});
