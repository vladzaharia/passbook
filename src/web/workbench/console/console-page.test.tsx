import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';
import { writePrefill } from '../host/prefill.ts';
import { forgetTokens } from '../host/token.ts';
import { handlers as shellHandlers } from '../shell/test-fixtures.ts';
import { resetBudget } from './budget.ts';
import { resetTemplateInput } from './template-sample.ts';
import type { RunFile, RunIndex, RunOp } from './types.ts';

const base: RunOp = {
  id: 'passes.list',
  anchor: 'list',
  title: 'List passes',
  method: 'get',
  path: '/api/v1/passes',
  idempotent: false,
  destructive: false,
  params: [],
  body: null,
  example: undefined,
  wb: true,
  sdk: { call: 'pb.passes.list', paged: true },
};
const create: RunOp = {
  ...base,
  id: 'passes.create',
  anchor: 'create',
  title: 'Create a pass',
  method: 'post',
  idempotent: true,
  body: { type: 'object', properties: { templateId: { type: 'string' } } },
  example: { templateId: 'tpl_x' },
  sdk: { call: 'pb.passes.create' },
  samples: { 'guide-1': { body: { templateId: 'tpl_guide', holderEmail: 'guide@example.com' } } },
};
const remove: RunOp = {
  ...base,
  id: 'passes.remove',
  anchor: 'remove',
  title: 'Remove a pass',
  method: 'delete',
  path: '/api/v1/passes/{id}',
  destructive: true,
  params: [
    { name: 'id', where: 'path', required: true, schema: { type: 'string' }, description: '' },
  ],
  sdk: { call: 'pb.passes.remove', noContent: true },
};
const locked: RunOp = {
  ...base,
  id: 'connections.list',
  anchor: 'list',
  title: 'List connections',
  path: '/api/v1/connections',
  wb: false,
  sdk: { call: 'pb.connections.list' },
};
const item = (o: RunOp) => ({
  id: o.id,
  slug: o.id.startsWith('conn') ? 'connections' : 'passes',
  anchor: o.anchor,
  method: o.method,
  path: o.path,
  title: o.title,
  destructive: o.destructive,
  wb: o.wb,
});
const INDEX: RunIndex = {
  codes: [],
  groups: [
    { label: 'Passes', items: [base, create, remove].map(item) },
    { label: 'Connections', items: [item(locked)] },
  ],
};
const file = (ops: RunOp[]): RunFile => ({ origin: 'https://passbook.mobile', ops });

function setup(extra: Record<string, (url: URL, init?: RequestInit) => Response> = {}) {
  const hits: { path: string; init: RequestInit }[] = [];
  const record =
    (body: unknown) =>
    (url: URL, init?: RequestInit): Response => {
      hits.push({ path: url.pathname, init: init ?? {} });
      return json(body);
    };
  return {
    hits,
    handlers: {
      ...shellHandlers(),
      '/developers/run/index.json': () => json(INDEX),
      '/developers/run/passes.json': () => json(file([base, create, remove])),
      '/developers/run/connections.json': () => json(file([locked])),
      '/api/v1/passes': record({ items: [] }),
      '/api/v1/passes/p1': record({}),
      '/api/v1/connections': record({ items: [] }),
      '/api/v1/templates': () => json({ items: [{ id: 'tpl_org' }] }),
      ...extra,
    },
  };
}

const headers = (init: RequestInit) => Object.fromEntries(new Headers(init.headers).entries());

beforeEach(() => {
  resetBudget();
  resetTemplateInput();
  sessionStorage.clear();
});
afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
});

describe('the Console on the Workbench token', () => {
  it('never runs on arrival, and runs with the bearer and no mode header', async () => {
    const { hits, handlers } = setup();
    await renderApp('/workbench/o/nw/console?op=passes.list', { session: 'developer', handlers });
    await screen.findByRole('button', { name: 'Run' });
    expect(hits.filter((h) => h.path === '/api/v1/passes')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findAllByText('200 OK');
    const call = hits.find((h) => h.path === '/api/v1/passes');
    expect(headers(call?.init ?? {}).authorization).toBe('Bearer pbtry_nw');
    expect(Object.keys(headers(call?.init ?? {})).some((h) => /mode/i.test(h))).toBe(false);
  });

  it('reads no sandbox from the session: every tenant call carries the token', async () => {
    const { handlers } = setup();
    const { fetchMock } = await renderApp('/workbench/o/nw/console?op=passes.list', {
      session: 'developer',
      handlers,
    });
    await screen.findByRole('button', { name: 'Run' });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findAllByText('200 OK');
    const account = new Set([
      '/api/v1/session',
      '/api/v1/workbench/contexts',
      '/api/v1/workbench/token',
      '/api/v1/orgs/memberships/me',
      '/api/v1/orgs',
    ]);
    const calls = fetchMock.mock.calls
      .map(([url, init]) => ({
        path: new URL(String(url), 'http://localhost').pathname,
        init: (init ?? {}) as RequestInit,
      }))
      .filter(({ path }) => path.startsWith('/api/') && !account.has(path));
    expect(calls.map((c) => c.path)).not.toContain('/api/v1/developer/sandbox');
    for (const { path, init } of calls)
      expect(headers(init).authorization, path).toMatch(/^Bearer pbtry_nw$/);
  });

  it('disables an operation a member token cannot call, with the reason, and still copies it', async () => {
    const { handlers } = setup();
    await renderApp('/workbench/o/nw/console?op=connections.list', {
      session: 'developer',
      handlers,
    });
    const run = await screen.findByRole('button', { name: /Run/ });
    expect(run).toBeDisabled();
    expect(screen.getByText(/Not available in Test/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'curl' }));
    expect((await screen.findByRole('tabpanel')).textContent).toContain('PASSBOOK_KEY');
  });

  it('asks before a destructive call, and sends it only on confirm', async () => {
    const { hits, handlers } = setup();
    await renderApp('/workbench/o/nw/console?op=passes.remove', { session: 'developer', handlers });
    const id = await screen.findByLabelText(/^id/);
    await userEvent.type(id, 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('DELETE');
    expect(hits.filter((h) => h.path === '/api/v1/passes/p1')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Run DELETE' }));
    await waitFor(() => expect(hits.some((h) => h.path === '/api/v1/passes/p1')).toBe(true));
  });

  it('fills from a handoff nonce once, and keeps it out of the address', async () => {
    const nonce = writePrefill({ op: 'passes.create', body: { templateId: 'tpl_hand' } });
    const { handlers } = setup();
    const { router } = await renderApp(
      `/workbench/o/nw/console?op=passes.create&prefill=${nonce}`,
      {
        session: 'developer',
        handlers,
      },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'JSON' }));
    expect(await screen.findByDisplayValue(/tpl_hand/)).toBeInTheDocument();
    expect(sessionStorage.getItem(`wb-prefill:${nonce}`)).toBeNull();
    expect(router.state.location.searchStr).not.toContain('tpl_hand');
  });

  it("fills from a guide's snippet", async () => {
    const { handlers } = setup();
    await renderApp('/workbench/o/nw/console?op=passes.create&sample=guide-1', {
      session: 'developer',
      handlers,
    });
    // A guide's ids are example ids: the form shows the org's own template, as a reference example does.
    await userEvent.click(await screen.findByRole('tab', { name: 'JSON' }));
    const shown = (await screen.findByDisplayValue(/tpl_org/)) as HTMLTextAreaElement;
    expect(shown.value).toContain('guide@example.com');
  });

  it('fills from a logged call, naming its operation and ids', async () => {
    const { handlers } = setup({
      '/api/v1/request-logs/req_1': () =>
        json({
          method: 'POST',
          path: '/api/v1/passes',
          query: '',
          requestBody: '{"templateId":"tpl_logged"}',
        }),
    });
    await renderApp('/workbench/o/nw/console?from=req_1', { session: 'developer', handlers });
    expect(await screen.findByText('From req_1')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('tab', { name: 'JSON' }));
    expect(await screen.findByDisplayValue(/tpl_logged/)).toBeInTheDocument();
  });

  it('says so when the logged call is gone, and shows the sample', async () => {
    const { handlers } = setup();
    await renderApp('/workbench/o/nw/console?op=passes.create&from=req_gone', {
      session: 'developer',
      handlers,
    });
    expect(await screen.findByText('That call is gone. This is the sample.')).toBeInTheDocument();
  });

  it('writes the key as $PASSBOOK_KEY in every line and never the token', async () => {
    const { handlers } = setup();
    await renderApp('/workbench/o/nw/console?op=passes.create', { session: 'developer', handlers });
    for (const name of ['curl', 'TypeScript', 'Python', 'Go']) {
      await userEvent.click(await screen.findByRole('tab', { name }));
      const text = (await screen.findByRole('tabpanel')).textContent ?? '';
      expect(text, name).toContain('PASSBOOK_KEY');
      expect(text, name).not.toContain('pbtry_');
    }
  });
});
