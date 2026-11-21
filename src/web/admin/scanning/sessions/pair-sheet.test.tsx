import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomShims, json, stubFetch } from '@/web/lib/test-utils.tsx';
import { pairing } from '../setup/test-fixtures.ts';
import { PairSheet } from './pair-sheet.tsx';
import { managedSession } from './test-fixtures.ts';

const base = managedSession.devices[0];
const device = (n: number) => ({
  ...base,
  id: `dev-${n}`,
  name: `Door ${n}`,
  paired: false,
  pairing: pairing(n === 1 ? 'ABCDEFGHJK' : 'KLMNPQRSTU'),
});

function setup(states: Record<string, 'waiting' | 'paired'>) {
  let made = 0;
  const calls: string[] = [];
  const handlers: Parameters<typeof stubFetch>[0] = {
    '/api/v1/scanning-sessions/session-1/devices': () => {
      made++;
      calls.push(`create ${made}`);
      return json(device(made), 201);
    },
  };
  for (const n of [1, 2, 3]) {
    handlers[`/api/v1/scanners/dev-${n}/pairing`] = () =>
      json({ state: states[`dev-${n}`] ?? 'waiting', device: null });
    handlers[`/api/v1/scanners/dev-${n}/revoke`] = () => {
      calls.push(`revoke ${n}`);
      return json({ id: `dev-${n}` });
    };
  }
  stubFetch(handlers);
  return calls;
}

function open(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PairSheet sessionId="session-1" onClose={onClose} pollMs={20} />
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => installDomShims());
afterEach(() => vi.unstubAllGlobals());

describe('PairSheet', () => {
  it('rolls to the next code when a device pairs, with one unpaired row at a time', async () => {
    const calls = setup({ 'dev-1': 'paired' });
    open();
    expect(await screen.findByText('KLMNP-QRSTU', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('1 paired')).toBeInTheDocument();
    expect(screen.getByText('Door 1')).toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith('create'))).toEqual(['create 1', 'create 2']);
    expect(screen.queryByText('ABCDE-FGHJK')).not.toBeInTheDocument();
  });

  it('revokes the unpaired row on close', async () => {
    const calls = setup({});
    const onClose = open();
    await screen.findByText('ABCDE-FGHJK');
    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toContain('revoke 1'));
    expect(onClose).toHaveBeenCalled();
    expect(calls.filter((c) => c.startsWith('create'))).toHaveLength(1);
  });
});
