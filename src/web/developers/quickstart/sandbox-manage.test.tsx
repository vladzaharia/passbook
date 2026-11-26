import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEC_2,
  fixtureOperation,
  SANDBOX_DELETE,
  SANDBOX_RECREATE,
} from '../../ui/operation/fixtures.test-support.ts';
import { resetOperationCache } from '../../ui/operation/store.ts';
import { SandboxOperations } from '../ui/sandbox-operation.tsx';
import { SandboxManage } from './sandbox-manage.tsx';

vi.mock('../console/turnstile.ts', () => ({ verify: async () => 'tok' }));

const assign = vi.fn();
beforeEach(() => resetOperationCache());
afterEach(() => {
  vi.unstubAllGlobals();
  assign.mockReset();
});

const stubLocation = (hash = '') =>
  vi.stubGlobal('location', {
    ...window.location,
    pathname: '/developers/quickstart',
    search: '',
    hash,
    assign,
  });
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status }));

/** The page's own state for the operation `?op=` names: SandboxManage is told it and says when it starts one. */
function Host({
  initial = null,
  onMade = () => undefined,
}: {
  initial?: string | null;
  onMade?: (...a: unknown[]) => void;
}) {
  const [op, setOp] = useState<string | null>(initial);
  return (
    <SandboxOperations csrf="c">
      <SandboxManage csrf="c" siteKey="k" onMade={onMade} op={op} onOp={setOp} />
    </SandboxOperations>
  );
}

/** A fetch that answers by "METHOD path": a function runs per call, a list answers one call each, the last one staying. */
type Answer = Response | (() => Response | Promise<Response>);
function api(routes: Record<string, Answer | Answer[]>) {
  const seen: Record<string, number> = {};
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).replace('/api/v1', '')}`;
    const entry = routes[key];
    if (!entry) return new Response('{}', { status: 404 });
    const n = seen[key] ?? 0;
    seen[key] = n + 1;
    const one = Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] as Answer) : entry;
    return typeof one === 'function' ? one() : one.clone();
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const removing = (done = 4) =>
  fixtureOperation(SANDBOX_DELETE, {
    status: 'running',
    at: 'passes',
    counts: { done, total: 12 },
    id: 'op-del',
  });
const deleted = () => {
  const op = fixtureOperation(SANDBOX_DELETE, { status: 'succeeded', tail: true, id: 'op-del' });
  return {
    ...op,
    steps: op.steps.map((x) =>
      x.key === 'erase'
        ? { ...x, state: 'waiting' as const, waitingReason: 'due' as const, until: DEC_2 }
        : x,
    ),
  };
};

describe('Start over and Delete sandbox', () => {
  it('names what goes before deleting, and cancel leaves it alone', async () => {
    stubLocation();
    const fetchMock = reply(204, {});
    vi.stubGlobal('fetch', fetchMock);
    render(<Host />);
    expect(screen.queryByRole('region')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    expect(screen.getByText(/Passes, keys, webhooks and logs are deleted/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Passes, keys, webhooks and logs/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes with DELETE, shows each step with its count, and ends on Create sandbox', async () => {
    stubLocation();
    const fetchMock = api({
      'DELETE /developer/sandbox': json(202, { operation: removing() }),
      'GET /operations/op-del': [json(200, removing(4)), json(200, deleted())],
    });
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/developer/sandbox');
    expect(init.method).toBe('DELETE');
    // The confirm becomes the live panel: the exact step, its count, and every step in order.
    const region = screen.getByRole('region', { name: 'Delete this sandbox?' });
    expect(await within(region).findByText('Removing Test passes · 4 of 12')).toBeTruthy();
    const steps = within(within(region).getByRole('list')).getAllByRole('listitem');
    expect(steps.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Close sandbox'),
      expect.stringContaining('Revoke keys'),
      expect.stringContaining('Remove Test passes'),
      expect.stringContaining('Erase sandbox data'),
    ]);
    // It ends in the no-sandbox state: Done, when the data goes, and the way back to the first step.
    expect(await within(region).findByText('Sandbox deleted', {}, { timeout: 4000 })).toBeTruthy();
    expect(within(region).getByText('Data is erased by Dec 2.')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    await userEvent.click(within(region).getByRole('button', { name: 'Create sandbox' }));
    expect(assign).toHaveBeenCalledWith('/developers/quickstart');
  });

  it('resumes the operation a reload names, without asking again', async () => {
    stubLocation();
    const fetchMock = api({ 'GET /operations/op-del': json(200, removing(7)) });
    render(<Host initial="op-del" />);
    const region = await screen.findByRole('region', { name: 'Delete this sandbox?' });
    expect(await within(region).findByText('Removing Test passes · 7 of 12')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(
      fetchMock.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.method !== 'DELETE'),
    ).toBe(true);
  });

  it('follows a delete that is already running instead of showing an error', async () => {
    stubLocation();
    api({
      'DELETE /developer/sandbox': json(409, {
        code: 'OPERATION_RUNNING',
        detail: 'This is already running.',
        operationId: 'op-del',
      }),
      'GET /operations/op-del': json(200, removing(2)),
    });
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    expect(await screen.findByText('Removing Test passes · 2 of 12')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops on the failed step with its sentence, and Retry runs it again', async () => {
    stubLocation();
    const failed = {
      ...fixtureOperation(SANDBOX_DELETE, { status: 'failed', at: 'passes', id: 'op-del' }),
      attempt: 1,
    };
    const fetchMock = api({
      'GET /operations/op-del': [json(200, failed), json(200, removing(1))],
      'POST /operations/op-del/retry': json(202, { operation: { ...removing(0), attempt: 2 } }),
    });
    render(<Host initial="op-del" />);
    expect(await screen.findByText('Could not delete sandbox')).toBeTruthy();
    expect(screen.getByText('Webhooks are off on this plan. Retry.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findAllByText(/Removing Test passes/)).length).toBeGreaterThan(0);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/operations/op-del/retry')),
    ).toBe(true);
  });

  it('starts over through the check, shows both halves, and hands the new key to the page', async () => {
    stubLocation();
    const running = fixtureOperation(SANDBOX_RECREATE, {
      status: 'running',
      at: 'org',
      tails: ['erase'],
      id: 'op-new',
    });
    const done = {
      ...fixtureOperation(SANDBOX_RECREATE, { status: 'succeeded', tail: true, id: 'op-new' }),
      result: {
        href: null,
        ids: { sandboxId: 's2', orgId: 'org-2', orgSlug: 'dev-new', templateId: 't2' },
      },
    };
    const fetchMock = api({
      'POST /developer/sandbox/recreate': json(202, { operation: running }),
      'GET /operations/op-new': [json(200, running), json(200, done)],
      'POST /developer/sandbox/key': json(201, { key: { secret: 'pbp_test_new' } }),
    });
    const onMade = vi.fn();
    render(<Host onMade={onMade} />);
    await userEvent.click(screen.getByRole('button', { name: /Start over/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Start over' }).at(-1) as HTMLElement,
    );
    expect(await screen.findByText('Old sandbox')).toBeTruthy();
    expect(screen.getByText('New sandbox')).toBeTruthy();
    await waitFor(
      () =>
        expect(onMade).toHaveBeenCalledWith(
          { id: 's2', orgId: 'org-2', orgSlug: 'dev-new', templateId: 't2' },
          'pbp_test_new',
        ),
      { timeout: 4000 },
    );
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      '/api/v1/developer/sandbox/recreate',
    );
  });

  it('shows the server sentence when it refuses, such as the daily limit', async () => {
    stubLocation();
    vi.stubGlobal(
      'fetch',
      reply(429, { detail: 'You can delete a sandbox 3 times a day. Try again later.' }),
    );
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('3 times a day');
    expect(assign).not.toHaveBeenCalled();
  });

  it('opens the confirm named by the chip menu link', () => {
    stubLocation('#delete-sandbox');
    render(<Host />);
    expect(screen.getByText('Delete this sandbox?')).toBeTruthy();
  });

  it('opens the confirm when the hash changes on the page, and again for the same choice', async () => {
    stubLocation();
    render(<Host />);
    expect(screen.queryByText('Delete this sandbox?')).toBeNull();
    // The chip menu link on the quickstart: only the hash changes.
    stubLocation('#delete-sandbox');
    act(() => {
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.getByText('Delete this sandbox?')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Delete this sandbox?')).toBeNull();
    stubLocation('#delete-sandbox');
    act(() => {
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.getByText('Delete this sandbox?')).toBeTruthy();
  });

  it('brings the confirm into view and focuses it', () => {
    stubLocation('#delete-sandbox');
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Host />);
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Delete this sandbox?' }),
    );
  });

  it('shows the buddy working while the call is out, then the live steps', async () => {
    stubLocation();
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (release = r))),
    );
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Deleting your sandbox');
    expect(status.querySelector('svg.wnote-face')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    api({ 'GET /operations/op-del': json(200, removing(3)) });
    release(json(202, { operation: removing(3) }));
    // The panel takes the place of the note the moment the server names the operation.
    expect(await screen.findByText('Removing Test passes · 3 of 12')).toBeTruthy();
    expect(screen.queryByText('Passes, keys, webhooks and logs are going.')).toBeNull();
  });

  it('shows a failure in the confirm and lets the person try again', async () => {
    stubLocation();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't reach PassBook");
    expect(screen.getByRole('region').contains(alert)).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the choice through the step-up sign-in and reopens the confirm after it', async () => {
    stubLocation();
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      reply(403, {
        detail: 'Sign in again to do this.',
        code: 'STEP_UP_REQUIRED',
        signInUrl: '/auth/oidc/start?prompt=login',
      }),
    );
    const { unmount } = render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    const link = await screen.findByRole('link', { name: 'Continue to Polaris ID' });
    link.addEventListener('click', (e) => e.preventDefault());
    await userEvent.click(link);
    unmount();
    render(<Host />);
    expect(screen.getByText('Delete this sandbox?')).toBeTruthy();
  });
});
