import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { ScanApiError } from '../api/errors.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { fixtureCard, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { LookupSheet } from './lookup-sheet.tsx';

function setup(allowPeople = true) {
  const base = fixtureCard();
  const card = fixtureCard({
    actions: base.actions.slice(0, 1).map((action) => ({
      ...action,
      id: 'check_in',
      label: 'Check in',
      kind: 'check_in',
      amount: null,
    })),
  });
  const lookup = vi.fn<ScanApi['lookup']>().mockResolvedValue({
    items: [
      {
        passId: card.passId,
        title: 'Anna Popescu',
        subtitle: 'Gold',
        templateName: 'Coffee card',
        status: 'active',
        maskedEmail: 'a***@example.test',
        photoUrl: null,
        doorState: null,
        lastScanAt: null,
      },
    ],
    more: false,
  });
  const resolve = vi.fn<ScanApi['resolve']>().mockResolvedValue({
    ...fixtureOutcome('ready', 'choose'),
    kind: 'ready',
    reason: 'choose',
    card,
  });
  const api = { lookup, resolve } as unknown as ScanApi;
  const onClose = vi.fn();
  const onCheckIn = vi.fn();
  const onCode = vi.fn();
  const view = render(
    <LookupSheet
      open
      allowPeople={allowPeople}
      api={api}
      onClose={onClose}
      onCheckIn={onCheckIn}
      onCode={onCode}
    />,
  );
  return {
    ...view,
    card,
    api,
    lookup,
    resolve,
    onClose,
    onCheckIn,
    onCode,
    user: userEvent.setup(),
  };
}

async function search(user: ReturnType<typeof userEvent.setup>, value = 'Anna') {
  const field = screen.getByRole('textbox', { name: 'Name, email, code or ID' });
  await user.type(field, value);
  return field;
}

describe('lookup review and keyboard navigation', () => {
  it('resolves a selected person and checks in only after the explicit primary', async () => {
    const { user, resolve, onCheckIn, card } = setup();
    const field = await search(user);
    expect(field).toHaveFocus();
    const row = await screen.findByRole('button', { name: /Anna Popescu Gold/ });
    expect(row).toHaveTextContent('a***@example.test');
    await user.keyboard('{ArrowDown}');
    expect(row).toHaveFocus();
    await user.click(row);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Anna Popescu' })).toHaveFocus(),
    );
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ input: { passId: card.passId, method: 'manual' } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onCheckIn).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('textbox')).toHaveValue('Anna');
    await user.click(await screen.findByRole('button', { name: /Anna Popescu Gold/ }));
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    expect(onCheckIn).toHaveBeenCalledWith(card, 'check_in');
  });

  it('requires a name prefix, shows an email hint and clears with Escape before closing', async () => {
    const { user, lookup, onClose } = setup();
    const field = await search(user, 'An');
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.getByText(/Type at least 3 letters/)).toBeVisible();
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
    await user.type(field, 'a@');
    expect(screen.getByText('Use the full email address.')).toBeVisible();
    await user.keyboard('{Escape}{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables lookup during Retry-After and aborts the request on close', async () => {
    const { user, lookup, unmount } = setup();
    lookup.mockRejectedValue(
      new ScanApiError({ status: 429, code: 'RATE_LIMITED', detail: 'Too many lookups.' }, 2000),
    );
    const field = await search(user);
    expect(await screen.findByText(/Too many lookups. Try again in 2 s./)).toBeVisible();
    expect(field).toBeDisabled();
    const signal = lookup.mock.calls[0]?.[1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('offers retry after a network failure and reports a capped result list', async () => {
    const { user, lookup, resolve, card } = setup();
    lookup.mockRejectedValueOnce(new Error('offline'));
    await search(user);
    expect(
      await screen.findByText('Could not look up this pass. Check your connection.'),
    ).toBeVisible();
    lookup.mockResolvedValueOnce({ items: [], more: false });
    resolve.mockResolvedValueOnce({
      ...fixtureOutcome('refused', 'not_found'),
      kind: 'refused',
      reason: 'not_found',
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No matches')).toBeVisible();
    lookup.mockResolvedValueOnce({
      items: Array.from({ length: 10 }, (_, i) => ({
        passId: `${card.passId}-${i}`,
        title: `Anna ${i}`,
        subtitle: null,
        templateName: card.template.name,
        status: 'active',
        maskedEmail: null,
        photoUrl: null,
        doorState: null,
        lastScanAt: null,
      })),
      more: true,
    });
    await user.type(screen.getByRole('textbox'), 'b');
    expect(
      await screen.findByText('Showing 10 matches. Keep typing to narrow the list.'),
    ).toBeVisible();
  });

  it('submits an entered code through the scan path when people lookup is disabled', async () => {
    const { user, resolve, onCheckIn, onCode } = setup(false);
    await user.type(screen.getByRole('textbox', { name: 'Code or ID' }), '0001234');
    await user.click(screen.getByRole('button', { name: 'Find pass' }));
    expect(onCode).toHaveBeenCalledExactlyOnceWith('0001234');
    expect(resolve).not.toHaveBeenCalled();
    expect(onCheckIn).not.toHaveBeenCalled();
  });

  it('submits a full code with slashes on Enter through the scan path', async () => {
    const { user, resolve, onCheckIn, onCode } = setup();
    const code = 'https://member.example.test/id/0001234';
    await user.type(screen.getByRole('textbox'), `${code}{Enter}`);
    await waitFor(() => expect(onCode).toHaveBeenCalledExactlyOnceWith(code));
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ input: { code, method: 'manual' } }),
      expect.anything(),
    );
    expect(onCheckIn).not.toHaveBeenCalled();
  });

  it('finds a person by full email on Enter and still requires confirmation', async () => {
    const { user, resolve, lookup, onCheckIn, card } = setup();
    resolve.mockResolvedValueOnce({
      ...fixtureOutcome('refused', 'not_found'),
      kind: 'refused',
      reason: 'not_found',
    });
    await user.type(screen.getByRole('textbox'), 'anna@example.test{Enter}');
    await screen.findByRole('heading', { name: 'Anna Popescu' });
    expect(lookup).toHaveBeenCalledWith({ q: 'anna@example.test' }, expect.anything());
    expect(resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { passId: card.passId, method: 'manual' } }),
      expect.anything(),
    );
    expect(onCheckIn).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check in' }));
    expect(onCheckIn).toHaveBeenCalledExactlyOnceWith(card, 'check_in');
  });

  it('does not search partial emails', async () => {
    const { user, lookup } = setup();
    await user.type(screen.getByRole('textbox'), 'anna@exam');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.getByText('Use the full email address.')).toBeVisible();
  });

  it('ignores a late code resolution after the query changes', async () => {
    const { user, resolve, onCheckIn, onCode } = setup();
    let reply: (value: Awaited<ReturnType<ScanApi['resolve']>>) => void = () => {};
    resolve.mockImplementationOnce(
      () =>
        new Promise((done) => {
          reply = done;
        }),
    );
    await user.type(screen.getByRole('textbox'), 'OLD{Enter}');
    const signal = resolve.mock.calls[0]?.[1]?.signal;
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'NEW');
    expect(signal?.aborted).toBe(true);
    reply({
      ...fixtureOutcome('ready', 'choose'),
      kind: 'ready',
      reason: 'choose',
      card: fixtureCard({ title: 'Old result' }),
    });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Old result' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('textbox')).toHaveValue('NEW');
    expect(onCode).not.toHaveBeenCalled();
    expect(onCheckIn).not.toHaveBeenCalled();
  });
});
