import { describe, expect, it } from 'vitest';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import { scopeOf } from './card-projection.ts';
import { buildDisplay } from './display.ts';
import { createDisplayFixture, ctx, SECRET } from './display-split-fixture.ts';

const { fixture, inputOf } = createDisplayFixture();

describe('live scanner display privacy', () => {
  it('filters protected defaults before formatting a copied input', () => {
    const found = fixture();
    found.template.manifest.inputs.properties!.privateNotes = {
      type: 'string',
      'x-scan': 'hidden',
      default: 'sapphire confidential',
    };
    found.pass.personalization.seat = 'sapphire confidential';
    found.template.manifest.lookups!.directory!['sapphire confidential'] = {
      label: 'Balcony access',
    };
    found.template.manifest.bindings.find(
      (binding) => 'field' in binding.to && binding.to.field === 'seat',
    )!.value = '{{lookups.directory[seat].label}}';
    const pass = found.passJson as unknown as {
      generic: { secondaryFields: { key: string; value: string }[] };
    };
    pass.generic.secondaryFields[0]!.value = 'Balcony access';
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      panels: [
        {
          id: 'p_details',
          rows: [
            { id: 'r_seat', type: 'field', label: 'Seat', value: '{{inputs.seat|upper}}' },
            { id: 'r_lookup', type: 'field', label: 'Access', value: '{{fields.seat}}' },
          ],
        },
      ],
    };
    const input = inputOf(found, 'door');
    expect(scopeOf(ctx, input, found).inputs).not.toHaveProperty('seat');
    expect(scopeOf(ctx, input, found).fields).not.toHaveProperty('seat');
    const text = JSON.stringify(buildDisplay(ctx, input));
    expect(text).not.toContain('sapphire confidential');
    expect(text).not.toContain('SAPPHIRE CONFIDENTIAL');
    expect(text).not.toContain('Balcony access');
  });

  it('does not use a lookup of a protected source for either identity or the fallback', () => {
    const found = fixture();
    found.template.manifest.inputs.properties!.privateNotes = {
      type: 'string',
      'x-scan': 'hidden',
      default: 'sapphire confidential',
    };
    found.pass.personalization.seat = 'sapphire confidential';
    found.template.manifest.lookups!.directory!['sapphire confidential'] = {
      label: 'Balcony access',
    };
    found.template.manifest.display = { title: '{{lookups.directory[seat].label}}' };
    found.pass.displayTitle = 'Balcony access';
    const input = inputOf(found, 'door');
    expect((scopeOf(ctx, input, found).pass as Record<string, unknown>).title).toBe('');
    found.scan.display = {
      v: 1,
      holder: '{{pass.title}}',
      header: { title: `Secret ${SECRET}` },
      panels: [],
    };
    const fallback = ScanDisplaySchema.parse(buildDisplay(ctx, input));
    expect(fallback.identity.holder).toBe('Pass');
    expect(JSON.stringify(fallback)).not.toContain('Balcony access');
  });

  it('does not fall back to a literal lookup key for a restricted selector', () => {
    const found = fixture();
    found.template.manifest.lookups!.directory!.tier = { label: 'Literal tier channel' };
    found.template.manifest.lookups!.directory!.Gold = { label: 'Gold access' };
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      panels: [
        {
          id: 'p_lookup',
          rows: [
            {
              id: 'r_lookup',
              type: 'field',
              label: 'Access',
              value: '{{lookups.directory[tier].label}}',
            },
          ],
        },
      ],
    };
    const door = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(JSON.stringify(door)).not.toContain('Literal tier channel');
    const desk = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(desk.panels[0]?.rows).toMatchObject([{ type: 'field', value: 'Gold access' }]);
  });

  it('does not interpret an invisible condition source as an empty input', () => {
    const found = fixture();
    found.pass.personalization.tier = null;
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      panels: [
        {
          id: 'p_tier',
          when: { input: 'tier', empty: true },
          rows: [{ id: 'r_tier', type: 'field', label: 'Tier', value: 'No tier' }],
        },
      ],
    };
    const door = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(JSON.stringify(door)).not.toContain('No tier');
    const desk = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(desk.panels[0]?.rows).toMatchObject([{ type: 'field', value: 'No tier' }]);

    const pass = found.passJson as unknown as {
      generic: { secondaryFields: { key: string; value: string | null }[] };
    };
    pass.generic.secondaryFields[1]!.value = null;
    found.scan.display.panels![0]!.when = { path: 'fields.tier', empty: true };
    const doorField = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(JSON.stringify(doorField)).not.toContain('No tier');
    const deskField = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(deskField.panels[0]?.rows).toMatchObject([{ type: 'field', value: 'No tier' }]);
  });
});
