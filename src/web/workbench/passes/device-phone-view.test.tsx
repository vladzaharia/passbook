import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevicePassDto } from '@/shared/contracts/device-passes.ts';
import { json, problem, renderApp } from '../../lib/test-utils.tsx';
import { wideWindow } from '../events/test-fixtures.ts';
import { forgetTokens } from '../host/token.ts';
import { CONTEXTS } from '../shell/test-fixtures.ts';
import { ADA, BOB, passesHandlers, type World } from './test-fixtures.ts';

const ON = { ...CONTEXTS, sandbox: { ...CONTEXTS.sandbox, devicePass: true } };
const NOW = Date.now();

const dp = (over: Partial<DevicePassDto> = {}): DevicePassDto => ({
  id: 'dp1',
  passId: 'p1',
  state: 'active',
  voidReason: null,
  createdAt: NOW - 60_000,
  expiresAt: NOW + 23 * 3_600_000,
  deviceCount: 1,
  lastSeenAt: NOW - 30_000,
  code: null,
  ...over,
});

interface Dev {
  items: DevicePassDto[];
  active?: number;
  calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[];
  /** Answers a make with this problem instead. */
  refuse?: { status: number; code: string };
}

function deviceRoutes(d: Dev) {
  const record = (path: string, init?: RequestInit) =>
    d.calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
  const code = { url: '/d/abc123', expiresAt: NOW + 600_000 };
  const base = '/api/v1/developer/device-passes';
  const routes: Record<string, (u: URL, i?: RequestInit) => Response> = {
    [base]: (url, init) => {
      record(url.pathname, init);
      if (init?.method === 'POST') {
        if (d.refuse)
          return problem(
            d.refuse.status,
            d.refuse.code,
            'Device passes are paused for your account.',
          );
        return json({ devicePass: dp({ id: 'dp9', state: 'pending', deviceCount: 0, code }) }, 201);
      }
      return json({ items: d.items, active: d.active ?? d.items.length, limit: 5 });
    },
  };
  for (const id of ['dp1', 'dp2', 'dp3', 'dp9'])
    for (const tail of ['', '/code', '/again'])
      routes[`${base}/${id}${tail}`] = (url, init) => {
        record(url.pathname, init);
        const fresh = dp({ id: 'dp9', state: 'pending', deviceCount: 0, code });
        return json(
          {
            devicePass: tail === '' ? dp({ id, state: 'voided', voidReason: 'developer' }) : fresh,
          },
          tail === '' ? 200 : 201,
        );
      };
  return routes;
}

beforeEach(() => wideWindow());
afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

async function open(dev: Dev, contexts: unknown = ON) {
  const world: World = { passes: [ADA, BOB], calls: [], voided: new Set() };
  const path = '/workbench/o/sbx/passes?view=phone';
  history.replaceState(null, '', path);
  const view = await renderApp(path, {
    session: 'developer',
    handlers: { ...passesHandlers(world, contexts), ...deviceRoutes(dev) },
  });
  return { ...view, world };
}
const mine = (d: Dev, method: string) => d.calls.filter((c) => c.method === method);

describe('Device passes (sandbox On my phone)', () => {
  it('flag off: nothing shows and no device pass call is made', async () => {
    const dev: Dev = { items: [], calls: [] };
    await open(dev, CONTEXTS);
    await screen.findByRole('listbox', { name: 'Passes' });
    expect(screen.queryByRole('radiogroup', { name: 'Passes view' })).not.toBeInTheDocument();
    expect(screen.queryByText('Add to my phone')).not.toBeInTheDocument();
    expect(dev.calls).toEqual([]);
  });

  it('flag on: makes a device pass and shows its one-time QR and the code life', async () => {
    const user = userEvent.setup();
    const dev: Dev = { items: [dp({ id: 'dp1' })], calls: [] };
    await open(dev);
    await user.click(await screen.findByRole('button', { name: 'Add to my phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to your phone' });
    expect(
      await within(dialog).findByAltText('QR code to add Ada Lovelace to your phone'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Code works once · (9:5\d|10:00)/)).toBeInTheDocument();
    expect(within(dialog).getByText('Expires in 24 h, then voids')).toBeInTheDocument();
    const post = mine(dev, 'POST')[0];
    expect(post?.body).toEqual({ passId: 'p1' });
    expect(post?.headers['x-csrf-token']).toBe('csrf-test');
    expect(post?.headers['idempotency-key']).toBeTruthy();
    expect(post?.headers.authorization).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'New code' }));
    await waitFor(() => expect(mine(dev, 'POST').at(-1)?.path).toMatch(/\/dp9\/code$/));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('lists each pass with its phones of 3, voids it after a confirm, and adds again', async () => {
    const user = userEvent.setup();
    const dev: Dev = {
      items: [
        dp({ id: 'dp1', deviceCount: 2 }),
        dp({ id: 'dp2', state: 'expired', voidReason: 'expired', deviceCount: 1 }),
        dp({ id: 'dp3', state: 'voided', voidReason: 'overshared', deviceCount: 3 }),
      ],
      active: 1,
      calls: [],
    };
    await open(dev);
    const list = await screen.findByRole('region', { name: 'Device passes' });
    expect(await within(list).findByText('2 of 3 phones', { exact: false })).toBeInTheDocument();
    expect(within(list).getByText('Shared on a 4th phone')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Void' }));
    expect(screen.getByText('Void this device pass?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Void device pass' }));
    await waitFor(() => expect(mine(dev, 'DELETE')[0]?.path).toMatch(/\/dp1$/));
    await user.click(within(list).getAllByRole('button', { name: 'Add again' })[0] as HTMLElement);
    await waitFor(() => expect(mine(dev, 'POST').at(-1)?.path).toMatch(/\/dp2\/again$/));
    expect(await screen.findByRole('dialog', { name: 'Add to your phone' })).toBeInTheDocument();
  });

  it('blocked: the refusal pauses the buttons and says why', async () => {
    const user = userEvent.setup();
    const dev: Dev = { items: [], calls: [], refuse: { status: 403, code: 'DEVICE_PASS_BLOCKED' } };
    await open(dev);
    await user.click(await screen.findByRole('button', { name: 'Add to my phone' }));
    expect(await screen.findByText(/paused for your account/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to my phone' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('at 5 open it says so and the make button is disabled', async () => {
    const dev: Dev = { items: [dp()], active: 5, calls: [] };
    await open(dev);
    expect(await screen.findByText(/5 device passes open/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to my phone' })).toBeDisabled();
  });
});
