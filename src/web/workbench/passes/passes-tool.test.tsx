import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../lib/test-utils.tsx';
import { wideWindow } from '../events/test-fixtures.ts';
import { forgetTokens } from '../host/token.ts';
import { ADA, BOB, passesHandlers, type World } from './test-fixtures.ts';

beforeEach(() => {
  wideWindow();
});
afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

const world = (over: Partial<World> = {}): World => ({
  passes: [ADA, BOB],
  calls: [],
  voided: new Set(),
  ...over,
});

async function open(path: string, w = world()) {
  const [route, hash = ''] = path.split('#');
  history.replaceState(null, '', `${route}${hash ? `#${hash}` : ''}`);
  const view = await renderApp(path, { session: 'developer', handlers: passesHandlers(w) });
  return { ...view, world: w };
}

const list = () => screen.findByRole('listbox', { name: 'Passes' });

describe('Passes', () => {
  it('lists the context Test passes on the token, with no mode header', async () => {
    const { world: w } = await open('/workbench/o/sbx/passes');
    const rows = within(await list()).getAllByRole('option');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ada Lovelace');
    expect(rows[1]).toHaveTextContent('Voided');
    const read = w.calls.filter((c) => c.path === '/api/v1/passes');
    expect(read.length).toBeGreaterThan(0);
    expect(read[0]?.search).toContain('orgId=sbx');
    for (const c of w.calls) {
      expect(c.headers.authorization, c.path).toBe('Bearer pbtry_sbx');
      expect(Object.keys(c.headers).filter((h) => /mode/i.test(h))).toEqual([]);
    }
  });

  it('says No passes with the way to Design when there are none', async () => {
    await open('/workbench/o/sbx/passes', world({ passes: [] }));
    expect(await screen.findByText('No passes')).toBeInTheDocument();
    for (const name of ['New pass', 'Make one in Design'])
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', '/workbench/o/sbx/design');
  });

  it('opens a pass from #id: its stage, actions and the shared trail', async () => {
    const { world: w } = await open('/workbench/o/sbx/passes#p1');
    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Ada Lovelace preview' })).toBeInTheDocument();
    for (const name of ['Test preview', 'Simulate', 'Open in Console', 'Void'])
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    // The pass's events, then the trail: admin's component, flat, on this tab's token.
    expect(await screen.findByRole('tab', { name: 'Events', selected: true })).toBeInTheDocument();
    const events = await screen.findByRole('region', { name: 'Events' });
    expect(await within(events).findByText('pass.installed')).toBeInTheDocument();
    expect(within(events).getByText('simulated')).toBeInTheDocument();
    expect(within(events).getByRole('link', { name: /request/ })).toHaveAttribute(
      'href',
      '/workbench/o/sbx/logs#req1',
    );
    expect(screen.getByRole('region', { name: 'Sync log' })).toBeInTheDocument();
    expect(w.calls.find((c) => c.path === '/api/v1/events')?.search).toContain('passId=p1');
    await waitFor(() =>
      expect(w.calls.some((c) => c.path === '/api/v1/passes/p1/events')).toBe(true),
    );
  });

  it('simulates a real Test event and says so', async () => {
    const user = userEvent.setup();
    const { world: w } = await open('/workbench/o/sbx/passes#p1');
    await user.click(await screen.findByRole('button', { name: 'Simulate' }));
    const menu = screen.getByRole('menu', { name: 'Simulate' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(7);
    expect(within(menu).getByText('Sends real Test events')).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Installed' }));
    await waitFor(() => {
      const sent = w.calls.find((c) => c.path === '/api/v1/passes/p1/simulate');
      expect(sent?.method).toBe('POST');
      expect(sent?.body).toEqual({ event: 'installed' });
      expect(sent?.headers.authorization).toBe('Bearer pbtry_sbx');
    });
  });

  it('keeps the phone and void panels open when the window crosses 1180 px', async () => {
    const user = userEvent.setup();
    Object.assign(HTMLDialogElement.prototype, {
      showModal(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
      close(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });
    let wide = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() {
        return q.includes('1180') ? wide : q.includes('720') || q.includes('reduce');
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
    await open('/workbench/o/sbx/passes#p1');
    await user.click(await screen.findByRole('button', { name: 'Test preview' }));
    await user.click(screen.getByRole('button', { name: 'Void' }));
    expect(screen.getByRole('button', { name: 'Test preview' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    wide = false;
    act(() => {
      for (const fn of listeners) fn();
    });
    const phone = await screen.findByRole('button', { name: 'Test preview' });
    expect(phone).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Void' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('Open in Console prefills by nonce and never puts a body in the URL', async () => {
    const user = userEvent.setup();
    const { router } = await open('/workbench/o/sbx/passes#p1');
    await user.click(await screen.findByRole('button', { name: 'Open in Console' }));
    await user.click(screen.getByRole('menuitem', { name: 'Void this pass' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/workbench/o/sbx/console'));
    const search = router.state.location.search as Record<string, string>;
    expect(search.op).toBe('passes.postPassesByIdVoid');
    const stored = JSON.parse(sessionStorage.getItem(`wb-prefill:${search.prefill}`) ?? '{}');
    expect(stored).toEqual({ op: 'passes.postPassesByIdVoid', path: { id: 'p1' } });
    expect(router.state.location.href).not.toMatch(/body/i);
  });

  it('voids only after the confirm, and then reads Voided', async () => {
    const user = userEvent.setup();
    const { world: w } = await open('/workbench/o/sbx/passes#p1');
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    expect(w.calls.some((c) => c.path.endsWith('/void'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Void pass' }));
    await waitFor(() =>
      expect(w.calls.some((c) => c.path === '/api/v1/passes/p1/void')).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Void pass' })).not.toBeInTheDocument(),
    );
  });

  it('Calls reads the request log narrowed to the pass', async () => {
    const user = userEvent.setup();
    const { world: w } = await open('/workbench/o/sbx/passes#p1');
    await user.click(await screen.findByRole('tab', { name: 'Calls' }));
    expect(await screen.findByText(/PATCH .*passes\/p1/)).toBeInTheDocument();
    const read = w.calls.find((c) => c.path === '/api/v1/request-logs');
    expect(read?.search).toContain('passId=p1');
    expect(screen.getByRole('link', { name: /All in Logs/ })).toHaveAttribute(
      'href',
      '/workbench/o/sbx/logs?pass=p1',
    );
  });

  it('Devices and Versions never ask for what the token may not read', async () => {
    const user = userEvent.setup();
    const { world: w } = await open('/workbench/o/sbx/passes#p1');
    await user.click(await screen.findByRole('tab', { name: 'Devices' }));
    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(await screen.findByRole('heading', { name: 'Versions' })).toBeInTheDocument();
    // No retained-version read and no wallet-provider status: neither is on the allowlist.
    expect(screen.queryByRole('button', { name: /Preview v/ })).not.toBeInTheDocument();
    expect(w.calls.some((c) => /\/versions\/|wallet-provider/.test(c.path))).toBe(false);
  });
});

describe('On my phone', () => {
  const org = (over: Partial<World> = {}) =>
    open(
      '/workbench/o/nw/passes?view=phone',
      world({ passes: [ADA, BOB].map((p) => ({ ...p, orgId: 'nw' })), ...over }),
    );

  it("an org's Test lists active passes by their real link", async () => {
    await org();
    const section = await screen.findByRole('list', { name: 'On my phone' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(1);
    const open = await within(section).findByRole('link', { name: 'Open on this phone' });
    expect(open.getAttribute('href')).toMatch(/\/p\/p1\/pass\.pkpass$/);
    expect(screen.getByRole('radio', { name: 'On my phone' })).toBeChecked();
  });

  it('a sandbox has no On my phone view while the device pass is off, and says Test preview', async () => {
    await open('/workbench/o/sbx/passes?view=phone');
    expect(await list()).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Passes view' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Add to my phone/)).not.toBeInTheDocument();
  });

  it("an org's pass offers Add to Wallet, opening its link as a QR in place", async () => {
    const user = userEvent.setup();
    await open('/workbench/o/nw/passes#p1', world({ passes: [{ ...ADA, orgId: 'nw' }] }));
    await user.click(await screen.findByRole('button', { name: 'Add to Wallet' }));
    expect(await screen.findByRole('link', { name: 'Open on this phone' })).toHaveAttribute(
      'href',
      expect.stringMatching(/pass\.pkpass$/),
    );
  });
});
