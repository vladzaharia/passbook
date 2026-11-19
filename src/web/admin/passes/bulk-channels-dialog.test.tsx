import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json } from '@/web/lib/test-utils.tsx';
import { calls, renderTags } from '../tags/test-fixtures.tsx';
import { BulkChannelsDialog } from './bulk-channels-dialog.tsx';

afterEach(() => vi.restoreAllMocks());

it('sends the action, the ticked channels and no holder email by default', async () => {
  const onDone = vi.fn();
  const { fetchMock } = renderTags(
    <BulkChannelsDialog open onOpenChange={() => {}} orgId="o1" ids={['a', 'b']} onDone={onDone} />,
    { '/api/v1/passes/bulk/channels': () => json({ done: 2, skipped: [] }) },
  );
  expect(await screen.findByRole('button', { name: 'Apply' })).toBeDisabled();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Apple Wallet' }));
  await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  const [, init] = calls(fetchMock, 'POST', '/bulk/channels')[0] ?? [];
  expect(JSON.parse(String(init?.body))).toEqual({
    action: 'off',
    channels: ['apple'],
    ids: ['a', 'b'],
    notify: false,
    orgId: 'o1',
  });
});

it('offers the holder email only for Off', async () => {
  renderTags(
    <BulkChannelsDialog open onOpenChange={() => {}} orgId="o1" ids={['a']} onDone={() => {}} />,
  );
  expect(await screen.findByRole('checkbox', { name: /Email holders/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'On' }));
  expect(screen.queryByRole('checkbox', { name: /Email holders/ })).toBeNull();
});
