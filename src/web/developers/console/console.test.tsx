import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpConsole } from './app/console.tsx';
import { resetBudget } from './budget.ts';
import { fakeNetwork, json, passesCreate, passesVoid, TOKEN } from './test-support.ts';
import { resetToken } from './token.ts';

const props = {
  origin: 'https://passbook.mobile',
  csrf: 'csrf-1',
  templateId: null,
  codes: new Set(['PASS_CONFLICT']),
} as const;
const view = (op = passesCreate) => render(<OpConsole op={op} mode="op" {...props} />);
const run = () => userEvent.click(screen.getByRole('button', { name: 'Run' }));

beforeEach(() => {
  resetToken();
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
    await screen.findByText('<h1 onclick="x()">Bad gateway</h1>');
    expect(container.querySelector('h1')).toBeNull();
    expect(screen.getByText('502 Bad Gateway')).toBeInTheDocument();
  });

  it('links an error code to its entry only when the catalog has it', async () => {
    fakeNetwork(() => json({ code: 'PASS_CONFLICT' }, { status: 409 }));
    view();
    await run();
    const link = await screen.findByRole('link', { name: '"PASS_CONFLICT"' });
    expect(link).toHaveAttribute('href', '/developers/errors/PASS_CONFLICT');
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
