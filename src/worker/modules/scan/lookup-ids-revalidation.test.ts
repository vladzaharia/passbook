import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import {
  afterLookupRead,
  kit,
  search,
  setupLookupIdsFixture,
  templateId,
} from './repo-lookup-ids-test-fixtures.ts';
import { setPass } from './test-kit.ts';

beforeEach(setupLookupIdsFixture);

describe('lookup privacy', () => {
  it('drops a photo removed after the pass candidate was read', async () => {
    const template = await kit.scanTemplate('Revocable photo lookup', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, header: {}, photo: { minRole: 'door' } },
    });
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png: btoa(String.fromCharCode(...makePng(270, 270))), includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template] });
    const real = kit.env.DB;
    const race = afterLookupRead(real, pass.id, async () => {
      await run(real, 'DELETE FROM member_photos WHERE pass_id = ?', [pass.id]);
    });
    Object.assign(kit.env, { DB: race.db });
    try {
      expect((await search(pass.id, scanner.headers)).items).toMatchObject([
        { passId: pass.id, photoUrl: null },
      ]);
      expect(race.state.fired).toBe(true);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  for (const column of [
    'external_id',
    'holder_email',
    'serial',
    'scan_code',
    'barcode_hash',
    'lookup_hash',
  ] as const) {
    it(`does not accept a ${column} revoked after the search query`, async () => {
      const memberNo = 'retired-member-number-875';
      const email = 'retired-holder@example.test';
      const externalId = 'retired-external-id-875';
      const transfer = column === 'holder_email' || column === 'serial' || column === 'scan_code';
      // A transfer needs rotating credentials; the fixture template's barcode and lookup are static.
      const template = transfer
        ? await kit.scanTemplate('Transferable lookup', {
            actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
          })
        : templateId;
      const pass = await kit.scanPass(
        template,
        { memberName: 'Race Public', memberNo },
        { holderEmail: email },
      );
      await setPass(kit, pass.id, 'external_id = ?', [externalId]);
      const scanner = await kit.scanner({ templateIds: [template] });
      const query = {
        external_id: externalId,
        holder_email: email,
        serial: pass.serial,
        scan_code: pass.scanCode!,
        barcode_hash: 'opaque:qr:payload',
        lookup_hash: memberNo,
      }[column];
      expect((await search(query, scanner.headers)).items.map((item) => item.passId)).toEqual([
        pass.id,
      ]);
      const real = kit.env.DB;
      const expected = await getHolderPass(real, pass.id, null);
      if (!expected) throw new Error('Missing transfer source');
      const race = afterLookupRead(
        real,
        pass.id,
        async () => {
          if (transfer) {
            await startCredentialTransfer(
              jobCtxOf(kit),
              { type: 'system', id: null },
              pass.id,
              { holderEmail: 'replacement@example.test', ownerUserId: null },
              null,
              { kind: 'tenant-holder', expected },
            );
          } else {
            await run(
              real,
              `UPDATE passes SET ${column} = NULL, revision=revision+1 WHERE id = ?`,
              [pass.id],
            );
          }
        },
        'matches',
      );
      Object.assign(kit.env, { DB: race.db });
      try {
        expect(await search(query, scanner.headers)).toEqual({ items: [], more: false });
        expect(race.state.fired).toBe(true);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    });
  }

  for (const invalidate of ['pass', 'scanner'] as const) {
    it(`revalidates ${invalidate} authority after loading a lookup candidate`, async () => {
      const pass = await kit.scanPass(templateId, { memberName: 'Race Protected' });
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const real = kit.env.DB;
      const race = afterLookupRead(real, pass.id, async () => {
        if (invalidate === 'pass')
          await run(real, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
        else
          await run(real, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            scanner.id,
          ]);
      });
      Object.assign(kit.env, { DB: race.db });
      try {
        const response = await kit.post(scanner.headers, '/lookup', { q: pass.id });
        expect([200, 403]).toContain(response.status);
        const text = await response.text();
        expect(text).not.toContain(pass.id);
        expect(text).not.toContain('Race Protected');
        if (response.status === 200) expect(JSON.parse(text)).toEqual({ items: [], more: false });
        expect(race.state.fired).toBe(true);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    });
  }
});
