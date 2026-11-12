import { describe, expect, it } from 'vitest';
import type { ScanDisplayDoc } from '../../../passkit/template/scan-display/schema.ts';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import type { ScanActor } from './actor.ts';
import { scopeOf } from './card-projection.ts';
import { buildDisplay } from './display.ts';
import { createDisplayFixture, ctx, NOW, SECRET } from './display-split-fixture.ts';

const { fixture, inputOf } = createDisplayFixture();

describe('live scanner display privacy', () => {
  it('drops a rendered template literal that copies a protected value', () => {
    const found = fixture();
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { title: `Secret ${SECRET}` },
      panels: [],
    };
    const rendered = buildDisplay(ctx, inputOf(found, 'door'));
    expect(ScanDisplaySchema.parse(rendered).identity.holder).toBe('Ada North');
    expect(JSON.stringify(rendered)).not.toContain(SECRET);
  });

  it('does not reintroduce a protected value as fallback initials', () => {
    const found = fixture();
    found.pass.personalization.privateNotes = 'AN';
    const display = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(display.identity.holder).toBe('Ada North');
    expect(display.identity.initials).toBe('');
    expect(JSON.stringify(display)).not.toContain('"AN"');
  });

  it.each(['door', 'desk', 'manager'] as const)(
    'redacts unsafe template, scanner and event names and raw identifiers for %s',
    (role) => {
      const found = fixture();
      found.ref.name = `Template ${SECRET}`;
      const input = inputOf(found, role);
      input.actor.name = `Scanner ${SECRET}`;
      input.actor.event = {
        name: `Event ${SECRET}`,
        opensAt: NOW - 1000,
        closesAt: NOW + 1000,
        capacity: 200,
      } as unknown as ScanActor['event'];
      found.scan.display = {
        v: 1,
        holder: '{{pass.templateName}}',
        header: { subtitle: '{{scanner.name}}' },
        panels: [
          {
            id: 'p_event',
            rows: [{ id: 'r_event', type: 'field', label: 'Event', value: '{{event.name}}' }],
          },
        ],
      };
      const scope = scopeOf(ctx, input, found);
      expect((scope.pass as Record<string, unknown>).externalId).toBeNull();
      expect((scope.pass as Record<string, unknown>).templateName).toBe('');
      expect(scope.scanner).toMatchObject({ name: '' });
      expect(scope.event).not.toHaveProperty('name');
      for (const output of [scope, buildDisplay(ctx, input)]) {
        const text = JSON.stringify(output);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(found.pass.externalId);
      }
    },
  );

  it('retains ordinary timestamps but redacts a timestamp copied from a hidden default', () => {
    const found = fixture();
    found.template.manifest.inputs.properties!.hiddenCount = {
      type: 'integer',
      'x-scan': 'hidden',
      default: NOW,
    };
    const input = inputOf(found, 'door');
    input.actor.event = {
      name: 'Conference',
      opensAt: NOW,
      closesAt: NOW + 1000,
      capacity: 200,
    } as unknown as ScanActor['event'];
    const event = scopeOf(ctx, input, found).event;
    expect(event).not.toHaveProperty('opensAt');
    expect(event).toMatchObject({ name: 'Conference', closesAt: NOW + 1000 });
  });

  it('checks a complete literal before rendering can truncate a protected value', () => {
    const found = fixture();
    const hidden = 'confidential-long-customer-marker-938476492';
    found.pass.personalization.privateNotes = hidden;
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { title: hidden },
      panels: [],
    };
    const rendered = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(rendered.identity.holder).toBe('Ada North');
    expect(rendered.header.title).toBeNull();
    expect(JSON.stringify(rendered)).not.toContain(hidden.slice(0, 18));
  });

  it('checks original default-field labels before their first truncation, including the error fallback', () => {
    const found = fixture();
    const hidden = 'confidential-fallback-marker-983746295';
    found.pass.personalization.privateNotes = hidden;
    const pass = found.passJson as unknown as {
      generic: { secondaryFields: { key: string; label?: string }[] };
    };
    pass.generic.secondaryFields[0]!.label = hidden;
    delete found.scan.display;
    const normal = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(JSON.stringify(normal)).not.toContain(hidden.slice(0, 18));

    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { chips: 'broken' },
      panels: [],
    } as unknown as ScanDisplayDoc;
    const fallback = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(fallback.identity.holder).toBe('Ada North');
    expect(JSON.stringify(fallback)).not.toContain(hidden.slice(0, 18));

    delete pass.generic.secondaryFields[0]!.label;
    found.template.manifest.inputs.properties!.points = {
      type: 'integer',
      'x-scan': 'desk',
      'x-label': hidden,
    };
    delete found.scan.display;
    const generated = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(JSON.stringify(generated)).not.toContain(hidden.slice(0, 10));
  });

  it('checks dynamic currency codes and numeric rendered values, not only strings', () => {
    const found = fixture();
    found.pass.personalization.privateNotes = 'VIP';
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      panels: [
        {
          id: 'p_money',
          rows: [{ id: 'r_money', type: 'money', amount: '{{inputs.points}}', currency: 'VIP' }],
        },
      ],
    };
    const money = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(JSON.stringify(money)).not.toContain('"currency":"VIP"');
    expect(money.panels).toEqual([]);

    found.pass.personalization.privateNotes = SECRET;
    found.pass.personalization.hiddenCount = 13;
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      panels: [
        {
          id: 'p_progress',
          rows: [{ id: 'r_progress', type: 'progress', value: '{{inputs.points}}', goal: 13 }],
        },
      ],
    };
    const progress = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(progress.panels).toEqual([]);
    expect(JSON.stringify(progress)).not.toContain('"goal":13');

    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      panels: [
        {
          id: 'p_money',
          rows: [
            {
              id: 'r_money',
              type: 'money',
              amount: '{{inputs.points}}',
              lowBelow: 13,
            },
          ],
        },
      ],
    };
    const threshold = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(threshold.panels).toEqual([]);
  });
});
