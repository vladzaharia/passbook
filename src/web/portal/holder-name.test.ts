import { describe, expect, it } from 'vitest';
import { passFixture } from './fixtures.ts';
import { holderPassName } from './pass-view.ts';

describe('holderPassName', () => {
  const pass = passFixture({ title: 'Maya Chen' });
  it("swaps the holder's own name for the pass kind", () => {
    expect(holderPassName(pass, { name: 'maya chen' })).toBe(pass.templateName);
  });
  it('keeps any other title, whatever the email says', () => {
    expect(holderPassName(passFixture({ title: 'Tickets' }), { name: null })).toBe('Tickets');
    expect(holderPassName(pass, { name: 'Sam Smith' })).toBe('Maya Chen');
  });
});
