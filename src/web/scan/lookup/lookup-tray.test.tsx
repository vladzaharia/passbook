import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { LookupTray } from './lookup-tray.tsx';

function setup(allowPeople = true, found = 'not_found') {
  const lookup = vi.fn<ScanApi['lookup']>().mockResolvedValue({ items: [], more: false });
  const resolve = vi
    .fn<ScanApi['resolve']>()
    .mockResolvedValue(
      fixtureOutcome('refused', found === 'not_found' ? 'not_found' : 'voided') as never,
    );
  const onCode = vi.fn();
  const onClose = vi.fn();
  render(
    <LookupTray
      open
      allowPeople={allowPeople}
      api={{ lookup, resolve } as unknown as ScanApi}
      onClose={onClose}
      onCheckIn={vi.fn()}
      onCode={onCode}
    />,
  );
  return { lookup, resolve, onCode, onClose };
}
const key = (d: string) => fireEvent.click(screen.getByRole('button', { name: d }));
const field = () => screen.getByRole('textbox', { name: 'Name, email or code' });

describe('Enter code tray', () => {
  it('types on the keypad into a field that raises no keyboard', () => {
    setup();
    for (const d of '4081') key(d);
    expect(field()).toHaveValue('4081');
    expect(field()).toHaveAttribute('inputmode', 'none');
    expect(field()).toHaveAttribute('autocomplete', 'off');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(field()).toHaveValue('408');
  });

  it('Look up sends the exact code as a manual read', async () => {
    const { resolve, onCode } = setup(true, 'found');
    for (const d of '4081') key(d);
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() => expect(onCode).toHaveBeenCalledWith('4081'));
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ input: { code: '4081', method: 'manual' } }),
      expect.anything(),
    );
  });

  it('is empty until something is typed', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled();
  });

  it('ABC hands the field to the system keyboard, and 123 takes it back', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Letters' }));
    expect(field()).toHaveAttribute('inputmode', 'text');
    expect(screen.queryByTestId('scan-keypad')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Numbers' }));
    expect(field()).toHaveAttribute('inputmode', 'none');
    expect(screen.getByTestId('scan-keypad')).toBeVisible();
  });

  it('with lookup off it takes a code only: no ABC, Enter', () => {
    setup(false);
    expect(screen.queryByRole('button', { name: 'Letters' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Code' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enter' })).toBeVisible();
  });

  it('close leaves', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
