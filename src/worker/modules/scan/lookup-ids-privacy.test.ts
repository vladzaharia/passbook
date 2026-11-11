import { beforeEach, describe, expect, it } from 'vitest';
import { makePass } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import {
  cloneLookupPasses,
  kit,
  roleRestrictedTemplate,
  search,
  setupLookupIdsFixture,
  templateId,
} from './repo-lookup-ids-test-fixtures.ts';
import { setPass } from './test-kit.ts';

beforeEach(setupLookupIdsFixture);

describe('lookup privacy', () => {
  it('searches only role-visible names and never echoes credentials, contact, or hidden identity', async () => {
    const restricted = await roleRestrictedTemplate();
    const email = 'private-holder@example.test';
    const memberNo = 'MEMBER-CODE-2579';
    const externalId = 'external-secret-385';
    const pass = await kit.scanPass(
      restricted,
      { memberName: 'Harbor Alice', accessZone: 'Velvet Lounge', memberNo },
      { holderEmail: email },
    );
    await setPass(kit, pass.id, 'external_id = ?', [externalId]);
    const door = await kit.scanner({ templateIds: [restricted] });
    const desk = await kit.scanner({
      templateIds: [restricted],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const managerStaff = await kit.staff('manager');
    const manager = await kit.scanner({
      templateIds: [restricted],
      settings: { staffSignIn: true },
      staffId: managerStaff.id,
    });

    expect(await search('Harbor', door.headers)).toEqual({ items: [], more: false });
    expect(await search('Velvet', door.headers)).toEqual({ items: [], more: false });
    expect(await search('Velvet', desk.headers)).toEqual({ items: [], more: false });
    expect((await search('Harbor', desk.headers)).items).toMatchObject([
      { passId: pass.id, title: 'Harbor Alice', subtitle: null, maskedEmail: null },
    ]);
    expect((await search('Velvet', manager.headers)).items).toMatchObject([
      { passId: pass.id, title: 'Harbor Alice', subtitle: 'Velvet Lounge', maskedEmail: null },
    ]);

    const forbidden = [
      memberNo,
      externalId,
      email,
      pass.serial,
      pass.authToken,
      pass.downloadToken,
      pass.webServiceUrl,
      pass.scanCode!,
      'opaque:qr:payload',
      'Harbor Alice',
      'Velvet Lounge',
    ];
    for (const query of [
      pass.id,
      pass.serial,
      pass.scanCode!,
      memberNo,
      externalId,
      email,
      'opaque:qr:payload',
    ]) {
      const result = await search(query, door.headers);
      expect(result).toMatchObject({
        items: [
          { passId: pass.id, title: '', subtitle: null, maskedEmail: null, status: 'active' },
        ],
        more: false,
      });
      const text = JSON.stringify(result);
      for (const value of forbidden) expect(text).not.toContain(value);
    }
    expect(await search('private-holder@exam', door.headers)).toEqual({ items: [], more: false });

    // The indexed values may be stale or sensitive; projection must recompute them from inputs.
    await setPass(kit, pass.id, 'display_title = ?, display_subtitle = ?', [pass.authToken, email]);
    const projected = await search(pass.id, manager.headers);
    expect(projected.items).toMatchObject([
      { passId: pass.id, title: 'Harbor Alice', subtitle: 'Velvet Lounge', maskedEmail: null },
    ]);
    for (const value of [pass.authToken, pass.downloadToken, email, pass.serial, pass.scanCode!])
      expect(JSON.stringify(projected)).not.toContain(value);
    expect(await search(pass.authToken, manager.headers)).toEqual({ items: [], more: false });

    const audits = await kit.env.DB.prepare(
      "SELECT target_id, detail FROM audit_log WHERE action = 'scan.lookup'",
    ).all<{ target_id: string | null; detail: string }>();
    expect(audits.results.length).toBeGreaterThan(0);
    for (const audit of audits.results) {
      expect(audit.target_id).toBeNull();
      expect(JSON.parse(audit.detail)).toEqual({ count: expect.any(Number) });
    }
    for (const value of [...forbidden, pass.id])
      expect(JSON.stringify(audits.results)).not.toContain(value);
  });

  it('does not disclose restricted values or credentials through a template name', async () => {
    const cases = [
      { name: 'Hidden Desk Identity' },
      { name: 'person@example.test' },
      { name: 'SERIAL-COLLISION-842', column: 'serial' },
      { name: 'AUTH-COLLISION-842', column: 'auth_token' },
      { name: 'DOWNLOAD-COLLISION-842', column: 'download_token' },
      { name: 'https://wallet.test/private', column: 'web_service_url' },
      { name: 'A'.repeat(26), column: 'scan_code' },
    ] as const;
    for (const entry of cases) {
      const restricted = await roleRestrictedTemplate(entry.name);
      const column = 'column' in entry ? entry.column : undefined;
      const pass = await makePass(kit.fx, {
        orgId: kit.org.id,
        template: await kit.registry.resolve(restricted),
        personalization: { memberName: 'Hidden Desk Identity' },
        holderEmail: 'person@example.test',
        ...(column === 'serial' ? { serial: entry.name } : {}),
        ...(column === 'auth_token' ? { authToken: entry.name } : {}),
        ...(column === 'scan_code' ? { scanCode: entry.name } : {}),
      });
      await run(
        kit.env.DB,
        `UPDATE pass_versions SET pass_json=(
        SELECT json_set(tv.pass_json,'$.serialNumber',p.serial,
          '$.passTypeIdentifier',si.pass_type_identifier,'$.teamIdentifier',si.team_identifier)
        FROM passes p JOIN template_versions tv ON tv.template_id=p.template_id AND tv.version=p.template_version
        JOIN signing_identities si ON si.id=p.identity_id WHERE p.id=?
      ) WHERE pass_id=?`,
        [pass.id, pass.id],
      );
      if (column === 'download_token' || column === 'web_service_url')
        await setPass(kit, pass.id, `${column} = ?`, [entry.name]);
      const scanner = await kit.scanner({ templateIds: [restricted] });
      const result = await search(pass.id, scanner.headers);
      expect(result.items.map((item) => item.passId)).toEqual([pass.id]);
      expect(JSON.stringify(result)).not.toContain(entry.name);
    }
  });

  it('continues past more than 50 hidden names and fills the visible page', async () => {
    const restricted = await roleRestrictedTemplate();
    const hidden = await kit.scanPass(restricted, { memberName: 'Paged Alpha' });
    const hiddenIds = await cloneLookupPasses(hidden.id, 'hidden', 'Paged Alpha ', 55);
    const visible = await kit.scanPass(templateId, { memberName: 'Paged Zulu' });
    const visibleIds = await cloneLookupPasses(visible.id, 'visible', 'Paged Zulu ', 10);
    const scanner = await kit.scanner({ templateIds: [restricted, templateId] });

    const result = await search('Paged', scanner.headers);
    expect(result.items).toHaveLength(10);
    expect(result.more).toBe(true);
    const allowed = new Set([visible.id, ...visibleIds]);
    for (const item of result.items) {
      expect(allowed.has(item.passId)).toBe(true);
      expect(item.title).toMatch(/^Paged Zulu/);
      expect(item.maskedEmail).toBeNull();
    }
    const serialized = JSON.stringify(result);
    for (const id of [hidden.id, ...hiddenIds]) expect(serialized).not.toContain(id);
    expect(serialized).not.toContain('Paged Alpha');
  }, 60_000);

  it('excludes quarantined, deleted, removed, voided and invalid Wallet passes before the page cap', async () => {
    const common = 'shared-external-id-495';
    const shadow = await kit.scanPass(templateId, { memberName: 'Shadow Alpha' });
    await setPass(kit, shadow.id, 'external_id = ?', [common]);
    const quarantined = await cloneLookupPasses(
      shadow.id,
      'quarantined',
      'Shadow Alpha ',
      55,
      true,
    );
    await setPass(kit, shadow.id, 'test_data_quarantined = ?', [1]);

    const valid = await kit.scanPass(templateId, { memberName: 'Shadow Zulu' });
    await setPass(kit, valid.id, 'external_id = ?', [common]);
    const validIds = await cloneLookupPasses(valid.id, 'valid', 'Shadow Zulu ', 10);
    const invalid: string[] = [shadow.id, ...quarantined];
    const mutations = [
      { set: 'deleted_at = 1' },
      { set: 'removed_at = 1' },
      { set: "status = 'voided'" },
      { json: '{"voided":true}' },
      { json: '{"expirationDate":"2000-01-01T00:00:00Z"}' },
      { json: '{"expirationDate":"not-a-date"}' },
      { json: '{invalid' },
      { json: '[]' },
      { json: 'null' },
    ];
    for (const [index, mutation] of mutations.entries()) {
      const pass = await kit.scanPass(templateId, { memberName: `Shadow Beta ${index}` });
      invalid.push(pass.id);
      await setPass(kit, pass.id, 'display_title = ?, external_id = ?', [
        `Shadow Beta ${index}`,
        common,
      ]);
      if (mutation.set) await setPass(kit, pass.id, mutation.set, []);
      if (mutation.json)
        await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
          mutation.json,
          pass.id,
        ]);
    }
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const result = await search(common, scanner.headers);
    expect(result.items).toHaveLength(10);
    expect(result.more).toBe(true);
    const allowed = new Set([valid.id, ...validIds]);
    for (const item of result.items) expect(allowed.has(item.passId)).toBe(true);
    for (const id of [shadow.id, ...invalid.slice(55)])
      expect(await search(id, scanner.headers)).toEqual({ items: [], more: false });
    expect((await search(valid.id, scanner.headers)).items.map((row) => row.passId)).toEqual([
      valid.id,
    ]);
  }, 60_000);

  it('includes a valid expiry at the current instant but excludes an expired Wallet pass', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    for (const [offset, expected] of [
      [-1_000, false],
      [0, true],
      [1_000, true],
    ] as const) {
      const pass = await kit.scanPass(templateId);
      const expiry = new Date(kit.clock.now() + offset).toISOString();
      await run(
        kit.env.DB,
        "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
        [expiry, pass.id],
      );
      const result = await search(pass.id, scanner.headers);
      expect(result.items.map((item) => item.passId)).toEqual(expected ? [pass.id] : []);
      expect(result.more).toBe(false);
    }
  });

  it('applies event input and template scope to direct identifier matches', async () => {
    const template = await kit.scanTemplate('Event lookup', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    const otherTemplate = await kit.scanTemplate('Unassigned event lookup', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    const eligible = await kit.scanPass(template, { memberName: 'Gold Person', tier: 'gold' });
    const wrongInput = await kit.scanPass(template, {
      memberName: 'Silver Person',
      tier: 'silver',
    });
    const wrongTemplate = await kit.scanPass(otherTemplate, {
      memberName: 'Other Person',
      tier: 'gold',
    });
    for (const pass of [eligible, wrongInput, wrongTemplate])
      await setPass(kit, pass.id, 'external_id = ?', ['shared-event-key']);
    const event = await kit.event({ templateIds: [template] });
    await run(kit.env.DB, 'UPDATE scan_events SET match_input = ?, match_values = ? WHERE id = ?', [
      'tier',
      '["gold"]',
      event.id,
    ]);
    const scanner = await kit.scanner({ eventId: event.id });
    expect(
      (await search('shared-event-key', scanner.headers)).items.map((row) => row.passId),
    ).toEqual([eligible.id]);
    for (const pass of [wrongInput, wrongTemplate])
      expect(await search(pass.id, scanner.headers)).toEqual({ items: [], more: false });
  });

  it('only supplies member photo grants to roles allowed by the template and scanner', async () => {
    const template = await kit.scanTemplate('Desk photo lookup', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, header: {}, photo: { minRole: 'desk' } },
    });
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png: btoa(String.fromCharCode(...makePng(270, 270))), includeInPass: false },
      null,
    );
    const door = await kit.scanner({ templateIds: [template] });
    const desk = await kit.scanner({
      templateIds: [template],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const disabled = await kit.scanner({
      templateIds: [template],
      settings: { roleWithoutSignIn: 'desk', showPhoto: false },
    });
    expect((await search(pass.id, door.headers)).items[0]?.photoUrl).toBeNull();
    expect((await search(pass.id, disabled.headers)).items[0]?.photoUrl).toBeNull();
    const url = (await search(pass.id, desk.headers)).items[0]?.photoUrl;
    expect(url).toContain(`/passes/${pass.id}/assets/member.png?g=`);
    const path = (url ?? '').replace('/api/v1/scan', '');
    expect((await kit.get(desk.headers, path)).status).toBe(200);
    expect((await kit.get(door.headers, path)).status).toBe(404);
  });
});
