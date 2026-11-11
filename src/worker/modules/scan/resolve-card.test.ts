import { beforeAll, describe, expect, it } from 'vitest';
import type { PassJson } from '../../../passkit/types.ts';
import { normalize } from '../../../shared/pass-view/normalize.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { installVersion, pinFixtureVersion, walletFixture } from './repo-resolve-test-fixtures.ts';
import {
  body,
  CHECK_IN,
  door,
  kit,
  resolve,
  setupResolveFixture,
  tpl,
} from './resolve-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupResolveFixture);

describe('resolve: the card', () => {
  it('has no barcode, nfc, token, URL, serial or readable email', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl, {}, { holderEmail: 'anna.popescu@example.com' });
    const { out } = await resolve(s.headers, codeOf(pass));
    const text = JSON.stringify(out.card);
    for (const word of [
      'barcodes',
      '"barcode"',
      '"nfc"',
      'authenticationToken',
      'webServiceURL',
      'serialNumber',
      'anna.popescu@example.com',
      pass.serial,
      pass.scanCode ?? 'x',
    ])
      expect(text).not.toContain(word);
    const pj = out.card?.passView.passJson as Record<string, unknown>;
    expect(pj).not.toHaveProperty('barcodes');
    expect(out.card?.passView.assetNames).toContain('icon.png');
  });

  it('keeps hidden stop flags effective without disclosing the flag', async () => {
    const templateId = await kit.scanTemplate('Private hold', {
      actions: [CHECK_IN],
      flags: [{ input: 'tier', label: 'Private hold reason', equals: ['blocked'], stop: true }],
    });
    const base = await kit.registry.resolve(templateId);
    const manifest = structuredClone(base.manifest);
    manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'hidden' };
    await installVersion(templateId, 'v2', manifest, base.passJson);
    const pass = await kit.scanPass(templateId, { tier: 'blocked' });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const { out } = await resolve(scanner.headers, codeOf(pass));
    expect(out).toMatchObject({ kind: 'heads_up', reason: 'check_required', flags: [] });
    expect(out.card?.flags).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('Private hold reason');
    expect(JSON.stringify(out)).not.toContain('blocked');
  });

  it('preserves authorized poster semantics while omitting other metadata and restricted sources', async () => {
    const templateId = await kit.scanTemplate('Poster preview', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId, { tier: 'Private balcony' });
    const base = await kit.registry.resolve(templateId);
    const template = {
      ...base,
      manifest: structuredClone(base.manifest),
      passJson: structuredClone(base.passJson),
    };
    template.manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager' };
    template.manifest.bindings.push({
      to: { pointer: '/semantics/admissionLevel' },
      value: '{{tier}}',
    });
    delete template.passJson.generic;
    template.passJson.eventTicket = {
      primaryFields: [
        {
          key: 'name',
          label: 'Member',
          value: '',
          semantics: { eventName: 'Summer Gala', attendeeName: 'PRIVATE-ATTENDEE-METADATA' },
        },
      ],
    };
    template.passJson.preferredStyleSchemes = ['posterEventTicket', 'eventTicket'];
    template.passJson.semantics = {
      venueName: 'Garden Hall',
      venueRegionName: 'North City',
      venueRoom: 'Main Stage',
      eventStartDate: '2031-06-01T20:00:00Z',
      seats: [
        {
          seatSection: 'A',
          seatRow: 'B',
          seatNumber: '17',
          seatDescription: 'PRIVATE-SEAT-METADATA',
        },
      ],
      venuePhoneNumber: '+1 415 555 0123',
      wifiAccess: [{ ssid: 'network', password: 'PRIVATE-WIFI-SECRET' }],
    };
    const pinnedRelease = await installVersion(
      templateId,
      'v2',
      template.manifest,
      template.passJson,
    );
    await pinFixtureVersion(pass.id, 'v2', pinnedRelease.id);
    const snapshot = await walletFixture(pass.id, template.passJson);
    snapshot.serialNumber = pass.serial;
    snapshot.eventTicket!.primaryFields![0]!.value = 'Anna Popescu';
    if (!snapshot.semantics) throw new Error('Missing semantic fixture');
    snapshot.semantics = { ...snapshot.semantics, admissionLevel: 'Private balcony' };
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      JSON.stringify(snapshot),
      pass.id,
    ]);
    const manager = await kit.staff('manager');
    const scanners = [
      await kit.scanner({ templateIds: [templateId], settings: { roleWithoutSignIn: 'door' } }),
      await kit.scanner({
        templateIds: [templateId],
        settings: { staffSignIn: true },
        staffId: manager.id,
      }),
    ];
    for (const [index, scanner] of scanners.entries()) {
      const card = (await resolve(scanner.headers, codeOf(pass))).out.card!;
      const projected = card.passView.passJson as PassJson;
      expect(normalize(projected, { assets: {} }).layouts.ios27.poster).toBe(true);
      expect(projected.semantics).toMatchObject({
        venueName: 'Garden Hall',
        venueRegionName: 'North City',
        venueRoom: 'Main Stage',
        seats: [{ seatSection: 'A', seatRow: 'B', seatNumber: '17' }],
      });
      expect(projected.eventTicket?.primaryFields?.[0]?.semantics).toEqual({
        eventName: 'Summer Gala',
      });
      expect(projected.semantics?.admissionLevel).toBe(index === 1 ? 'Private balcony' : undefined);
      const serialized = JSON.stringify(card);
      for (const forbidden of [
        'PRIVATE-ATTENDEE-METADATA',
        'PRIVATE-SEAT-METADATA',
        'PRIVATE-WIFI-SECRET',
        '+1 415 555 0123',
      ])
        expect(serialized).not.toContain(forbidden);
      if (index === 0) expect(serialized).not.toContain('Private balcony');
    }
  });

  it('retains authorized semantic boarding details without the confirmation number', async () => {
    const templateId = await kit.scanTemplate('Boarding preview', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const base = await kit.registry.resolve(templateId);
    const template = {
      ...base,
      manifest: structuredClone(base.manifest),
      passJson: structuredClone(base.passJson),
    };
    delete template.passJson.generic;
    template.passJson.boardingPass = {
      transitType: 'PKTransitTypeAir',
      primaryFields: [{ key: 'name', label: 'Passenger', value: '' }],
    };
    template.passJson.preferredStyleSchemes = ['semanticBoardingPass', 'boardingPass'];
    template.passJson.semantics = {
      departureAirportCode: 'SFO',
      departureCityName: 'San Francisco',
      destinationAirportCode: 'SEA',
      destinationCityName: 'Seattle',
      departureGate: 'B2',
      flightCode: 'FL123',
      seats: [{ seatNumber: '14A' }],
      confirmationNumber: 'PRIVATE-CONFIRMATION-546',
    };
    const pinnedRelease = await installVersion(
      templateId,
      'v2',
      template.manifest,
      template.passJson,
    );
    await pinFixtureVersion(pass.id, 'v2', pinnedRelease.id);
    const snapshot = await walletFixture(pass.id, template.passJson);
    snapshot.serialNumber = pass.serial;
    snapshot.boardingPass!.primaryFields![0]!.value = 'Anna Popescu';
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      JSON.stringify(snapshot),
      pass.id,
    ]);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const card = (await resolve(scanner.headers, codeOf(pass))).out.card!;
    const projected = card.passView.passJson as PassJson;
    expect(normalize(projected, { assets: {} }).layouts.ios27.semantic).toMatchObject({
      kind: 'flight',
      from: 'SFO',
      fromName: 'San Francisco',
      to: 'SEA',
      toName: 'Seattle',
      gate: 'B2',
      flight: 'FL123',
      seat: '14A',
    });
    expect(JSON.stringify(card)).not.toContain('PRIVATE-CONFIRMATION-546');
  });

  it('retains an action record only when every nested value is visible', async () => {
    const templateId = await kit.scanTemplate('Record projection', {
      actions: [{ ...CHECK_IN, input: 'attendance' }],
    });
    const base = await kit.registry.resolve(templateId);
    const manifest = structuredClone(base.manifest);
    manifest.inputs.properties!.attendance = {
      type: 'object',
      properties: {
        zone: { type: 'string' },
        managerHint: { type: 'string', 'x-scan': 'manager' },
      },
    };
    await installVersion(templateId, 'v2', manifest, base.passJson);
    const pass = await kit.scanPass(templateId);
    await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
      JSON.stringify({
        memberName: 'Anna Popescu',
        attendance: { zone: 'East lobby', managerHint: 'VIP usher' },
      }),
      pass.id,
    ]);
    await run(
      kit.env.DB,
      `UPDATE pass_versions
      SET personalization=(SELECT personalization FROM passes WHERE id=?) WHERE pass_id=?`,
      [pass.id, pass.id],
    );
    const manager = await kit.staff('manager');
    const doorScanner = await kit.scanner({ templateIds: [templateId] });
    const managerScanner = await kit.scanner({
      templateIds: [templateId],
      settings: { staffSignIn: true },
      staffId: manager.id,
    });
    const doorCard = (await resolve(doorScanner.headers, codeOf(pass))).out.card!;
    expect(doorCard.values.map((value) => value.input)).not.toContain('attendance');
    expect(JSON.stringify(doorCard)).not.toContain('VIP usher');
    const managerCard = (await resolve(managerScanner.headers, codeOf(pass))).out.card!;
    expect(managerCard.values).toContainEqual(
      expect.objectContaining({
        input: 'attendance',
        before: { zone: 'East lobby', managerHint: 'VIP usher' },
      }),
    );
  });

  it('omits an included member-photo alias for every role and keeps ordinary thumbnails', async () => {
    const templateId = await kit.scanTemplate('Photo projection', {
      actions: [CHECK_IN],
      display: { v: 1, header: {}, photo: { minRole: 'desk' } },
    });
    const base = await kit.registry.resolve(templateId);
    const photo = makePng(270, 270);
    await installVersion(templateId, 'v2', base.manifest, base.passJson, null, {
      'icon.png': ICON_PNG,
      'thumbnail@3x.png': photo,
    });
    const included = await kit.scanPass(templateId);
    const ordinary = await kit.scanPass(templateId);
    const notIncluded = await kit.scanPass(templateId);
    const system = { type: 'system' as const, id: null };
    const png = btoa(String.fromCharCode(...photo));
    await putMemberPhoto(jobCtxOf(kit), system, included.id, { png, includeInPass: true }, null);
    await putMemberPhoto(kit.ctx, system, notIncluded.id, { png, includeInPass: false }, null);
    const lowRole = await kit.scanner({
      templateIds: [templateId],
      settings: { roleWithoutSignIn: 'door' },
    });
    const highRole = await kit.scanner({
      templateIds: [templateId],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const disabled = await kit.scanner({
      templateIds: [templateId],
      settings: { roleWithoutSignIn: 'desk', showPhoto: false },
    });
    for (const scanner of [lowRole, disabled]) {
      const card = (await resolve(scanner.headers, codeOf(included))).out.card!;
      expect(card.passView.assetNames).toContain('icon.png');
      expect(card.passView.assetNames).not.toContain('thumbnail@3x.png');
      expect(card.display.identity.photo).toBeNull();
      for (const pass of [ordinary, notIncluded]) {
        const regular = (await resolve(scanner.headers, codeOf(pass))).out.card!;
        expect(regular.passView.assetNames).toContain('thumbnail@3x.png');
      }
    }
    const permitted = (await resolve(highRole.headers, codeOf(included))).out.card!;
    expect(permitted.passView.assetNames).not.toContain('thumbnail@3x.png');
    expect(permitted.passView.assetNames).toContain('icon.png');
    expect(permitted.display.identity.photo?.url).toContain('/assets/member.png?g=');
  });

  it('door state and last scans come from the gates and the scans table', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    expect((await resolve(s.headers, codeOf(pass))).out.card?.door).toEqual({ state: null });
    await kit.post(s.headers, '/actions', { ...body(codeOf(pass)), actionId: 'auto' });
    const card = (await resolve(s.headers, codeOf(pass))).out.card;
    expect(card?.door).toEqual({ state: 'in' });
    expect(card?.actions[0]).toMatchObject({ available: false, reason: 'already_done' });
    expect(card?.lastScans).toHaveLength(1);
  });
});
