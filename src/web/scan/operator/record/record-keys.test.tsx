import { render, screen } from '@testing-library/react';
import { useMemo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { sessionFixture } from '../../boot/session.test-support.ts';
import { fixtureOutcome } from '../../machine/fixture-data.test-support.ts';
import { fakeClock } from '../../machine/store.test-support.ts';
import type { Command } from '../keys.ts';
import { useOperatorKeys } from '../use-operator-keys.ts';
import { type RecordContext, RecordScan } from './record.tsx';

/**
 * The record's O, P and Enter run only through the operator's key gate: a typed name or a slow
 * reader's code never fires Mark out, and a lone O after quiet does.
 */
const PASS = '01900000-0000-7000-8000-000000000001';
const base = sessionFixture();
const session = {
  ...base,
  staff: { id: PASS, name: 'Theo B.', role: 'desk' },
  scanner: base.scanner
    ? { ...base.scanner, settings: { ...base.scanner.settings, staffSignIn: true } }
    : null,
} as ScanSession;
const place = { kind: 'zone' as const, id: 'z1', name: 'Gym floor' };
const inside = {
  place,
  direction: 'in' as const,
  auto: false,
  state: 'in' as const,
  since: 1,
  via: null,
  stayMs: null,
  inNow: 1,
  capacity: null,
  turnaround: null,
};
const desk = {
  picker: null,
  onAmount: vi.fn(),
  onValue: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  managers: [],
  code: false,
  approvals: 'managers' as const,
  note: undefined,
  onApprove: vi.fn(),
};
const CODE: Record<string, string> = {
  '1': 'Digit1',
  '2': 'Digit2',
  '3': 'Digit3',
  '4': 'Digit4',
  '5': 'Digit5',
  '6': 'Digit6',
  '7': 'Digit7',
};
const codeFor = (ch: string) => CODE[ch] ?? `Key${ch.toUpperCase()}`;

function setup() {
  const clock = fakeClock();
  const markOut = vi.fn(async () => fixtureOutcome('ok'));
  const typed: string[] = [];
  const other: Command[] = [];
  const keys: RecordContext['keys'] = { current: null };
  const ctx: RecordContext = {
    api: { markOut, undo: vi.fn() } as unknown as ScanApi,
    runtime: { checkIn: vi.fn(), emit: vi.fn() } as never,
    session,
    timeZone: 'UTC',
    clock: 0,
    keys,
    machine: vi.fn(),
    undo: null,
    release: vi.fn(),
    type: (text) => typed.push(text),
    quiet: clock,
    buddy: null,
    showPass: vi.fn(),
    lookUp: vi.fn(),
  };
  function Harness() {
    const options = useMemo(() => ({ clock, timeOf: () => clock.now() }), []);
    useOperatorKeys(
      () => ({
        views: ['activity', 'problems'],
        fieldText: false,
        record: true,
        rollCall: false,
        walkIn: false,
        undoable: false,
      }),
      (command) => {
        if (command.c === 'type') typed.push(command.ch);
        else if (!keys.current?.(command)) other.push(command);
      },
      options,
    );
    return (
      <main data-operator-record>
        <RecordScan
          ctx={ctx}
          passId={PASS}
          desk={desk}
          outcome={fixtureOutcome('ok', null, {
            occupancy: inside,
            action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
          })}
        />
      </main>
    );
  }
  render(<Harness />);
  const target = () => screen.getByRole('heading', { name: 'Check-in' }).parentElement as Element;
  const press = (ch: string) => {
    const el = document.activeElement ?? document.body;
    el.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: codeFor(ch), key: ch }),
    );
  };
  return { clock, markOut, typed, other, press, target };
}

describe('the record keys go through the gate', () => {
  const focus = () => {
    const heading = document.querySelector<HTMLElement>('[data-operator-heading]');
    heading?.focus();
  };

  it('"olivia" typed onto the record fires nothing and lands in search', () => {
    const h = setup();
    focus();
    for (const [i, ch] of [...'olivia'].entries()) {
      if (i > 0) h.clock.advance(100);
      h.press(ch);
    }
    h.clock.advance(600);
    expect(h.markOut).not.toHaveBeenCalled();
    expect(h.typed.join('')).toBe('olivia');
  });

  it("a slow reader's code starting with O fires nothing", () => {
    const h = setup();
    focus();
    for (const ch of 'O1234567') {
      h.press(ch);
      h.clock.advance(100);
    }
    h.clock.advance(600);
    expect(h.markOut).not.toHaveBeenCalled();
  });

  it('a lone O after quiet marks out', async () => {
    const h = setup();
    focus();
    h.clock.advance(1000);
    h.press('o');
    h.clock.advance(600);
    await vi.waitFor(() => expect(h.markOut).toHaveBeenCalledTimes(1));
    expect(h.markOut).toHaveBeenCalledWith(
      expect.objectContaining({ passId: PASS, place: 'zone:z1' }),
    );
  });
});
