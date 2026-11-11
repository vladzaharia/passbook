import { describe, expect, it } from 'vitest';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import type { ScanActor } from './actor.ts';
import { scopeOf } from './card-projection.ts';
import { buildDisplay } from './display.ts';
import {
  AUTH,
  BARCODE,
  createDisplayFixture,
  ctx,
  DOWNLOAD,
  EMAIL,
  ENCODED_SECRET,
  ESCAPED_SECRET,
  HIDDEN_COUNT,
  MANAGER,
  NESTED,
  NOW,
  PHONE,
  SCAN_CODE,
  SECRET,
  SERIAL,
} from './display-split-fixture.ts';

const { actorOf, fixture, inputOf } = createDisplayFixture();

describe('live scanner display privacy', () => {
  it.each(['door', 'desk', 'manager'] as const)(
    'projects declared nested inputs and bound fields for the %s role',
    (role) => {
      const found = fixture();
      const input = inputOf(found, role);
      const scope = scopeOf(ctx, input, found);
      const inputs = scope.inputs as Record<string, unknown>;
      const fields = scope.fields as Record<string, unknown>;
      const profile = inputs.profile as Record<string, unknown>;
      expect(inputs).toMatchObject({ memberName: 'Ada North', seat: 'C12' });
      expect(profile).toMatchObject({ publicLabel: 'Atrium access' });
      expect(fields).toMatchObject({ name: 'Ada North', seat: 'C12' });
      expect(inputs).not.toHaveProperty('undeclaredValue');
      expect(profile).not.toHaveProperty('internalNote');
      expect(profile).not.toHaveProperty('nestedContact');
      if (role === 'door') {
        expect(inputs).not.toHaveProperty('tier');
        expect(fields).not.toHaveProperty('tier');
      } else {
        expect(inputs.tier).toBe('Gold');
        expect(fields.tier).toBe('Gold');
      }
      if (role === 'manager') {
        expect(profile.managerHint).toBe(MANAGER);
        expect(fields.nested_manager).toBe(MANAGER);
      } else {
        expect(profile).not.toHaveProperty('managerHint');
        expect(fields).not.toHaveProperty('nested_manager');
        expect(JSON.stringify(scope)).not.toContain(MANAGER);
      }
      for (const field of [
        'nested_note',
        'notes',
        'mirror',
        'mirror_html',
        'mirror_url',
        'unknown_copy',
        'conditional',
        'count_copy',
        'scan_ref',
        'barcode_copy',
      ])
        expect(fields).not.toHaveProperty(field);
      const text = JSON.stringify(scope);
      for (const forbidden of [
        SECRET,
        ESCAPED_SECRET,
        ENCODED_SECRET,
        NESTED,
        EMAIL,
        'nested@example.test',
        PHONE,
        BARCODE,
        SCAN_CODE,
        AUTH,
        DOWNLOAD,
        SERIAL,
        String(HIDDEN_COUNT),
        'undeclared sensitive value',
      ])
        expect(text).not.toContain(forbidden);
      expect(scope.lookups).toMatchObject({ directory: { public: { label: 'Atrium access' } } });
      const rendered = buildDisplay(ctx, input);
      expect(ScanDisplaySchema.parse(rendered).identity.holder).toBe('Ada North');
      expect(JSON.stringify(rendered)).not.toContain(SECRET);
    },
  );

  it('never trusts cached titles or template-less fallback identities', () => {
    const found = fixture();
    found.template.manifest.display = {
      title: '{{memberName}} / {{profile.managerHint}}',
      subtitle: '{{privateNotes}}',
    };
    found.pass.displayTitle = `Ada North / ${MANAGER}`;
    found.pass.displaySubtitle = SECRET;
    found.scan.display = {
      v: 1,
      holder: '{{pass.title}}',
      header: { subtitle: '{{pass.subtitle}}' },
      panels: [],
    };
    for (const role of ['door', 'desk', 'manager'] as const) {
      const input = inputOf(found, role);
      const scope = scopeOf(ctx, input, found);
      const pass = scope.pass as Record<string, unknown>;
      expect(pass.subtitle ?? null).toBeNull();
      if (role === 'manager') expect(pass.title).toContain(MANAGER);
      else {
        expect(pass.title).not.toContain(MANAGER);
        expect(JSON.stringify(buildDisplay(ctx, input))).not.toContain(MANAGER);
      }
      expect(JSON.stringify(buildDisplay(ctx, input))).not.toContain(SECRET);
    }
    const noTemplate = buildDisplay(ctx, {
      actor: actorOf('door'),
      pass: { id: 'p', title: SECRET },
      screen: 'refused',
    });
    expect(noTemplate?.identity.holder).toBe('Pass');
    expect(JSON.stringify(noTemplate)).not.toContain(SECRET);
  });

  it.each(['eventTicket', 'boardingPass'] as const)(
    'preserves role-projected %s card fields and event scope',
    (style) => {
      const found = fixture();
      const pass = found.passJson as unknown as Record<string, unknown>;
      const fields = pass.generic;
      delete pass.generic;
      pass[style] = fields;
      const input = inputOf(found, 'door');
      input.actor.event = {
        name: 'Conference',
        opensAt: NOW - 1000,
        closesAt: NOW + 1000,
        capacity: 200,
        secret: SECRET,
      } as unknown as ScanActor['event'];
      const door = scopeOf(ctx, input, found);
      expect(door.fields).toMatchObject({ name: 'Ada North', seat: 'C12' });
      expect(door.fields).not.toHaveProperty('tier');
      expect(door.fields).not.toHaveProperty('notes');
      expect(door.event).toEqual({
        name: 'Conference',
        opensAt: NOW - 1000,
        closesAt: NOW + 1000,
        capacity: 200,
      });
      input.actor = { ...input.actor, role: 'desk' };
      expect(scopeOf(ctx, input, found).fields).toMatchObject({ seat: 'C12', tier: 'Gold' });
      expect(JSON.stringify(scopeOf(ctx, input, found))).not.toContain(SECRET);
    },
  );

  it('does not mistake a structural row type for a copied hidden value', () => {
    const found = fixture();
    found.pass.personalization.privateNotes = 'field';
    const display = ScanDisplaySchema.parse(buildDisplay(ctx, inputOf(found, 'door')));
    expect(display.panels[0]?.rows).toMatchObject([{ type: 'field', value: 'C12' }]);
  });

  it('accepts only an explicit, privacy-safe render-time photo URL', () => {
    const found = fixture();
    const photoUrl = '/api/v1/scan/member-photo/pass-1?g=grant';
    const input = inputOf(found, 'door');
    expect(found).not.toHaveProperty('photoUrl');
    expect(scopeOf(ctx, input, found).assets).toEqual({});
    expect(ScanDisplaySchema.parse(buildDisplay(ctx, input)).identity.photo).toBeNull();
    input.photoUrl = photoUrl;
    expect(scopeOf(ctx, input, found).assets).toEqual({ photo: photoUrl });
    const rendered = ScanDisplaySchema.parse(buildDisplay(ctx, input));
    expect(rendered.identity.photo?.url).toBe(photoUrl);
    input.photoUrl = `/api/v1/scan/member-photo/pass-1?g=${SECRET}`;
    expect(scopeOf(ctx, input, found).assets).toEqual({});
  });

  it('does not render authored or metadata text without an effective role', () => {
    const found = fixture();
    const input = inputOf(found, 'door');
    input.actor.role = null;
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { title: 'Private event' },
      panels: [],
    };
    const display = ScanDisplaySchema.parse(buildDisplay(ctx, input));
    expect(display.identity.holder).toBe('Pass');
    expect(display.header.title).toBeNull();
    expect(JSON.stringify(display)).not.toContain('Ada North');
  });
});
