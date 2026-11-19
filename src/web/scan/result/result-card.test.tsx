import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { full, grant, heldIn, heldOut } from '../machine/access-fixtures.test-support.ts';
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
  it('fills a stamp cooldown from the outcome, with no check-in words', () => {
    render(
      <ResultCard
        outcome={fixtureOutcome('heads_up', 'cooldown', {
          action: { id: 'add_stamp', label: 'Add stamp', kind: 'add' },
          cooldownRemainingMs: 3 * 60_000,
        })}
      />,
    );
    const band = screen.getByTestId('scan-verdict');
    expect(band).toHaveTextContent('Just done');
    expect(band).toHaveTextContent(/Add stamp at .+\. Next in 3 min\./);
    expect(band).not.toHaveTextContent(/check-in|Checked in|\{/);
  });
  it('names the event on a wrong-event refusal', () => {
    render(
      <ResultCard
        outcome={fixtureOutcome('refused', 'wrong_event', {
          event: { name: 'Summer Gala', startsAt: Date.UTC(2026, 10, 14, 18, 0) },
        })}
      />,
    );
    expect(screen.getByTestId('scan-verdict')).toHaveTextContent(
      'This scanner is for Summer Gala, Sat.',
    );
  });
  it('has no axe violations on a refusal and a heads-up', async () => {
    const { container, rerender } = render(
      <ResultCard outcome={fixtureOutcome('refused', 'not_found', { display: null })} />,
    );
    expect((await axe(container)).violations).toEqual([]);
    rerender(<ResultCard outcome={fixtureOutcome('heads_up', 'capacity_full')} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('a hold changes nothing', () => {
  it.each([
    ['full', full],
    ['held in', heldIn],
    ['held out', heldOut],
  ] as const)('%s shows no stamp gain or grant note', (_name, make) => {
    const display = fixtureDisplay('heads_up');
    render(<ResultCard outcome={make({ display })} />);
    expect(screen.queryByText('Coffee card', { selector: '.sd-panel-title' })).toBeNull();
    expect(document.querySelector('.sd-progress')).toBeNull();
    expect(screen.queryByText('Check ID.')).toBeNull();
  });
  it('says the holder once when the band already names them', () => {
    const display = fixtureDisplay('ok');
    render(<ResultCard outcome={grant({ display })} />);
    expect(screen.getAllByText(display.identity.holder as string)).toHaveLength(1);
  });
});
