import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { sessionFixture } from '../boot/session.test-support.ts';
import { createDirectionPin } from '../machine/direction-pin.ts';
import { fixtureCounts } from '../machine/fixture-data.test-support.ts';
import { fakeClock } from '../machine/store.test-support.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { CountChip, PlaceChip } from './chips.tsx';
import { DirectionChip } from './direction-chip.tsx';
import { DirectionSheet } from './direction-sheet.tsx';
import { useAccessUi } from './use-access-ui.tsx';

const place = { name: 'Gym', inNow: 42, capacity: 60 };

function withSession(
  over: Partial<ScanSession['scanner'] & object>,
  staff: ScanSession['staff'] = null,
) {
  const base = sessionFixture();
  return sessionFixture({
    staff,
    scanner: base.scanner && {
      ...base.scanner,
      ...over,
      settings: { ...base.scanner.settings, ...(over.settings ?? {}) },
    },
  });
}

function Probe({
  session,
  counts,
  dispatch = vi.fn(),
  overlay = null,
}: {
  session: ScanSession;
  counts: ReturnType<typeof fixtureCounts>;
  dispatch?: () => void;
  overlay?: string | null;
}) {
  const runtime = { pin: createDirectionPin(fakeClock()), emit: vi.fn() } as unknown as ScanRuntime;
  const ui = useAccessUi({
    runtime,
    session,
    api: {} as ScanApi,
    counts,
    online: true,
    overlay,
    dispatch,
  });
  return (
    <>
      {ui.chips}
      {ui.inside ? (
        <button type="button" onClick={ui.inside.onOpen}>
          Who's in {ui.inside.count}
        </button>
      ) : null}
      {ui.layer}
    </>
  );
}

describe('the direction chip', () => {
  it('is fixed on an In or Out scanner, with no chevron', () => {
    render(<DirectionChip setting="out" pin={null} onOpen={vi.fn()} />);
    expect(screen.getByTestId('scan-direction')).toHaveTextContent('Out');
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('is Auto on a Both scanner and opens the sheet', () => {
    const onOpen = vi.fn();
    render(<DirectionChip setting="both" pin={null} onOpen={onOpen} />);
    const chip = screen.getByRole('button', { name: 'Direction: Auto' });
    expect(chip).not.toHaveAttribute('data-tone');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalled();
  });
  it('turns accent when pinned', () => {
    render(<DirectionChip setting="both" pin="out" onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Direction: Out' })).toHaveAttribute(
      'data-tone',
      'accent',
    );
  });
});

describe('the direction sheet', () => {
  const sheet = (pin: 'in' | 'out' | null, onPick = vi.fn()) => (
    <DirectionSheet open pin={pin} onPick={onPick} onClose={vi.fn()} />
  );
  it('has three radio rows, the lapse line and Done', () => {
    render(sheet(null));
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(['auto', 'in', 'out']);
    expect(screen.getByRole('radio', { name: /Auto/ })).toBeChecked();
    expect(screen.getByText("In if they're out, out if they're in.")).toBeVisible();
    expect(screen.getByText('Every scan taps in.')).toBeVisible();
    expect(screen.getByText('Goes back to Auto after 15 min without a scan.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).toBeVisible();
  });
  it('picks a direction, and Auto clears the pin', () => {
    const onPick = vi.fn();
    const { rerender } = render(sheet(null, onPick));
    fireEvent.click(screen.getByRole('radio', { name: /Out/ }));
    expect(onPick).toHaveBeenLastCalledWith('out');
    rerender(sheet('out', onPick));
    expect(screen.getByRole('radio', { name: /Out/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Auto/ }));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });
  it('has no axe violations', async () => {
    render(sheet('in'));
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});

describe('the count chip', () => {
  it('shows a place as in/capacity and says it in words', () => {
    render(<PlaceChip {...place} />);
    expect(screen.getByTestId('scan-count')).toHaveTextContent('42/60');
    expect(screen.getByRole('img', { name: 'Gym: 42 in now of 60' })).toBeVisible();
  });
  it('turns amber when the place is full and leaves out a missing capacity', () => {
    const { rerender } = render(<PlaceChip name="Gym" inNow={60} capacity={60} />);
    expect(screen.getByTestId('scan-count')).toHaveAttribute('data-tone', 'amber');
    rerender(<PlaceChip name="Gym" inNow={7} capacity={null} />);
    expect(screen.getByTestId('scan-count')).not.toHaveAttribute('data-tone');
    expect(screen.getByRole('img', { name: 'Gym: 7 in now' })).toBeVisible();
  });
  it('keeps Today for a scanner that counts no place', () => {
    render(<CountChip count={42} today />);
    expect(screen.getByTestId('scan-count')).toHaveTextContent('Today 42');
  });
});

describe('access in the loop', () => {
  const counts = fixtureCounts({ place });
  it("a Desk scanner with a place gets the chips and Who's in with the live count", () => {
    const session = withSession({
      settings: { roleWithoutSignIn: 'desk', direction: 'both' } as never,
    });
    render(<Probe session={session} counts={counts} />);
    expect(screen.getByRole('button', { name: 'Direction: Auto' })).toBeVisible();
    expect(screen.getByTestId('scan-count')).toHaveTextContent('42/60');
    expect(screen.getByRole('button', { name: "Who's in 42" })).toBeVisible();
  });
  it("a Door scanner has the chips and no Who's in", () => {
    render(
      <Probe session={withSession({ settings: { direction: 'in' } as never })} counts={counts} />,
    );
    expect(screen.getByTestId('scan-direction')).toHaveTextContent('In');
    expect(screen.queryByRole('button', { name: /Who's in/ })).toBeNull();
  });
  it('a signed-in Desk staff member gets it on a scanner whose default is Door', () => {
    const session = withSession({}, { id: 's1', name: 'Sam K.', role: 'desk' });
    render(<Probe session={session} counts={counts} />);
    expect(screen.getByRole('button', { name: "Who's in 42" })).toBeVisible();
  });
  it("a scanner with no place has no direction chip, no Who's in and keeps Today", () => {
    const session = withSession({ settings: { roleWithoutSignIn: 'desk' } as never });
    render(<Probe session={session} counts={fixtureCounts({ event: null })} />);
    expect(screen.queryByTestId('scan-direction')).toBeNull();
    expect(screen.queryByRole('button', { name: /Who's in/ })).toBeNull();
    expect(screen.getByTestId('scan-count')).toHaveTextContent('Today 42');
  });
  it("a customer screen or a monitor never gets Who's in", () => {
    const session = withSession({
      deviceRole: 'monitor',
      settings: { roleWithoutSignIn: 'desk' } as never,
    });
    render(<Probe session={session} counts={counts} />);
    expect(screen.queryByRole('button', { name: /Who's in/ })).toBeNull();
  });
  it('an event that counts people inside is a place', () => {
    const session = sessionFixture({
      event: {
        id: 'e1',
        name: 'Gala',
        opensAt: 0,
        closesAt: 1,
        timeZone: 'UTC',
        reentry: true,
        note: null,
      },
    });
    render(
      <Probe
        session={session}
        counts={fixtureCounts({ event: { arrived: 9, inside: 7, expected: 10, capacity: 20 } })}
      />,
    );
    expect(screen.getByTestId('scan-count')).toHaveTextContent('7/20');
  });
  it("opening Who's in raises the overlay and a result clears it", async () => {
    const dispatch = vi.fn();
    const session = withSession({ settings: { roleWithoutSignIn: 'desk' } as never });
    const { rerender } = render(<Probe session={session} counts={counts} dispatch={dispatch} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Who's in 42" }));
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'overlay', open: 'recent' });
    rerender(<Probe session={session} counts={counts} dispatch={dispatch} overlay="recent" />);
    rerender(<Probe session={session} counts={counts} dispatch={dispatch} overlay={null} />);
    await waitFor(() => expect(screen.queryByTestId('inside-sheet')).toBeNull());
  });
});
