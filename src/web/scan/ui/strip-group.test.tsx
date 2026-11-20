import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { fixtureCard, fixtureDisplay, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { LastScanStrip } from './last-scan-strip.tsx';
import { stripOf } from './strip-of.ts';

const group = {
  total: 4,
  done: 3,
  already: 1,
  refused: 0,
  members: [
    { name: 'Anna Park', state: 'already' as const, reason: null },
    { name: 'Ben Park', state: 'done' as const, reason: null },
    { name: 'Cara Park', state: 'done' as const, reason: null },
    { name: 'Dan Park', state: 'done' as const, reason: null },
  ],
};

describe('the strip after Check in more', () => {
  it('names the group scan and one Undo asks for it, so the server reverses every member', () => {
    const outcome = fixtureOutcome('ok', null, {
      group,
      scanId: 'anchor-scan',
      card: fixtureCard(),
      display: fixtureDisplay('ok'),
    });
    const entry = stripOf({ scanId: 'anchor-scan', at: 0, outcome, undoable: true }, true);
    expect(entry?.meta).toMatch(/^Checked in 3 more · /);
    const onUndo = vi.fn();
    render(<LastScanStrip entry={entry} onUndo={onUndo} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
