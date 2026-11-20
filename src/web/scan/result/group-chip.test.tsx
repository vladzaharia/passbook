import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { ResultCard } from './result-card.tsx';

const bundle = { id: 'b1', name: 'Family', size: 4, checkedIn: 1 };

describe('the group chip', () => {
  it('offers Check in all N and sends it', () => {
    const onGroup = vi.fn();
    render(<ResultCard outcome={fixtureOutcome('ok', null, { bundle })} onGroup={onGroup} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check in all 4' }));
    expect(onGroup).toHaveBeenCalled();
    expect(screen.getByText('1 of 4 in')).toBeInTheDocument();
  });

  it('hides when everyone is in', () => {
    render(
      <ResultCard
        outcome={fixtureOutcome('ok', null, { bundle: { ...bundle, checkedIn: 4 } })}
        onGroup={() => {}}
      />,
    );
    expect(screen.queryByTestId('scan-group-chip')).toBeNull();
  });

  it('shows every member verdict, the refused one plainly', async () => {
    const group = {
      total: 3,
      done: 1,
      already: 1,
      refused: 1,
      members: [
        { name: 'Ana', state: 'done' as const, reason: null },
        { name: 'Bo', state: 'already' as const, reason: 'already_done' as const },
        { name: 'Cy', state: 'refused' as const, reason: 'voided' as const },
      ],
    };
    const { container } = render(
      <ResultCard outcome={fixtureOutcome('ok', null, { bundle, group })} />,
    );
    expect(screen.getByText('1 in · 1 already in · 1 not let in')).toBeInTheDocument();
    expect(screen.getByText('Cy').nextSibling).toHaveTextContent('Voided');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect((await axe(container)).violations).toEqual([]);
  });
});
