import { describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import { createDisplayFixture } from './display-split-fixture.ts';
import { activeFlags } from './resolve.ts';

const { fixture } = createDisplayFixture();

// A stop flag holds the check-in for a confirm; it is not a refusal, so desk staff can let the person in.
describe('Membership flags', () => {
  it.each([
    ['Frozen', true],
    ['Past due', true],
    ['Cancelled', true],
    ['Active', false],
  ])('%s', (status, held) => {
    const membership = bakedTemplates.find((t) => t.slug === 'starter-generic');
    const found = fixture();
    found.scan.flags = (membership?.manifest.scan?.flags ?? []) as typeof found.scan.flags;
    found.pass.personalization.status = status;
    expect(activeFlags(found)).toEqual(held ? [{ label: 'Ask a manager', stop: true }] : []);
  });
});
