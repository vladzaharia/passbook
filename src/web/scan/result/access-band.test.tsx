import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import type { ResolvedOutcome } from '../machine/access-events.ts';
import {
  accessInfo,
  exit,
  full,
  grant,
  heldIn,
  heldOut,
} from '../machine/access-fixtures.test-support.ts';
import { fixtureDisplay, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { ResultCard } from './result-card.tsx';

const band = () => screen.getByTestId('scan-verdict');

describe('the access band', () => {
  it('says Checked in with the pill, the zone and the closing time', () => {
    render(<ResultCard outcome={grant({ display: null })} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Checked in');
    expect(screen.getByTestId('scan-dir-pill')).toHaveTextContent('In');
    expect(band()).toHaveTextContent('Gym · until');
  });
  it('keeps Checked in as the headline with the person under it', () => {
    render(<ResultCard outcome={grant({ display: fixtureDisplay('ok') })} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Checked in');
    expect(band()).toHaveTextContent('Anna Popescu');
  });
  it('says Checked out with the pill, the zone and the stay', () => {
    render(<ResultCard outcome={exit({ display: null })} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Checked out');
    expect(screen.getByTestId('scan-dir-pill')).toHaveTextContent('Out');
    expect(band()).toHaveTextContent('Gym · 1 h 32 min');
  });
  it('turns green with who let them in', () => {
    const o: ResolvedOutcome = { ...grant({ display: null }), resolvedBy: 'Sam K.' };
    render(<ResultCard outcome={o} />);
    expect(band()).toHaveTextContent('Gym · Let in by Sam K.');
  });
  it('words the holds from the occupancy copy', () => {
    const { rerender } = render(<ResultCard outcome={heldIn({ display: null })} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Already in');
    expect(band()).toHaveTextContent('40 s ago · Front desk');
    rerender(<ResultCard outcome={heldOut({ display: null })} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Already out');
    rerender(<ResultCard outcome={full({ display: null })} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Gym full');
    expect(band()).toHaveTextContent('60 of 60 in.');
  });
  it('fills plan, zone, when and limit in the refusals', () => {
    const when = Date.UTC(2026, 10, 9, 9, 0);
    const access = accessInfo({ nextOpenAt: when, visits: { used: 5, limit: 5 } });
    const { rerender } = render(
      <ResultCard outcome={fixtureOutcome('refused', 'outside_hours', { access })} />,
    );
    expect(band()).toHaveTextContent('Gold opens Mon 9:00 AM.');
    rerender(<ResultCard outcome={fixtureOutcome('refused', 'zone_not_included', { access })} />);
    expect(band()).toHaveTextContent("Gold doesn't include Gym.");
    rerender(<ResultCard outcome={fixtureOutcome('refused', 'guest_visits_used', { access })} />);
    expect(band()).toHaveTextContent('Used 5 of 5.');
  });
  it('leaves no marker unfilled in any access verdict', () => {
    const outcomes = [
      grant({ display: null }),
      exit({ display: null }),
      heldIn({ display: null }),
      heldOut({ display: null }),
      full({ display: null }),
      fixtureOutcome('refused', 'zone_not_included', { access: accessInfo() }),
      fixtureOutcome('refused', 'outside_hours', {
        access: accessInfo({ nextOpenAt: Date.UTC(2026, 10, 9, 9, 0) }),
      }),
      fixtureOutcome('refused', 'guest_expired', {
        access: accessInfo({ closesAt: Date.UTC(2026, 10, 9, 9, 0) }),
      }),
      fixtureOutcome('refused', 'guest_visits_used', {
        access: accessInfo({ visits: { used: 3, limit: 3 } }),
      }),
    ];
    for (const outcome of outcomes) {
      const { unmount } = render(<ResultCard outcome={outcome} />);
      expect(band().textContent, outcome.reason ?? 'ok').not.toMatch(/[{}]/);
      unmount();
    }
  });
  it('has no axe violations', async () => {
    const { container } = render(<ResultCard outcome={grant({ display: null })} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
