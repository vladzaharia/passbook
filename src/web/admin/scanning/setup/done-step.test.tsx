import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FetchHandler, json, renderApp } from '@/web/lib/test-utils.tsx';
import { appliedResult, appOptions, factHandlers, pairing, setupRoute } from './test-fixtures.ts';

beforeEach(() => {
  window.scrollTo = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

async function reachDone(handlers: Record<string, FetchHandler>) {
  const user = userEvent.setup();
  const app = await renderApp('/admin/o/o1/scanning/setup?preset=event_night', {
    ...appOptions,
    handlers: {
      ...factHandlers,
      '/api/v1/scanning-sessions/setup': setupRoute(),
      ...handlers,
    },
  });
  await screen.findByRole('textbox', { name: /Door name/ });
  const next = (name = 'Next') => user.click(screen.getByRole('button', { name }));
  await next();
  await user.click(await screen.findByRole('switch', { name: 'Any pass type' }));
  await next();
  await next();
  await next();
  await next('Review');
  await user.click(await screen.findByRole('button', { name: 'Set up' }));
  await screen.findByRole('heading', { name: 'Front desk is ready' });
  return { user, ...app };
}

describe('Done', () => {
  it('rolls one QR through the devices as each pairs', async () => {
    let polls = 0;
    await reachDone({
      '/api/v1/scanners/dev-1/pairing': () => {
        polls++;
        return json(
          polls < 2
            ? { state: 'waiting', device: null }
            : { state: 'paired', device: { label: 'Safari on iPhone', at: Date.now() } },
        );
      },
      '/api/v1/scanners/dev-2/pairing': () => json({ state: 'waiting', device: null }),
    });
    expect(screen.getByText('ABCDE-FGHJK')).toBeInTheDocument();
    expect(screen.getByText(/of 2 paired/)).toHaveTextContent('0 of 2 paired');
    // The first device pairs; the second device's code takes the QR.
    expect(await screen.findByText('KLMNP-QRSTU', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText(/of 2 paired/)).toHaveTextContent('1 of 2 paired');
    const devices = screen.getByRole('region', { name: 'Devices' });
    expect(within(devices).getByText('Paired')).toBeInTheDocument();
  }, 15_000);

  it('shows each PIN in clear, once, with Copy all', async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    const { user } = await reachDone({
      '/api/v1/scanners/dev-1/pairing': () => json({ state: 'waiting', device: null }),
    });
    const pins = screen.getByRole('region', { name: 'PINs' });
    expect(within(pins).getByText('Shown once')).toBeInTheDocument();
    expect(within(pins).getByText('482 913')).toBeInTheDocument();
    expect(within(pins).getByText('730 561')).toBeInTheDocument();
    await user.click(within(pins).getByRole('button', { name: 'Copy all' }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        'Sam Ortiz (Manager): 482913\nPriya Nair (Door): 730561',
      ),
    );
    expect(screen.getByRole('button', { name: 'Open session' })).toBeInTheDocument();
  });

  it('asks for a new code once one is spent', async () => {
    let made = 0;
    const { user } = await reachDone({
      '/api/v1/scanning-sessions/setup': setupRoute(() =>
        json(
          appliedResult({
            sessions: [
              {
                id: 's-new',
                ref: 'door-1',
                name: 'Front desk',
                devices: [
                  {
                    id: 'dev-1',
                    name: 'Front desk 1',
                    pairing: pairing('ABCDEFGHJK', Date.now() - 1),
                  },
                ],
              },
            ],
          }),
        ),
      ),
      '/api/v1/scanners/dev-1/pairing': (_url, i) => {
        if (i?.method === 'POST') {
          made++;
          return json(pairing('ZZZZZYYYYY'));
        }
        return json({ state: 'expired', device: null });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'New code' }));
    expect(await screen.findByText('ZZZZZ-YYYYY')).toBeInTheDocument();
    expect(made).toBe(1);
  });
});
