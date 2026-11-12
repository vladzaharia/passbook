import { describe, expect, it } from 'vitest';
import { visibleSource } from './card-semantics.ts';
import { createDisplayFixture } from './display-split-fixture.ts';

const { fixture, inputOf } = createDisplayFixture();
const HIDDEN_DEFAULT = 'PRIVATE-DEFAULT-963';

describe('card source defaults', () => {
  it('reads a public input from its default, never a hidden default or a public copy of one', () => {
    const found = fixture();
    found.template.manifest.inputs.properties = {
      ...found.template.manifest.inputs.properties,
      entrance: { type: 'string', default: 'North entrance' },
      privateDefault: { type: 'string', 'x-scan': 'hidden', default: HIDDEN_DEFAULT },
      copiedDefault: { type: 'string', default: HIDDEN_DEFAULT },
      deskDefault: { type: 'string', 'x-scan': 'desk', default: 'Desk lane' },
    };
    for (const role of ['door', 'desk', 'manager'] as const) {
      const { actor } = inputOf(found, role);
      expect(visibleSource(found, actor, 'entrance')).toBe(true);
      expect(visibleSource(found, actor, 'deskDefault')).toBe(role !== 'door');
      expect(visibleSource(found, actor, 'privateDefault')).toBe(false);
      expect(visibleSource(found, actor, 'copiedDefault')).toBe(false);
    }
    // An issued hidden value is no more visible than its default.
    found.pass.personalization.privateDefault = 'Issued private value';
    expect(visibleSource(found, inputOf(found, 'manager').actor, 'privateDefault')).toBe(false);
  });
});
