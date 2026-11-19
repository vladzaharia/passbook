import { screen, waitFor, within } from '@testing-library/react';
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
  // Off asks first, with the count and what happens to copies.
  const ask = await screen.findByRole('alertdialog');
  expect(ask).toHaveTextContent('Turn off Apple Wallet for 2 passes?');
  expect(ask).toHaveTextContent('Copies keep working until New code.');
  expect(calls(fetchMock, 'POST', '/bulk/channels')).toHaveLength(0);
  await userEvent.click(within(ask).getByRole('button', { name: 'Turn off' }));
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

it('Use template applies at once, without a confirm', async () => {
  const onDone = vi.fn();
  const { fetchMock } = renderTags(
    <BulkChannelsDialog open onOpenChange={() => {}} orgId="o1" ids={['a']} onDone={onDone} />,
    { '/api/v1/passes/bulk/channels': () => json({ done: 1, skipped: [] }) },
  );
  await userEvent.click(await screen.findByRole('radio', { name: 'Use template' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Paper' }));
  await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(screen.queryByRole('alertdialog')).toBeNull();
  const [, init] = calls(fetchMock, 'POST', '/bulk/channels')[0] ?? [];
  expect(JSON.parse(String(init?.body))).toMatchObject({
    action: 'reset',
    channels: ['paper'],
    notify: false,
  });
});

it('adds replaceCodes only when asked, for a digital channel turned off', async () => {
  const { fetchMock } = renderTags(
    <BulkChannelsDialog open onOpenChange={() => {}} orgId="o1" ids={['a']} onDone={() => {}} />,
    { '/api/v1/passes/bulk/channels': () => json({ done: 1, skipped: [] }) },
  );
  expect(screen.queryByRole('checkbox', { name: 'Also issue new codes' })).toBeNull();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Paper' }));
  expect(screen.queryByRole('checkbox', { name: 'Also issue new codes' })).toBeNull();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Apple Wallet' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Also issue new codes' }));
  await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
  const ask = await screen.findByRole('alertdialog');
  expect(ask).toHaveTextContent('Holders get a new code. Printed tickets keep working.');
  await userEvent.click(within(ask).getByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(calls(fetchMock, 'POST', '/bulk/channels')).toHaveLength(1));
  const [, init] = calls(fetchMock, 'POST', '/bulk/channels')[0] ?? [];
  expect(JSON.parse(String(init?.body))).toMatchObject({ replaceCodes: true });
});
