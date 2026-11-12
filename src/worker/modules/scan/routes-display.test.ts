import { beforeEach, describe, expect, it } from 'vitest';
import {
  renderScanDisplay,
  type ScanDisplayScope,
} from '../../../passkit/template/scan-display/index.ts';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import { ScanDisplayPreviewSchema } from '../../../shared/contracts/scan-display-preview.ts';
import { run } from '../../platform/db.ts';
import {
  createPreviewRouteFixture,
  noStore,
  type PreviewRouteFixture,
} from './routes-display-split-fixture.ts';
import {
  BARCODE,
  COUNT,
  display,
  EMAIL,
  ENCODED_SECRET,
  ESCAPED_SECRET,
  EXTERNAL_ID,
  HIDDEN,
  MANAGER_HINT,
  NESTED_EMAIL,
  NESTED_HIDDEN,
  PHONE,
  SECRET,
  SITE,
} from './routes-display-split-seed-test-fixtures.ts';

let fixture: PreviewRouteFixture;

beforeEach(async () => {
  fixture = await createPreviewRouteFixture();
});

describe('real-pass scan display preview', () => {
  it('returns a usable role-filtered scope for the exact organization, template and mode', async () => {
    const { clock, live, sandbox, preview, query, admin } = fixture;
    for (const [mode, pass, name] of [
      ['live', live, 'Alice Morgan'],
      ['test', sandbox, 'Tessa Rivera'],
    ] as const) {
      for (const role of ['door', 'desk', 'manager'] as const) {
        const response = await preview(query({ mode, passId: pass.id, role }), admin(mode));
        expect(response.status).toBe(200);
        noStore(response);
        const body = (await response.json()) as { scope: ScanDisplayScope };
        expect(Object.keys(body)).toEqual(['scope']);
        const inputs = body.scope.inputs as Record<string, unknown>;
        const fields = body.scope.fields as Record<string, unknown>;
        expect(inputs).toMatchObject({ memberName: name, seat: 'C12' });
        // The hidden "locked" value is also true, so its copy cannot be exposed.
        expect(inputs).not.toHaveProperty('canVisit');
        expect(fields).toMatchObject({ name, seat: 'C12' });
        const profile = inputs.profile as Record<string, unknown>;
        expect(profile).toMatchObject({ publicLabel: 'Atrium access' });
        expect(profile).not.toHaveProperty('insideNote');
        expect(profile).not.toHaveProperty('contactEmail');
        if (role === 'manager') {
          expect(profile.managerHint).toBe(MANAGER_HINT);
          expect(fields.nested_manager).toBe(MANAGER_HINT);
        } else {
          expect(profile).not.toHaveProperty('managerHint');
          expect(fields).not.toHaveProperty('nested_manager');
          expect(JSON.stringify(body)).not.toContain(MANAGER_HINT);
        }
        expect(body.scope.lookups).toMatchObject({
          directory: { public: { label: 'Atrium access' } },
        });
        for (const [key, field, value, visible] of [
          ['tier', 'tier', 'Gold', role !== 'door'],
          ['lounge', 'lounge', 'Roof lounge', role === 'manager'],
        ] as const) {
          if (visible) {
            expect(inputs[key]).toBe(value);
            expect(fields[field]).toBe(value);
          } else {
            expect(inputs).not.toHaveProperty(key);
            expect(fields).not.toHaveProperty(field);
          }
        }
        const passScope = body.scope.pass as Record<string, unknown>;
        expect(passScope.externalId ?? null).toBeNull();

        const rendered = renderScanDisplay(display, body.scope, {
          screen: 'ok',
          role,
          locale: 'en',
          timeZone: 'UTC',
          now: clock.now(),
        });
        expect(ScanDisplaySchema.parse(rendered).identity.holder).toBe(name);
        expect(rendered.panels[0]?.rows).toMatchObject([
          { id: 'r_seat', value: 'C12' },
          ...(role !== 'door' ? [{ id: 'r_tier', value: 'Gold' }] : []),
          ...(role === 'manager' ? [{ id: 'r_lounge', value: 'Roof lounge' }] : []),
        ]);
      }
    }
  });

  it('removes secrets, hidden scalar fields, derived copies and expressions before returning scope', async () => {
    const { live, liveScanCode, preview, query } = fixture;
    for (const role of ['door', 'desk', 'manager'] as const) {
      const response = await preview(query({ role }));
      expect(response.status).toBe(200);
      noStore(response);
      const body = (await response.json()) as { scope: ScanDisplayScope };
      const inputs = body.scope.inputs as Record<string, unknown>;
      const fields = body.scope.fields as Record<string, unknown>;
      for (const key of [
        'privateNotes',
        'locked',
        'secretCount',
        'wifiPassword',
        'contact',
        'callback',
        'website',
        'ticketNumber',
      ])
        expect(inputs).not.toHaveProperty(key);
      for (const key of [
        'notes',
        'nested_note',
        'locked',
        'count',
        'secret_a',
        'secret_b',
        'secret_html',
        'contact',
        'phone',
        'site',
        'barcode_copy',
        'scan_ref',
      ])
        expect(fields).not.toHaveProperty(key);
      expect(inputs).not.toHaveProperty('canVisit');
      expect(body.scope).not.toHaveProperty('passJson');
      expect(body.scope).not.toHaveProperty('display');
      const text = JSON.stringify(body);
      for (const value of [
        SECRET,
        ESCAPED_SECRET,
        ENCODED_SECRET,
        HIDDEN,
        NESTED_HIDDEN,
        NESTED_EMAIL,
        EMAIL,
        PHONE,
        SITE,
        BARCODE,
        String(COUNT),
        liveScanCode,
        live.serial,
        live.authToken,
        live.downloadToken,
        '{{',
      ])
        expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
      expect(text).not.toContain(EXTERNAL_ID);
      for (const key of [
        '"passJson"',
        '"pass_json"',
        '"barcode"',
        '"barcodes"',
        '"scanCode"',
        '"serialNumber"',
        '"webServiceURL"',
        '"authenticationToken"',
        '"messageEncoding"',
      ])
        expect(text).not.toContain(key);
    }
  });

  it('does not restore opaque Wallet data through an otherwise public input', async () => {
    const { env, live, preview, query } = fixture;
    const protectedValue = 'opaque-wallet-correlation-value';
    await run(
      env.DB,
      "UPDATE passes SET personalization = json_set(personalization, '$.memberName', ?) WHERE id = ?",
      [protectedValue, live.id],
    );
    await run(
      env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.userInfo', json_object('hint', ?)) WHERE pass_id = ? AND version = 1",
      [protectedValue, live.id],
    );
    const response = await preview(query({ role: 'manager' }));
    expect(response.status).toBe(200);
    noStore(response);
    const text = await response.text();
    expect(text).not.toContain(protectedValue);
    const body = ScanDisplayPreviewSchema.parse(JSON.parse(text));
    expect(body.scope.inputs).not.toHaveProperty('memberName');
  });
});
