import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';
import {
  fixtureOperation,
  NOW,
  SANDBOX_RECREATE,
  SANDBOX_RESET,
} from '../../ui/operation/fixtures.test-support.ts';
import { resetOperationCache } from '../../ui/operation/store.ts';
import type { Operation } from '../../ui/operation/types.ts';
import { updateSession } from '../console/session.ts';
import { homeFresh } from '../home/home-fixtures.ts';
import { forgetTokens } from '../host/token.ts';
import { setSingleKeys } from '../shell/prefs.ts';
import { handlers } from '../shell/test-fixtures.ts';

vi.mock('../console/turnstile.ts', () => ({ verify: async () => 'tok' }));

afterEach(() => {
  forgetTokens();
  resetOperationCache();
  setSingleKeys(true);
  localStorage.clear();
  sessionStorage.clear();
});

const READY = {
  kind: 'ready',
  csrf: 'csrf-token',
  siteKey: 'site',
  sandbox: { id: 's1', orgId: 'sbx', orgSlug: 'dev-4f8c673e', templateId: null },
} as const;

const op = (def: typeof SANDBOX_RESET, status: 'running' | 'succeeded', id: string): Operation => ({
  ...fixtureOperation(def, { status, id }),
  orgId: 'sbx',
  mode: 'test',
  target: { type: 'org', id: 'sbx' },
  updatedAt: NOW,
});

const QUOTAS = {
  passes: { used: 3, limit: 25 },
  templates: { used: 1, limit: 3 },
  endpoints: { used: 1, limit: null },
  keys: { used: 1, limit: 5 },
};
const withQuotas = () => ({
  ...handlers(),
  '/api/v1/developer/home': () => json({ ...homeFresh, quotas: QUOTAS }),
});

describe('the Sandbox page', () => {
  it('shows the name and the limits, read with the session (the home route refuses a token)', async () => {
    updateSession(READY);
    const { fetchMock } = await renderApp('/workbench/o/sbx/sandbox', {
      session: 'developer',
      handlers: withQuotas(),
    });
    expect(await screen.findByText('3 of 25')).toBeInTheDocument();
    expect(screen.getByText('1 · No limit')).toBeInTheDocument();
    expect(screen.getAllByText('dev-4f8c673e').length).toBeGreaterThan(0);
    const read = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/developer/home'));
    expect(new Headers(((read?.[1] ?? {}) as RequestInit).headers).get('authorization')).toBeNull();
  });

  it('Reset confirms, then starts the operation with the write token and shows its steps', async () => {
    updateSession(READY);
    let started: RequestInit | undefined;
    const running = op(SANDBOX_RESET, 'running', 'op_reset');
    await renderApp('/workbench/o/sbx/sandbox', {
      session: 'developer',
      handlers: {
        ...withQuotas(),
        '/api/v1/developer/sandbox/reset': (_u, init) => {
          started = init;
          return json({ operation: running }, 202);
        },
        '/api/v1/operations/op_reset': () => json(running),
        '/api/v1/operations': () => json({ items: [] }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset this sandbox?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset sandbox' }));
    await waitFor(() => expect(started).toBeDefined());
    const headers = new Headers(started?.headers);
    // The person's own action: the write token, never the Workbench token.
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-csrf-token')).toBe('csrf-token');
    expect([...headers.keys()].some((h) => /mode/i.test(h))).toBe(false);
    expect(JSON.parse(String(started?.body))).toEqual({ turnstileToken: 'tok' });
    // The operation is the page's progress: its steps, and the actions stay off while it runs.
    expect((await screen.findAllByText(/Revoking the old key/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });
});

describe('mid-reset (design §6)', () => {
  it('a tool shows one Resetting status while a reset runs, and the tool again after', async () => {
    updateSession(READY);
    const items: Operation[] = [op(SANDBOX_RESET, 'running', 'op_reset')];
    await renderApp('/workbench/o/sbx/logs', {
      session: 'developer',
      handlers: {
        ...handlers(),
        '/api/v1/operations': () => json({ items }),
        '/api/v1/operations/op_reset': () => json(items[0]),
      },
    });
    const word = await screen.findByText('Resetting');
    const status = word.closest('[role="status"]');
    expect(status).toHaveAttribute('aria-busy');
    expect(status).not.toHaveAttribute('tabindex');
    expect(screen.getAllByRole('status').filter((s) => s.textContent === 'Resetting')).toHaveLength(
      1,
    );
    expect(screen.queryByRole('heading', { name: 'Logs', level: 1 })).toBeInTheDocument();
  });

  it('Sandbox and Quickstart keep their own page while it runs', async () => {
    updateSession(READY);
    await renderApp('/workbench/o/sbx/sandbox', {
      session: 'developer',
      handlers: {
        ...withQuotas(),
        '/api/v1/operations': () => json({ items: [op(SANDBOX_RECREATE, 'running', 'op_re')] }),
      },
    });
    await screen.findByRole('heading', { name: 'Sandbox', level: 1 });
    await screen.findByRole('button', { name: /^Activity, 1 running/ });
    expect(screen.queryByText('Resetting')).not.toBeInTheDocument();
  });
});

describe("the switcher's Danger group", () => {
  const open = async () =>
    userEvent.click(
      await screen.findByRole('button', { name: /^dev-4f8c673e Sandbox · Test, Switch context$/ }),
    );

  it('is the sandbox only, behind a confirm, and starts the delete with the write token', async () => {
    updateSession(READY);
    let deleted: RequestInit | undefined;
    await renderApp('/workbench/o/sbx', {
      session: 'developer',
      handlers: {
        ...handlers(),
        '/api/v1/developer/sandbox': (_u, init) => {
          if (init?.method !== 'DELETE')
            return json({ sandbox: READY.sandbox, turnstileSiteKey: 'site' });
          deleted = init;
          return json({ operation: op(SANDBOX_RESET, 'running', 'op_del') }, 202);
        },
      },
    });
    await open();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Danger')).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Delete sandbox' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this sandbox?' });
    expect(deleted).toBeUndefined();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete sandbox' }));
    await waitFor(() => expect(deleted).toBeDefined());
    expect(new Headers(deleted?.headers).get('x-csrf-token')).toBe('csrf-token');
  });

  it('an organization has no Danger group', async () => {
    updateSession(READY);
    await renderApp('/workbench/o/nw/logs', { session: 'developer', handlers: handlers() });
    await userEvent.click(await screen.findByRole('button', { name: /Switch context$/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText('Danger')).not.toBeInTheDocument();
  });
});
