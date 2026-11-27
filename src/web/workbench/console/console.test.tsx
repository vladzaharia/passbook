import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpConsole } from './app/console.tsx';
import { resetBudget } from './budget.ts';
import { tryClient } from './client.ts';
import { resetTemplateInput } from './template-sample.ts';
import { fakeNetwork, json, passesCreate, passesVoid, TOKEN } from './test-support.ts';
import { resetToken } from './token.ts';

const props = {
  origin: 'https://passbook.mobile',
  client: tryClient('c'),
  templateId: null,
  codes: new Set(['PASS_CONFLICT']),
} as const;
const view = (op = passesCreate) => render(<OpConsole op={op} mode="op" {...props} />);
const run = () => userEvent.click(screen.getByRole('button', { name: 'Run' }));

beforeEach(() => {
  resetToken();
  resetTemplateInput();
  resetBudget();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('response rendering', () => {
  it('draws every response value as text and never as markup', async () => {
    fakeNetwork(() =>
      json({
        note: '<img src=x onerror="window.__hit=1"><script>window.__hit=2</script>',
        link: 'javascript:alert(1)',
        elsewhere: 'https://evil.example/x',
        previewUrl: `${location.origin}/preview/abc`,
      }),
    );
    const { container } = view();
    await run();
    await screen.findByText(/img src=x/);
    expect(container.querySelector('img, script, iframe')).toBeNull();
    expect((window as unknown as { __hit?: number }).__hit).toBeUndefined();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.startsWith('javascript:'))).toBe(false);
    expect(hrefs.some((h) => h?.includes('evil.example'))).toBe(false);
    const preview = container.querySelector('a[href$="/preview/abc"]');
    expect(preview?.getAttribute('rel')).toContain('noopener');
  });

  it('shows a non-JSON body as literal text', async () => {
    fakeNetwork(
      () =>
        new Response('<h1 onclick="x()">Bad gateway</h1>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const { container } = view();
    await run();
    await screen.findByText('502 Bad Gateway');
    expect(container.textContent).toContain('<h1 onclick="x()">Bad gateway</h1>');
    expect(container.querySelector('h1')).toBeNull();
  });

  it('links an error code to its entry only when the catalog has it', async () => {
    fakeNetwork(() => json({ code: 'PASS_CONFLICT' }, { status: 409 }));
    view();
    await run();
    const link = await screen.findByRole('link', { name: '"PASS_CONFLICT"' });
    expect(link).toHaveAttribute('href', '/developers/errors/PASS_CONFLICT');
  });
});

describe('the response on the bench', () => {
  const RID = '0190a1b2-c3d4-7e5f-8a9b-0123456789ab';

  it('names the request as an id chip and opens its row in Logs', async () => {
    fakeNetwork(() => json({ id: 'p1' }, { status: 201, headers: { 'x-request-id': RID } }));
    view();
    await run();
    await screen.findByText('201 Created');
    // The header and the Trace each hold the chip.
    expect(
      screen.getAllByRole('button', { name: new RegExp(`, Copy request id ${RID}$`) }),
    ).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'View in Logs' })).toHaveAttribute(
      'href',
      `/developers/logs?source=all#${RID}`,
    );
    // The Trace ends it: the request, as a chip that opens in Logs.
    expect(screen.getByRole('navigation', { name: 'Trace' })).toHaveTextContent('POST /passes 201');
  });

  it('says where a new secret shows in full, and only then', async () => {
    fakeNetwork(() => json({ key: { id: 'k1', secret: 'pbk_live_abc' } }, { status: 201 }));
    view();
    await run();
    expect(await screen.findByText(/shows in full here/)).toBeInTheDocument();
  });

  it('has no hint on an ordinary answer', async () => {
    fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    view();
    await run();
    await screen.findByText('201 Created');
    expect(screen.queryByText(/shows in full here/)).toBeNull();
  });
});

describe('the JSON editor', () => {
  it('numbers each line on the line itself, so a wrapped line keeps one number', async () => {
    fakeNetwork(() => json({}));
    const { container } = view();
    await userEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    const lines = container.querySelectorAll('.editor pre .ln');
    const text = (screen.getByLabelText('Request body (JSON)') as HTMLTextAreaElement).value;
    expect(lines).toHaveLength(text.split('\n').length);
    expect(container.querySelector('.gutter')).toBeNull();
  });
});

describe('the try token', () => {
  it('stays out of storage, cookies, the URL, the page and Copy as', async () => {
    const net = fakeNetwork(() => json({ id: 'p1', echo: `Bearer ${TOKEN}` }, { status: 201 }));
    const before = location.href;
    const { container } = view();
    await run();
    await screen.findByText('201 Created');
    expect(net.mints()).toBe(1);
    const api = net.calls.find((c) => c.path === '/api/v1/passes');
    expect(api?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The one place it appears is that header.
    for (const c of net.calls) {
      expect(c.path).not.toContain('pbtry');
      expect(c.body ?? '').not.toContain('pbtry');
    }
    expect(JSON.stringify({ ...localStorage })).not.toContain('pbtry');
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain('pbtry');
    expect(location.href).toBe(before);
    expect(container.ownerDocument.body.innerHTML).not.toContain('SECRETPAYLOAD123');
    expect(container.ownerDocument.body.textContent).not.toContain('SECRETPAYLOAD123');
    // A response that echoes one is cut before it is drawn.
    expect(container.textContent).toContain('pbtry_…');
  });

  it('writes $PASSBOOK_KEY in every Copy as tab, with the headers that went out', async () => {
    fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    view();
    for (const [name, needle] of [
      ['TypeScript', 'process.env.PASSBOOK_KEY'],
      ['curl', '$PASSBOOK_KEY'],
      ['Python', "os.environ['PASSBOOK_KEY']"],
      ['Go', 'os.Getenv("PASSBOOK_KEY")'],
    ] as const) {
      await userEvent.click(screen.getByRole('tab', { name }));
      const code = screen.getByRole('tabpanel');
      expect(code.textContent).toContain(needle);
      expect(code.textContent).toContain('Idempotency-Key');
      expect(code.textContent).not.toContain('pbtry');
    }
  });

  it('asks for a fresh token once when the server calls it stale', async () => {
    let first = true;
    const net = fakeNetwork(() => {
      if (first) {
        first = false;
        return json({ code: 'UNAUTHENTICATED' }, { status: 401 });
      }
      return json({ id: 'p1' }, { status: 201 });
    });
    view();
    await run();
    await screen.findByText('201 Created');
    expect(net.mints()).toBe(2);
  });
});

describe('idempotent replay', () => {
  it('sends the same key again on request, shows the replay, and a plain Run uses a new key', async () => {
    let n = 0;
    const net = fakeNetwork(() =>
      json(
        { id: 'p1' },
        { status: 201, headers: n++ === 1 ? { 'idempotent-replayed': 'true' } : {} },
      ),
    );
    view();
    await run();
    await screen.findByText('201 Created');
    const keys = () =>
      net.calls.filter((c) => c.path === '/api/v1/passes').map((c) => c.headers['Idempotency-Key']);
    expect(keys()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /same key/ }));
    await waitFor(() => expect(keys()).toHaveLength(2));
    expect(keys()[1]).toBe(keys()[0]);
    await waitFor(() =>
      expect(screen.getByText('Idempotent-Replayed').nextSibling).toHaveTextContent('true'),
    );
    await run();
    await waitFor(() => expect(keys()).toHaveLength(3));
    expect(keys()[2]).not.toBe(keys()[0]);
  });

  it('omits the header when the switch is off', async () => {
    const net = fakeNetwork(() => json({}, { status: 201 }));
    view();
    await userEvent.click(screen.getByRole('switch', { name: 'Send Idempotency-Key' }));
    await run();
    await screen.findByText('201 Created');
    expect(
      net.calls.find((c) => c.path === '/api/v1/passes')?.headers['Idempotency-Key'],
    ).toBeUndefined();
  });
});

describe('the request builder', () => {
  it('blocks Run until the body fits the schema', async () => {
    const net = fakeNetwork(() => json({}));
    view();
    await userEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    const box = screen.getByLabelText('Request body (JSON)');
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste('{"input": {}}');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getByText('1 problem')).toBeInTheDocument();
    await userEvent.click(screen.getByText('1 problem'));
    expect(screen.getByText('templateId')).toBeInTheDocument();
    expect(net.calls.filter((c) => c.path === '/api/v1/passes')).toHaveLength(0);
  });

  it('asks twice before a destructive call', async () => {
    const net = fakeNetwork(() => json({ ok: true }));
    view(passesVoid);
    await userEvent.type(screen.getByLabelText(/^id/), 'p1');
    await run();
    expect(net.calls.filter((c) => c.path.startsWith('/api/v1/passes/'))).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm POST' }));
    await screen.findByText('200 OK');
    expect(net.calls.find((c) => c.path === '/api/v1/passes/p1/void')).toBeTruthy();
  });

  it('Cmd+Enter takes the same gates: the destructive second press, and invalid input', async () => {
    const net = fakeNetwork(() => json({ ok: true }));
    view(passesVoid);
    await userEvent.type(screen.getByLabelText(/^id/), 'p1');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(net.calls.filter((c) => c.path.startsWith('/api/v1/passes/'))).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Confirm POST' })).toBeInTheDocument();
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await screen.findByText('200 OK');
    expect(net.calls.filter((c) => c.path.startsWith('/api/v1/passes/'))).toHaveLength(1);
  });

  it('Cmd+Enter does nothing while the body is invalid', async () => {
    const net = fakeNetwork(() => json({}));
    view();
    await userEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    const box = screen.getByLabelText('Request body (JSON)');
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste('{');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(net.calls.filter((c) => c.path === '/api/v1/passes')).toHaveLength(0);
  });

  it("does not re-send after a 401 that is not the guard's", async () => {
    const net = fakeNetwork(() => json({ code: 'CONNECTOR_AUTH' }, { status: 401 }));
    view();
    await run();
    await screen.findByText('401 Unauthorized');
    expect(net.calls.filter((c) => c.path === '/api/v1/passes')).toHaveLength(1);
    expect(net.mints()).toBe(1);
  });

  it('cuts a token written with JSON escapes, in values and keys', async () => {
    fakeNetwork(
      () =>
        new Response('{"a":"pbtry\\u005fSECRETPAYLOAD123.sig","pbtry\\u005fKEYNAME.x":1}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { container } = view();
    await run();
    await screen.findByText('201 Created');
    expect(container.textContent).not.toContain('SECRETPAYLOAD123');
    expect(container.textContent).not.toContain('KEYNAME');
  });

  it('links only to previews, pass pages and these docs, never to sign-in or API paths', async () => {
    fakeNetwork(() =>
      json({
        preview: `${location.origin}/preview/abc`,
        docs: `${location.origin}/developers/errors/X`,
        login: `${location.origin}/auth/magic?token=attacker`,
        api: `${location.origin}/api/v1/passes`,
      }),
    );
    const { container } = view();
    await run();
    await screen.findByText(/magic/);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.endsWith('/preview/abc'))).toBe(true);
    expect(hrefs.some((h) => h.endsWith('/developers/errors/X'))).toBe(true);
    expect(hrefs.some((h) => h.includes('/auth/') || h.includes('/api/v1'))).toBe(false);
  });

  it('refuses . and .. as a path id', async () => {
    const net = fakeNetwork(() => json({}));
    view(passesVoid);
    await userEvent.type(screen.getByLabelText(/^id/), '..');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(net.calls).toHaveLength(0);
  });

  it("stops at the server's 429 and says so", async () => {
    fakeNetwork(() =>
      json({ code: 'RATE_LIMITED' }, { status: 429, headers: { 'retry-after': '30' } }),
    );
    view();
    await run();
    await screen.findByText('429 Too Many Requests');
    expect(screen.getByRole('button', { name: /Wait a moment/ })).toBeDisabled();
  });
});

describe('the sandbox template', () => {
  const ticket = { eventName: 'Gala', attendee: 'Ada' };
  const schema = {
    type: 'object',
    required: ['eventName'],
    additionalProperties: false,
    properties: { eventName: { type: 'string' }, attendee: { type: 'string' } },
  };
  const answer = (call: { path: string }) =>
    call.path === '/api/v1/templates/tpl_mine'
      ? json({ sample: ticket, inputSchema: schema })
      : json({ id: 'p1' }, { status: 201 });
  const reads = (net: { calls: { path: string; headers: Record<string, string> }[] }) =>
    net.calls.filter((c) => c.path.startsWith('/api/v1/templates/'));

  it('reads nothing and mints nothing until the first Run', async () => {
    const net = fakeNetwork(answer);
    render(<OpConsole op={passesCreate} mode="op" {...props} templateId="tpl_mine" />);
    expect(await screen.findByText('Body shape valid')).toBeInTheDocument();
    expect(net.calls).toEqual([]);
  });

  it('then reads the template once, fills input from its sample and checks it', async () => {
    const net = fakeNetwork(answer);
    render(<OpConsole op={passesCreate} mode="op" {...props} templateId="tpl_mine" />);
    await run();
    await screen.findByText('201 Created');
    await screen.findByText('Valid against the schema');
    expect(reads(net)).toHaveLength(1);
    expect(reads(net)[0]?.headers['x-passbook-client']).toBe('portal');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(net.calls.filter((c) => c.path === '/api/v1/passes')).toHaveLength(2),
    );
    const second = net.calls.filter((c) => c.path === '/api/v1/passes')[1];
    expect(JSON.parse(second?.body ?? '{}')).toEqual({ templateId: 'tpl_mine', input: ticket });
  });

  it('says only that the body shape is valid when the template cannot be read', async () => {
    fakeNetwork((call) =>
      call.path.startsWith('/api/v1/templates/') ? json({}, { status: 500 }) : answer(call),
    );
    render(<OpConsole op={passesCreate} mode="op" {...props} templateId="tpl_mine" />);
    await run();
    await screen.findByText('201 Created');
    expect(await screen.findByText('Body shape valid')).toBeInTheDocument();
  });
});
