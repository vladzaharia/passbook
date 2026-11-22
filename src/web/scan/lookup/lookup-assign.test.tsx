import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { fixtureCard, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { LookupSheet } from './lookup-sheet.tsx';

const row = (passId: string) => ({
  passId,
  title: 'Anna Popescu',
  subtitle: 'Gold',
  templateName: 'Staff badge',
  status: 'active' as const,
  maskedEmail: null,
  photoUrl: null,
  doorState: null,
  lastScanAt: null,
});

/** Look up opened from the assign card: a pick is a pass for the tag, never a check-in. */
function setup(found: 'not_found' | 'ambiguous' | 'choose' = 'not_found') {
  const card = fixtureCard();
  const lookup = vi.fn<ScanApi['lookup']>().mockResolvedValue({
    items: [row(card.passId)],
    more: false,
  });
  const resolve = vi.fn<ScanApi['resolve']>().mockResolvedValue({
    ...fixtureOutcome(found === 'choose' ? 'ready' : 'refused', found),
    card: null,
  } as never);
  const api = { lookup, resolve } as unknown as ScanApi;
  const onPass = vi.fn();
  const onCheckIn = vi.fn();
  const onCode = vi.fn();
  render(
    <LookupSheet
      open
      api={api}
      onClose={vi.fn()}
      onPass={onPass}
      onCheckIn={onCheckIn}
      onCode={onCode}
    />,
  );
  return { card, api, lookup, resolve, onPass, onCheckIn, onCode, user: userEvent.setup() };
}

describe('Look up from the assign card', () => {
  it('a picked person goes to the tag card with no resolve and no check-in', async () => {
    const { user, card, resolve, onPass, onCheckIn } = setup();
    await user.type(screen.getByRole('textbox', { name: 'Name, email or code' }), 'Anna');
    await user.click(await screen.findByRole('button', { name: /Anna Popescu Gold/ }));
    expect(onPass).toHaveBeenCalledWith(card.passId);
    expect(resolve).not.toHaveBeenCalled();
    expect(onCheckIn).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();
  });

  it('a typed code that names several passes does not go round as a code', async () => {
    const { user, card, onCode, onPass, lookup } = setup('ambiguous');
    await user.type(screen.getByRole('textbox', { name: 'Name, email or code' }), 'CARD1{Enter}');
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    // The one match by name is the pass; the code never goes back as a code.
    await waitFor(() => expect(onPass).toHaveBeenCalledWith(card.passId));
    expect(onCode).not.toHaveBeenCalled();
  });

  it('a short ambiguous code says to search by name', async () => {
    const { user, onCode } = setup('ambiguous');
    await user.type(screen.getByRole('textbox', { name: 'Name, email or code' }), 'AB{Enter}');
    expect(await screen.findByText('More than one pass. Search by name.')).toBeTruthy();
    expect(onCode).not.toHaveBeenCalled();
  });

  it('any other code still goes to the tag card as a code', async () => {
    const { user, onCode } = setup('choose');
    await user.type(screen.getByRole('textbox', { name: 'Name, email or code' }), 'CARD2{Enter}');
    await waitFor(() => expect(onCode).toHaveBeenCalledWith('CARD2'));
  });
});
