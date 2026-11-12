import { describe, expect, it } from 'vitest';
import type { ScanDisplayDoc } from '../../../passkit/template/scan-display/schema.ts';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import { scopeOf } from './card-projection.ts';
import { sourcePolicyProven } from './card-semantics.ts';
import { buildDisplay } from './display.ts';
import { createDisplayFixture, ctx } from './display-split-fixture.ts';

const { fixture, inputOf, otherKeysetCommitment } = createDisplayFixture();

describe('live scanner display privacy', () => {
  it('intersects the pinned and active template source policies', () => {
    const found = fixture();
    const active = {
      ...found.template,
      version: 'v2',
      manifest: structuredClone(found.template.manifest),
    };
    const props = active.manifest.inputs.properties ?? {};
    props.seat = { type: 'string', 'x-scan': 'manager' };
    props.tier = { type: 'string', 'x-scan': 'hidden' };
    active.manifest.inputs.properties = props;
    active.manifest.bindings.push({ to: { field: 'seat' }, value: '{{privateNotes}}' });
    found.activeTemplate = active;
    found.activeVersion = active.version;

    for (const role of ['door', 'desk', 'manager'] as const) {
      const scope = scopeOf(ctx, inputOf(found, role), found);
      const inputs = scope.inputs as Record<string, unknown>;
      const fields = scope.fields as Record<string, unknown>;
      expect(inputs).not.toHaveProperty('tier');
      expect(fields).not.toHaveProperty('tier');
      expect(fields).not.toHaveProperty('seat');
      if (role === 'manager') expect(inputs.seat).toBe('C12');
      else expect(inputs).not.toHaveProperty('seat');
      expect(JSON.stringify(buildDisplay(ctx, inputOf(found, role)))).not.toContain('Gold');
    }
  });

  it('uses the current source policy even when the pinned display build is retained', () => {
    const found = fixture();
    const active = {
      ...found.template,
      version: 'v2',
      manifest: structuredClone(found.template.manifest),
    };
    active.manifest.inputs.properties!.memberName = { type: 'string', 'x-scan': 'manager' };
    active.manifest.inputs.properties!.seat = { type: 'string', 'x-scan': 'manager' };
    active.manifest.bindings.push({ to: { field: 'seat' }, value: '{{privateNotes}}' });
    found.activeVersion = active.version;
    found.activePolicy = active;
    found.activeTemplate = found.template;

    for (const role of ['door', 'desk', 'manager'] as const) {
      const input = inputOf(found, role);
      const scope = scopeOf(ctx, input, found);
      expect(scope.fields).not.toHaveProperty('seat');
      if (role === 'manager') {
        expect(scope.inputs).toMatchObject({ memberName: 'Ada North', seat: 'C12' });
      } else {
        expect(scope.inputs).not.toHaveProperty('memberName');
        expect(scope.inputs).not.toHaveProperty('seat');
        expect(JSON.stringify(buildDisplay(ctx, input))).not.toContain('Ada North');
        expect(JSON.stringify(buildDisplay(ctx, input))).not.toContain('C12');
      }
    }
  });

  it('uses a generic identity when either source policy or its scope is unproven', () => {
    const found = fixture();
    const input = inputOf(found, 'manager');
    found.activeVersion = 'v2';
    found.activeTemplate = found.template;
    expect(ScanDisplaySchema.parse(buildDisplay(ctx, input)).identity.holder).toBe('Pass');

    found.activePolicy = { ...found.template, id: 'other-template', version: 'v2' };
    expect(ScanDisplaySchema.parse(buildDisplay(ctx, input)).identity.holder).toBe('Pass');

    found.activePolicy = { ...found.template, version: 'v2' };
    found.pass.templateVersion = 'unknown';
    expect(ScanDisplaySchema.parse(buildDisplay(ctx, input)).identity.holder).toBe('Pass');

    found.pass.templateVersion = found.template.version;
    input.actor.orgId = 'other-org';
    expect(ScanDisplaySchema.parse(buildDisplay(ctx, input)).identity.holder).toBe('Pass');
  });

  it('requires the actor and pass to retain the same captured credential keyset', () => {
    const found = fixture();
    const input = inputOf(found, 'door');
    expect(sourcePolicyProven(found, input.actor)).toBe(true);
    expect(ScanDisplaySchema.parse(buildDisplay(ctx, input)).identity.holder).toBe('Ada North');

    const unproven = [
      { found, actor: { ...input.actor, credentialKeysetCommitment: undefined } },
      { found, actor: { ...input.actor, credentialKeysetCommitment: '' } },
      { found, actor: { ...input.actor, credentialKeysetCommitment: otherKeysetCommitment() } },
      { found: { ...found, credentialKeysetCommitment: '' }, actor: input.actor },
      {
        found: { ...found, credentialKeysetCommitment: otherKeysetCommitment() },
        actor: input.actor,
      },
    ];
    for (const item of unproven) {
      expect(sourcePolicyProven(item.found, item.actor)).toBe(false);
      expect(
        ScanDisplaySchema.parse(
          buildDisplay(ctx, {
            ...input,
            actor: item.actor,
            template: item.found,
          }),
        ).identity.holder,
      ).toBe('Pass');
    }
  });

  it('intersects pinned and current display element roles when builds differ', () => {
    const found = fixture();
    const display: ScanDisplayDoc = {
      v: 1,
      holder: '{{inputs.memberName}}',
      photo: {},
      header: { chips: [{ id: 'c_priority', text: 'Priority', tone: 'teal' }] },
      panels: [
        {
          id: 'p_seat',
          rows: [{ id: 'r_seat', type: 'field', label: 'Seat', value: '{{inputs.seat}}' }],
        },
      ],
    };
    found.template.manifest.scan!.display = display;
    found.scan.display = display;
    const photoUrl = '/api/v1/scan/member-photo/pass-1?g=grant';
    const active = {
      ...found.template,
      version: 'v2',
      manifest: structuredClone(found.template.manifest),
    };
    const current = active.manifest.scan!.display!;
    current.photo = { minRole: 'manager' };
    current.header.chips![0]!.minRole = 'manager';
    current.panels![0]!.rows[0]!.minRole = 'manager';
    found.activePolicy = active;
    found.activeTemplate = found.template;
    found.activeVersion = active.version;

    const door = ScanDisplaySchema.parse(
      buildDisplay(ctx, { ...inputOf(found, 'door'), photoUrl }),
    );
    expect(door.header.chips).toEqual([]);
    expect(door.panels).toEqual([]);
    expect(door.identity.photo).toBeNull();
    const manager = ScanDisplaySchema.parse(
      buildDisplay(ctx, { ...inputOf(found, 'manager'), photoUrl }),
    );
    expect(manager.header.chips).toMatchObject([{ text: 'Priority' }]);
    expect(manager.panels[0]?.rows).toMatchObject([{ type: 'field', value: 'C12' }]);
    expect(manager.identity.photo?.url).toBe(photoUrl);

    current.panels![0]!.rows[0]!.minRole = 'door';
    current.panels![0]!.minRole = 'manager';
    expect(ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door'))).panels).toEqual([]);

    current.panels = [];
    const removed = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'manager')));
    expect(removed.panels).toEqual([]);
  });

  it('intersects current roles for variant chips and nested chip and list items', () => {
    const found = fixture();
    const display: ScanDisplayDoc = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      variants: [
        {
          id: 'v_priority',
          name: 'Priority',
          when: { input: 'seat', eq: 'C12' },
          header: { chips: [{ id: 'c_variant', text: 'Variant secret', tone: 'teal' }] },
        },
      ],
      panels: [
        {
          id: 'p_details',
          rows: [
            {
              id: 'r_chips',
              type: 'chips',
              items: [
                { id: 'c_public', text: 'Entry', tone: 'teal' },
                { id: 'c_private', text: 'Restricted', tone: 'gold' },
              ],
            },
            {
              id: 'r_list',
              type: 'list',
              items: [
                { id: 'l_public', text: 'Access', icon: 'info' },
                { id: 'l_private', text: 'Members', icon: 'info' },
              ],
            },
          ],
        },
      ],
    };
    found.template.manifest.scan!.display = display;
    found.scan.display = display;
    const active = {
      ...found.template,
      version: 'v2',
      manifest: structuredClone(found.template.manifest),
    };
    const current = active.manifest.scan!.display!;
    current.variants![0]!.header.chips![0]!.minRole = 'manager';
    const chips = current.panels![0]!.rows[0]!;
    const list = current.panels![0]!.rows[1]!;
    if (chips.type !== 'chips' || list.type !== 'list') throw new Error('Unexpected fixture rows');
    chips.items[1]!.minRole = 'manager';
    list.items[1]!.minRole = 'manager';
    found.activePolicy = active;
    found.activeTemplate = found.template;
    found.activeVersion = active.version;

    const door = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    const doorText = JSON.stringify(door);
    expect(doorText).toContain('Entry');
    expect(doorText).toContain('Access');
    expect(doorText).not.toContain('Variant secret');
    expect(doorText).not.toContain('Restricted');
    expect(doorText).not.toContain('Members');
    const managerText = JSON.stringify(buildDisplay(ctx, inputOf(found, 'manager')));
    expect(managerText).toContain('Variant secret');
    expect(managerText).toContain('Restricted');
    expect(managerText).toContain('Members');
  });
});
