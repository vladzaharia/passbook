import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { sessionFixture } from '../../boot/session.test-support.ts';
import { fixtureCard, fixtureOutcome } from '../../machine/fixture-data.test-support.ts';
import type { Command } from '../keys.ts';
import { type RecordContext, RecordScan } from './record.tsx';

const PASS = '01900000-0000-7000-8000-000000000001';
const base = sessionFixture();
const session: ScanSession = {
  ...base,
  staff: { id: PASS, name: 'Theo B.', role: 'desk' },
  scanner: base.scanner
    ? { ...base.scanner, settings: { ...base.scanner.settings, staffSignIn: true } }
    : null,
} as ScanSession;
const desk = {
  picker: null,
  onAmount: vi.fn(),
  onValue: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  managers: [{ id: 'm1', name: 'Ana R.' }],
  code: false,
  approvals: 'managers' as const,
  note: undefined,
  onApprove: vi.fn(),
};
const ctx = (over: Partial<RecordContext> = {}): RecordContext => ({
  api: {} as ScanApi,
  runtime: { checkIn: vi.fn(), emit: vi.fn() } as never,
  session,
  timeZone: 'UTC',
  clock: Date.now(),
  keys: { current: null },
  machine: vi.fn(),
  undo: null,
  release: vi.fn(),
  type: vi.fn(),
  buddy: null,
  showPass: vi.fn(),
  lookUp: vi.fn(),
  ...over,
});
const bundle = { id: 'b', name: 'Okafor family', size: 3, checkedIn: 1 };
const checkIn = { id: 'check_in', label: 'Check in', kind: 'check_in' as const };

describe('the operator record for a scan', () => {
  it('names the primary button by its label alone, so a key hint is not part of the name', () => {
    const c = ctx();
    const action = {
      ...fixtureCard().actions[0],
      id: 'check_in',
      label: 'Check in',
      kind: 'check_in' as const,
    };
    render(
      <RecordScan
        ctx={c}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('ready', 'choose', {
          card: fixtureCard({ actions: [action as never] }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));
    expect(c.machine).toHaveBeenCalledWith({ type: 'pick', actionId: 'check_in' });
  });

  it('says the verdict and runs the family action through the machine', () => {
    const c = ctx();
    render(
      <RecordScan
        ctx={c}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('ok', null, { action: checkIn, bundle })}
      />,
    );
    expect(screen.getByTestId('scan-verdict')).toHaveTextContent('Checked in');
    fireEvent.click(screen.getByRole('button', { name: /Check in family · 2/ }));
    expect(c.machine).toHaveBeenCalledWith({ type: 'group' });
  });

  it('wires the record keys: Enter is the primary action, an unlisted key is not taken, the note key is', () => {
    const c = ctx();
    render(
      <RecordScan
        ctx={c}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('ok', null, { action: checkIn, bundle })}
      />,
    );
    expect(c.keys.current?.({ c: 'safe' } satisfies Command)).toBe(false);
    expect(c.keys.current?.({ c: 'note' } satisfies Command)).toBe(true);
    expect(c.keys.current?.({ c: 'primary' })).toBe(true);
    expect(c.machine).toHaveBeenCalledWith({ type: 'group' });
  });

  it('opens a Manager PIN in place and sends it to the machine', () => {
    const c = ctx();
    render(
      <RecordScan
        ctx={c}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('refused', 'needs_approval', { action: checkIn, approvals: true })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ask a manager/ }));
    expect(screen.getByTestId('op-pin')).toBeInTheDocument();
    expect(screen.getByText('Approves this entry only.')).toBeInTheDocument();
  });

  it('offers a hold its override, and nothing on a plain refusal', () => {
    const c = ctx();
    const { unmount } = render(
      <RecordScan
        ctx={c}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('heads_up', 'already_done', { action: checkIn })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Let in/ }));
    expect(c.machine).toHaveBeenCalledWith({ type: 'override', actionId: 'check_in' });
    unmount();
    render(
      <RecordScan
        ctx={c}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('refused', 'guest_visits_used')}
      />,
    );
    expect(screen.queryByTestId('scan-action-let-in')).toBeNull();
  });

  it('runs Open pass and Look up on a refusal', () => {
    const c = ctx();
    render(
      <RecordScan
        ctx={c}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('refused', 'guest_visits_used', {
          card: fixtureCard({ title: 'Leo Park' }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open pass' }));
    expect(c.showPass).toHaveBeenCalledWith(PASS);
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(c.lookUp).toHaveBeenCalled();
    expect(screen.getByText('Ask them to renew.')).toBeInTheDocument();
  });

  it('lists each family member when the bundle carries them', () => {
    const bundleWith = {
      ...bundle,
      size: 2,
      members: [
        { initials: 'MO', checkedIn: true },
        { initials: 'CO', checkedIn: false },
      ],
    };
    render(
      <RecordScan
        ctx={ctx()}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('ok', null, {
          action: checkIn,
          bundle: bundleWith as typeof bundle,
        })}
      />,
    );
    expect(screen.getByTestId('op-family')).toHaveTextContent('MO');
    expect(screen.getByTestId('op-family')).toHaveTextContent('Out');
  });

  it('shows Undo only when this device may undo this scan', () => {
    const undo = vi.fn();
    render(
      <RecordScan
        ctx={ctx({ undo })}
        passId={PASS}
        desk={desk}
        outcome={fixtureOutcome('ok', null, { action: checkIn })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    expect(undo).toHaveBeenCalled();
  });
});
