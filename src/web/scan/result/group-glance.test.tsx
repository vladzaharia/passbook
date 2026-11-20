import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { fixtureCard, fixtureDisplay, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { ResultCard } from './result-card.tsx';

const bundle = { id: 'b1', name: 'Family pack', size: 4, checkedIn: 1 };
const base = { card: fixtureCard(), display: fixtureDisplay('ok') };

describe('the group on the glance card', () => {
  it('says who is in and draws one disc per person', async () => {
    const { container } = render(
      <ResultCard outcome={fixtureOutcome('ok', null, { ...base, bundle })} density="glance" />,
    );
    expect(screen.getByText("1 of 4 in Anna's group")).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Anna, in');
    expect(screen.getAllByRole('listitem')[1]).toHaveTextContent('not in yet');
    expect(screen.queryByTestId('scan-group-chip')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('counts what Check in more added in the headline', () => {
    const group = {
      total: 4,
      done: 3,
      already: 1,
      refused: 0,
      members: [
        { name: 'Anna Popescu', state: 'already' as const, reason: null },
        { name: 'Ben', state: 'done' as const, reason: null },
        { name: 'Cara', state: 'done' as const, reason: null },
        { name: 'Dan', state: 'done' as const, reason: null },
      ],
    };
    render(
      <ResultCard outcome={fixtureOutcome('ok', null, { ...base, group })} density="glance" />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Checked in 3 more');
    expect(screen.getByText("4 of 4 in Anna's group")).toBeVisible();
  });

  it('keeps the full card as it was: the Check in all chip, no discs', () => {
    const onGroup = vi.fn();
    render(
      <ResultCard outcome={fixtureOutcome('ok', null, { ...base, bundle })} onGroup={onGroup} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check in all 4' }));
    expect(onGroup).toHaveBeenCalled();
    expect(screen.queryByTestId('scan-group-row')).toBeNull();
  });
});
