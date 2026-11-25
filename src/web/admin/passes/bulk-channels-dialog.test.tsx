import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json } from '@/web/lib/test-utils.tsx';
import { calls, renderTags } from '../tags/test-fixtures.tsx';
import { BulkChannelsDialog } from './bulk-channels-dialog.tsx';

afterEach(() => vi.restoreAllMocks());

/** The applying POSTs; the dry-run previews are not changes. */
const applies = (m: Parameters<typeof calls>[0]) =>
  calls(m, 'POST', '/bulk/channels').filter(([, init]) => !JSON.parse(String(init?.body)).dryRun);

it('sends the action, the ticked channels and no holder email by default', async () => {
  const onDone = vi.fn();
  const { fetchMock } = renderTags(
    <BulkChannelsDialog open onOpenChange={() => {}} orgId="o1" ids={['a', 'b']} onDone={onDone} />,
    { '/api/v1/passes/bulk/channels': () => json({ done: 2, skipped: [] }) },
  );
  // Nothing ticked: Next explains instead of moving on.
  await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Pick a channel.', { selector: 'p' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Apple Wallet' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  // Off ends on a review with the count and what happens to copies, not a nested confirm.
  const review = await screen.findByRole('region', { name: 'Channels' });
  expect(review).toHaveTextContent('2 passes');
  expect(review).toHaveTextContent('Apple Wallet');
  expect(screen.getByText('Copies keep working until New code.')).toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(applies(fetchMock)).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  const [, init] = applies(fetchMock)[0] ?? [];
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
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Apple Wallet' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByRole('checkbox', { name: /Email holders/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  await userEvent.click(screen.getByRole('radio', { name: 'On' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  // On has no holders step: the next step is the review.
  expect(await screen.findByRole('region', { name: 'Channels' })).toBeInTheDocument();
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
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(screen.getByRole('button', { name: 'Use template' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(screen.queryByRole('alertdialog')).toBeNull();
  const [, init] = applies(fetchMock)[0] ?? [];
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
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  const review = await screen.findByRole('region', { name: 'Channels' });
  expect(review).toHaveTextContent('1 pass');
  expect(review).toHaveTextContent('New codesYes');
  expect(screen.queryByText('Copies keep working until New code.')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(applies(fetchMock)).toHaveLength(1));
  const [, init] = applies(fetchMock)[0] ?? [];
  expect(JSON.parse(String(init?.body))).toMatchObject({ replaceCodes: true });
});

it('previews counts and windows before applying, and applies nothing', async () => {
  const { fetchMock } = renderTags(
    <BulkChannelsDialog
      open
      onOpenChange={() => {}}
      orgId="o1"
      ids={['a', 'b']}
      onDone={() => {}}
    />,
    {
      '/api/v1/passes/bulk/channels': () =>
        json({
          done: 0,
          skipped: [],
          preview: {
            impact: [{ channel: 'apple', passes: 2, rotated: 1 }],
            unsupported: 1,
            allOff: 0,
            blocked: { name: 'Gala', closesAt: 1_800_003_600_000 },
            windows: [],
          },
        }),
    },
  );
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Apple Wallet' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Also issue new codes' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(
    await screen.findByText(/Turns off Apple Wallet for 1 pass and issues a new code/),
  ).toBeInTheDocument();
  expect(screen.getByText(/1 pass turns off without a new code/)).toBeInTheDocument();
  expect(screen.getByText(/New codes wait until Gala ends/)).toBeInTheDocument();
  const bodies = calls(fetchMock, 'POST', '/bulk/channels').map(([, init]) =>
    JSON.parse(String(init?.body)),
  );
  expect(bodies.at(-1)).toMatchObject({ dryRun: true, replaceCodes: true, channels: ['apple'] });
  expect(bodies.every((b) => b.dryRun === true)).toBe(true);
});

it('asks once for a burst of choices, 300 ms after the last', async () => {
  const { fetchMock } = renderTags(
    <BulkChannelsDialog open onOpenChange={() => {}} orgId="o1" ids={['a']} onDone={() => {}} />,
    {
      '/api/v1/passes/bulk/channels': () =>
        json({
          done: 0,
          skipped: [],
          preview: { impact: [], unsupported: 0, allOff: 0, blocked: null, windows: [] },
        }),
    },
  );
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Apple Wallet' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Google Wallet' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Also issue new codes' }));
  await waitFor(() => expect(calls(fetchMock, 'POST', '/bulk/channels').length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 450));
  const sent = calls(fetchMock, 'POST', '/bulk/channels').map(([, init]) =>
    JSON.parse(String(init?.body)),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    channels: ['apple', 'google'],
    replaceCodes: true,
    dryRun: true,
  });
});
