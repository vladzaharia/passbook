import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { fixtureCard, fixtureDisplay, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { ResultCard } from './result-card.tsx';

describe('the glance card', () => {
  const ok = fixtureOutcome('ok', null, { card: fixtureCard(), display: fixtureDisplay('ok') });
  it('keeps the verdict, who and one fact; panels wait in the sheet', () => {
    render(<ResultCard outcome={ok} density="glance" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Checked in|Add stamp/);
    expect(screen.getByText('Anna Popescu')).toBeVisible();
    expect(screen.getByTestId('scan-keyfact')).toHaveTextContent('6 of 10');
    expect(document.querySelector('.sd-panel')).toBeNull();
  });
  it('is one button that opens the pass with its outcome', () => {
    const onPass = vi.fn();
    render(<ResultCard outcome={ok} density="glance" onPass={onPass} />);
    screen.getByRole('button', { name: 'View pass' }).click();
    expect(onPass).toHaveBeenCalledWith(ok.card, ok);
  });
  it('shows the note on a hold instead of a fact', () => {
    const outcome = fixtureOutcome('heads_up', 'already_done', {
      card: fixtureCard(),
      display: fixtureDisplay('heads_up'),
    });
    render(<ResultCard outcome={outcome} density="glance" />);
    expect(screen.getByTestId('scan-glance-note')).toHaveTextContent('Check ID.');
    expect(screen.queryByTestId('scan-keyfact')).toBeNull();
  });
  it('says where the rest is on a refusal, and paints no fact', () => {
    const outcome = fixtureOutcome('refused', 'voided', {
      card: fixtureCard(),
      display: fixtureDisplay('ok'),
    });
    render(<ResultCard outcome={outcome} density="glance" />);
    expect(screen.getByText('Tap for details')).toBeVisible();
    expect(screen.queryByTestId('scan-keyfact')).toBeNull();
  });
  it('leaves the full card alone by default', () => {
    render(<ResultCard outcome={ok} />);
    expect(screen.getByText('Coffee card')).toBeVisible();
    expect(screen.queryByTestId('scan-keyfact')).toBeNull();
  });
});
