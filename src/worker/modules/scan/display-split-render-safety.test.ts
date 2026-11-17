import { describe, expect, it } from 'vitest';
import type { ScanDisplayDoc } from '../../../passkit/template/scan-display/schema.ts';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import type { ScanActor } from './actor.ts';
import { scopeOf } from './card-projection.ts';
import { buildDisplay } from './display.ts';
import { createDisplayFixture, ctx, NOW, SCAN_CODE } from './display-split-fixture.ts';

const { fixture, inputOf } = createDisplayFixture();

describe('live scanner display privacy', () => {
  it('drops a rendered template literal that holds a secret, keeping the rest of the display', () => {
    const found = fixture();
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { title: `Secret ${SCAN_CODE}` },
      panels: [],
    };
    const rendered = buildDisplay(ctx, inputOf(found, 'door'));
    expect(ScanDisplaySchema.parse(rendered).identity.holder).toBe('Ada North');
    expect(ScanDisplaySchema.parse(rendered).header.title).toBeNull();
    expect(JSON.stringify(rendered)).not.toContain(SCAN_CODE);
    // Positive control: a desk-only input's value is not a secret, so authored text may repeat it.
    found.scan.display.header.title = 'Note Gold';
    expect(ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door'))).header.title).toBe(
      'Note Gold',
    );
  });

  it('drops one bad row, not the whole display', () => {
    const found = fixture();
    const code = 'code-secret-91';
    found.pass.scanCode = code;
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { chips: [{ id: 'c_code', text: code, tone: 'teal' }] },
      panels: [
        {
          id: 'p_details',
          rows: [
            { id: 'r_seat', type: 'field', label: 'Seat', value: '{{fields.seat}}' },
            { id: 'r_code', type: 'field', label: 'Code', value: code },
            { id: 'r_name', type: 'field', label: 'Name', value: '{{inputs.memberName}}' },
          ],
        },
      ],
    };
    const rendered = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(rendered.identity.holder).toBe('Ada North');
    expect(rendered.panels[0]?.rows.map((row) => row.id)).toEqual(['r_seat', 'r_name']);
    expect(rendered.header.chips).toEqual([]);
    expect(JSON.stringify(rendered)).not.toContain(code);
  });

  it('shows a title or order number that merely looks like a phone number', () => {
    const found = fixture();
    found.pass.personalization.memberName = 'Order 20261105 0042';
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { title: 'Ref 0123 4567 8901' },
      panels: [],
    };
    const rendered = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(rendered.identity.holder).toBe('Order 20261105 0042');
    expect(rendered.header.title).toBe('Ref 0123 4567 8901');
  });

  it('does not reintroduce a secret as the holder or its initials', () => {
    const found = fixture();
    found.pass.personalization.memberName = SCAN_CODE;
    const display = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    // The unsafe name is not projected, so the holder falls back to the template name.
    expect(display.identity.holder).toBe('Test template');
    expect(display.identity.initials).toBe('TT');
    expect(JSON.stringify(display)).not.toContain(SCAN_CODE);
  });

  it.each(['door', 'desk', 'manager'] as const)(
    'redacts unsafe template, scanner and event names and raw identifiers for %s',
    (role) => {
      const found = fixture();
      found.ref.name = `Template ${SCAN_CODE}`;
      const input = inputOf(found, role);
      input.actor.name = `Scanner ${SCAN_CODE}`;
      input.actor.event = {
        name: `Event ${SCAN_CODE}`,
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
        expect(text).not.toContain(SCAN_CODE);
        expect(text).not.toContain(found.pass.externalId);
      }
      // Positive control: ordinary names pass through.
      found.ref.name = 'Gold pass';
      input.actor.name = 'Front door';
      input.actor.event = {
        name: 'Conference',
        opensAt: NOW - 1000,
        closesAt: NOW + 1000,
        capacity: 200,
      } as unknown as ScanActor['event'];
      const open = scopeOf(ctx, input, found);
      expect((open.pass as Record<string, unknown>).templateName).toBe('Gold pass');
      expect(open.scanner).toMatchObject({ name: 'Front door' });
      expect(open.event).toMatchObject({ name: 'Conference' });
    },
  );

  it('retains ordinary timestamps but redacts a timestamp that is a secret', () => {
    const found = fixture();
    found.pass.scanCode = String(NOW);
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
    found.pass.scanCode = hidden;
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
    found.pass.scanCode = hidden;
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

  it('checks numeric authored values, not only strings', () => {
    const found = fixture();
    found.pass.scanCode = '918273';
    const doc = (lowBelow: number): ScanDisplayDoc => ({
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
              currency: 'USD',
              lowBelow,
            },
          ],
        },
      ],
    });
    found.scan.display = doc(918273);
    const dropped = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(dropped.identity.holder).toBe('Ada North');
    expect(dropped.panels).toEqual([]);
    found.scan.display = doc(5);
    const kept = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'desk')));
    expect(kept.panels[0]?.rows).toMatchObject([{ type: 'money', currency: 'USD' }]);
  });
});
