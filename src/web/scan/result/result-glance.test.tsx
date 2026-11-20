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
  it('names the card with the verdict and the holder', () => {
    render(<ResultCard outcome={ok} density="glance" />);
    expect(
      screen.getByRole('button', { name: /^(Checked in|Add stamp)\. Anna Popescu\. Details$/ }),
    ).toBeVisible();
  });
  it('names the manager whose PIN let it through', () => {
    render(<ResultCard outcome={ok} density="glance" approvedBy="Maya R." />);
    expect(screen.getByText('Approved by Maya R.')).toBeVisible();
  });
  it('says nothing of an approval on a hold', () => {
    const hold = fixtureOutcome('heads_up', 'already_done', { card: fixtureCard() });
    render(<ResultCard outcome={hold} density="glance" approvedBy="Maya R." />);
    expect(screen.queryByText(/Approved by/)).toBeNull();
  });
  it('is one button that opens the pass with its outcome', () => {
    const onPass = vi.fn();
    render(<ResultCard outcome={ok} density="glance" onPass={onPass} />);
    screen.getByRole('button', { name: /Details$/ }).click();
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

  it('keeps what the full card offered: the pass, the group and the manager PIN', () => {
    const bundle = { id: 'b1', name: 'Chen family', size: 4, checkedIn: 1 };
    const onGroup = vi.fn();
    // An ok card leaves Check in more to the dock; a heads-up card has no dock button for it.
    const heads = fixtureOutcome('heads_up', 'already_done', {
      card: fixtureCard(),
      display: fixtureDisplay('heads_up'),
      bundle,
    });
    const { unmount } = render(<ResultCard outcome={heads} density="glance" onGroup={onGroup} />);
    screen.getByRole('button', { name: 'Check in 3 more' }).click();
    expect(onGroup).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Details$/ })).toBeVisible();
    unmount();
    const needs = fixtureOutcome('heads_up', 'needs_approval', {
      card: fixtureCard(),
      display: fixtureDisplay('heads_up'),
    });
    render(
      <ResultCard
        outcome={needs}
        density="glance"
        desk={{
          picker: null,
          onAmount: vi.fn(),
          onValue: vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          managers: [{ id: 'm1', name: 'Maya' }],
          approvals: 'managers',
          onApprove: vi.fn(),
        }}
      />,
    );
    // The handheld's Manager PIN is the dock's (ApprovalDock), not a button on the card.
    expect(screen.queryByTestId('scan-manager-pin')).toBeNull();
  });
  it('shows identity only on a manager hold', () => {
    const needs = fixtureOutcome('heads_up', 'needs_approval', {
      card: fixtureCard(),
      display: fixtureDisplay('ok'),
    });
    render(<ResultCard outcome={needs} density="glance" />);
    expect(screen.queryByTestId('scan-keyfact')).toBeNull();
  });
});
