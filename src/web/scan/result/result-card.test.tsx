import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { fixtureCard, fixtureDisplay, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { ResultCard } from './result-card.tsx';

describe('a refused counter', () => {
  const value = (counter: boolean) => ({
    input: 'uses',
    label: 'Uses',
    before: 0,
    after: 0,
    goal: 10,
    format: 'number' as const,
    ...(counter ? { counter } : {}),
  });
  it.each([
    ['no_balance', 'None left'],
    ['card_full', 'Already full'],
  ] as const)('reads %s in the counter wording', (reason, headline) => {
    render(<ResultCard outcome={fixtureOutcome('refused', reason, { value: value(true) })} />);
    expect(screen.getByRole('heading')).toHaveTextContent(headline);
  });
  it('keeps the balance and stamp wording for other inputs', () => {
    render(
      <ResultCard outcome={fixtureOutcome('refused', 'card_full', { value: value(false) })} />,
    );
    expect(screen.getByRole('heading')).toHaveTextContent('Card is full');
  });
});

describe('the scanner result interface', () => {
  it('uses the outcome display and keeps meta under the identity', () => {
    const outcome = fixtureOutcome('ok', null, {
      card: fixtureCard(),
      display: fixtureDisplay('ok'),
    });
    render(<ResultCard outcome={outcome} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Anna Popescu');
    expect(screen.getByText('Gold member').closest('.scan-identity')).not.toBeNull();
    expect(screen.getByTestId('scan-verdict')).toHaveTextContent('Add stamp');
    expect(screen.getByRole('button', { name: 'View pass' })).toBeVisible();
  });
  it('suppresses panels, chips, art and private meta on a refused outcome', () => {
    const display = fixtureDisplay('ok');
    const outcome = fixtureOutcome('refused', 'voided', {
      card: fixtureCard(),
      display,
      flags: ['Private flag'],
    });
    render(<ResultCard outcome={outcome} />);
    expect(screen.getByRole('heading')).toHaveTextContent('Voided');
    expect(screen.queryByText('Coffee card', { selector: '.sd-panel-title' })).toBeNull();
    expect(screen.queryByText('VIP')).toBeNull();
    expect(screen.queryByText('Gold member')).toBeNull();
    expect(screen.queryByText('Private flag')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View pass' })).toBeNull();
  });
  it('never falls back to the ready card display', () => {
    render(
      <ResultCard outcome={fixtureOutcome('ok', null, { card: fixtureCard(), display: null })} />,
    );
    expect(screen.queryByText('Gold member')).toBeNull();
    expect(screen.queryByText('VIP')).toBeNull();
  });
  it('opens the full pass through the identity row', () => {
    const onPass = vi.fn();
    const card = fixtureCard();
    render(<ResultCard outcome={fixtureOutcome('ok', null, { card })} onPass={onPass} />);
    screen.getByRole('button', { name: 'View pass' }).click();
    expect(onPass).toHaveBeenCalledWith(card);
  });
});
