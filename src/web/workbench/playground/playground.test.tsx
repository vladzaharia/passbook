import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_BAND_COPY } from '../../../shared/copy/developer.ts';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import { encodeEdits } from './hash.ts';
import { Playground } from './playground.tsx';
import { builtPreviews } from './test-data.ts';

const { data } = builtPreviews();
const STORE = 'baked:starter-store-card';
const HINT = 'pb.developers.playground.live';
const calls: string[] = [];

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost').pathname;
      calls.push(`${init.method ?? 'GET'} ${url}`);
      return handler(url, init);
    }),
  );
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/developers/playground');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('playground, anonymous', () => {
  it('makes no API call, however much it is used', async () => {
    stubFetch((url) => {
      // Only the session check: it answers signed-out with 200, and decides which hint to show.
      if (url.endsWith('/api/v1/session')) return Response.json({ authenticated: false });
      throw new Error('the anonymous path must not call out');
    });
    const user = userEvent.setup();
    render(<Playground data={data} />);
    await screen.findByTestId('all-channels');

    await user.selectOptions(screen.getByLabelText('Template'), 'baked:starter-event-ticket');
    await user.click(screen.getByRole('radio', { name: 'Google' }));
    // The wallet pane loads lazily; its Front / Back toggle is the one place the face is chosen.
    await user.click(await screen.findByRole('radio', { name: 'Back' }));
    expect(location.hash).toContain('f=back');
    await user.click(screen.getByRole('radio', { name: 'JSON' }));
    await user.click(screen.getByRole('radio', { name: 'Form' }));
    await user.click(screen.getByRole('tab', { name: 'Python' }));
    await user.click(screen.getByRole('radio', { name: 'Paper' }));
    await user.click(screen.getByRole('radio', { name: 'All' }));

    expect(calls.filter((c) => !c.endsWith('/api/v1/session'))).toEqual([]);
    expect(localStorage.getItem(HINT)).toBeNull();
  });

  it('shows the starter’s four channels from the prebuilt sample, with paper as an image', async () => {
    stubFetch(() => {
      throw new Error('no network');
    });
    render(<Playground data={data} />);
    const all = await screen.findByTestId('all-channels');
    const figures = [...all.querySelectorAll(':scope > figure')] as HTMLElement[];
    expect(figures.map((f) => f.dataset.channel)).toEqual(['apple', 'google', 'samsung', 'paper']);
    const image = within(figures[3] as HTMLElement).getByRole('img');
    expect(image.getAttribute('src')).toBe('/developers/paper/starter-store-card.svg');
    expect(within(figures[0] as HTMLElement).getAllByText(TEST_BAND_COPY).length).toBeGreaterThan(
      0,
    );
    // A blueprint is a design to start from: previews only, and the one button asks for a sandbox.
    expect(screen.getByRole('button', { name: 'Edit in my sandbox' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create test pass' })).toBeNull();
  });

  it('moves between channels with the arrow keys, one tab stop for the group', async () => {
    stubFetch(() => {
      throw new Error('no network');
    });
    const user = userEvent.setup();
    render(<Playground data={data} />);
    const all = await screen.findByRole('radio', { name: 'All' });
    expect(all.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: 'Apple' }).getAttribute('tabindex')).toBe('-1');
    all.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Apple', checked: true })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Apple' }));
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Paper', checked: true })).toBeTruthy();
  });

  it('copies the link and the code, and says so in place', async () => {
    stubFetch(() => {
      throw new Error('no network');
    });
    const user = userEvent.setup();
    render(<Playground data={data} />);
    await user.click(await screen.findByRole('button', { name: /Copy link/ }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe(location.href);
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    const code = await navigator.clipboard.readText();
    expect(code).toContain(SDK_STATUS.typescript ? 'pb.passes.create' : '/passes');
    expect(code).toContain('PASSBOOK_KEY');
  });

  it('keeps the page in the hash, and opens a link as it was', async () => {
    stubFetch(() => {
      throw new Error('no network');
    });
    const user = userEvent.setup();
    const hash = `#t=${encodeURIComponent(STORE)}&l=curl&c=google&i=${encodeEdits({ balance: 180 })}`;
    history.replaceState(null, '', `/developers/playground${hash}`);
    render(<Playground data={data} />);
    // The link's edit is in the form and in the request, on the language the link chose.
    expect((await screen.findByLabelText(/^Balance/)) as HTMLInputElement).toHaveProperty(
      'value',
      '180',
    );
    expect(screen.getByTestId('code-panel').textContent).toContain('"balance": 180');
    expect(screen.getByRole('radio', { name: 'Google', checked: true })).toBeTruthy();

    // An edit writes itself into the hash.
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Casey River');
    await waitFor(() => expect(decodeURIComponent(location.hash)).toContain('i='));
    const reread = new URLSearchParams(location.hash.slice(1));
    expect(reread.get('t')).toBe(STORE);
    expect(reread.get('l')).toBe('curl');
    expect(reread.get('c')).toBe('google');
    expect(
      JSON.parse(atob(String(reread.get('i')).replaceAll('-', '+').replaceAll('_', '/'))),
    ).toEqual({
      balance: 180,
      holder: 'Casey River',
    });
    expect(calls).toEqual([]);
  });

  it('says plainly that edits show in the code, not in the previews, until there is a sandbox', async () => {
    stubFetch(() => {
      throw new Error('no network');
    });
    const user = userEvent.setup();
    render(<Playground data={data} />);
    await user.type(await screen.findByLabelText(/^Card number/), '9');
    expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/Showing the sample/);
    expect(screen.getByTestId('code-panel').textContent).toContain('CARD-00019');
  });

  it('reaches for the API only when the visitor asks for their sandbox', async () => {
    stubFetch((url) =>
      url === '/api/v1/session'
        ? json({ authenticated: true, csrfToken: 'c', roles: ['developer'] })
        : json({ sandbox: null }),
    );
    const user = userEvent.setup();
    render(<Playground data={data} />);
    await screen.findByTestId('all-channels');
    expect(calls).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Edit in my sandbox' }));
    await screen.findByText(/No sandbox yet/);
    expect(calls).toEqual(['GET /api/v1/session', 'GET /api/v1/developer/sandbox']);
  });
});

describe('playground, signed in', () => {
  const item = data.items.find((i) => i.id === STORE);

  function sandbox() {
    const created: { url: string; init: RequestInit }[] = [];
    stubFetch(async (url, init) => {
      const bearer = new Headers(init.headers).get('authorization');
      if (url === '/api/v1/session') return json({ authenticated: true, csrfToken: 'csrf-1' });
      if (url === '/api/v1/developer/sandbox')
        return json({ sandbox: { templateId: 'tpl-1', orgSlug: 'casey', closedAt: null } });
      if (url === '/api/v1/developer/try-token')
        return json({ token: 'pbtry_abc.def', expiresAt: Date.now() + 15 * 60_000 }, 201);
      expect(bearer).toBe('Bearer pbtry_abc.def');
      if (url === '/api/v1/templates/tpl-1' && init.method === 'GET')
        return json({
          id: 'tpl-1',
          name: 'Quickstart membership',
          activeVersion: '1',
          inputSchema: item?.inputs,
          sample: item?.sample,
          manifest: item?.manifest,
          versions: [{ version: '1', assets: item?.assets }],
        });
      if (url.endsWith('/preview')) {
        const input = JSON.parse(String(init.body)).input as { holder: string };
        return json({
          passJson: JSON.parse(
            JSON.stringify(item?.passJson).replaceAll('Alex Morgan', input.holder),
          ),
          warnings: [],
          assetBaseUrl: item?.assetBaseUrl,
          assetNames: item?.assetNames,
        });
      }
      if (url === '/api/v1/passes') {
        created.push({ url, init });
        return json({ id: 'pass-1', downloadUrl: '/preview/pass-1.sig' }, 201);
      }
      return json({}, 404);
    });
    return created;
  }

  it('previews edits through the try token, debounced, and creates a test pass that shows the band', async () => {
    localStorage.setItem(HINT, '1');
    const created = sandbox();
    const user = userEvent.setup();
    render(<Playground data={data} />);

    // Connected on its own: the visitor chose their sandbox last time.
    const create = await screen.findByRole('button', { name: 'Create test pass' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    expect(calls.slice(0, 3)).toEqual([
      'GET /api/v1/session',
      'GET /api/v1/developer/sandbox',
      'POST /api/v1/developer/try-token',
    ]);

    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Casey River');
    // One preview for the whole burst of typing, not one per key.
    await waitFor(() => expect(screen.getByText(/Updated/)).toBeTruthy());
    const previews = calls.filter((c) => c.endsWith('/preview'));
    expect(previews.length).toBeLessThanOrEqual(3);
    expect(screen.getByText('was Alex Morgan')).toBeTruthy();

    await user.click(create);
    const done = await screen.findByText(/Test pass created/);
    const strip = done.closest('.created') as HTMLElement;
    expect(within(strip).getAllByText(TEST_BAND_COPY).length).toBeGreaterThan(0);
    expect(
      within(strip)
        .getByRole('link', { name: /Open preview page/ })
        .getAttribute('href'),
    ).toBe('/preview/pass-1.sig');
    const body = JSON.parse(String(created[0]?.init.body)) as {
      templateId: string;
      input: { holder: string };
    };
    expect(body.templateId).toBe('tpl-1');
    expect(body.input.holder).toBe('Casey River');
    expect(new Headers(created[0]?.init.headers).get('idempotency-key')).toBeTruthy();
  });

  it('never puts the token or a key in the page, the hash or storage', async () => {
    localStorage.setItem(HINT, '1');
    sandbox();
    render(<Playground data={data} />);
    await screen.findByRole('button', { name: 'Create test pass' });
    const everything =
      document.body.innerHTML + location.href + JSON.stringify({ ...localStorage });
    expect(everything).not.toContain('pbtry_');
    expect(everything).not.toMatch(/pb[a-z]*_(test|live)_/);
  });
});
