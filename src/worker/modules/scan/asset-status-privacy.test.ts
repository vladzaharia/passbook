import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { genericAssetGrantFor, photoAssetGrantFor } from './asset-test-fixtures.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
const photo = makePng(270, 270);
const system = { type: 'system' as const, id: null };
const names = ['icon.png', 'member.png', 'thumbnail@3x.png'] as const;

beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Asset pass status', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

describe('scanner asset pass status', () => {
  it.each([
    {
      state: 'voided status',
      mode: 'live' as const,
      deactivate: (id: string) =>
        run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [id]),
    },
    {
      state: 'voided Wallet pass',
      mode: 'live' as const,
      deactivate: (id: string) =>
        run(
          kit.env.DB,
          "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
          [id],
        ),
    },
    {
      state: 'removed',
      mode: 'live' as const,
      deactivate: (id: string) =>
        run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [kit.clock.now(), id]),
    },
    {
      state: 'soft-deleted',
      mode: 'live' as const,
      deactivate: (id: string) =>
        run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [kit.clock.now(), id]),
    },
    {
      state: 'quarantined test data',
      mode: 'test' as const,
      deactivate: (id: string) =>
        run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [id]),
    },
    {
      state: 'expired Wallet pass',
      mode: 'live' as const,
      deactivate: (id: string) =>
        run(
          kit.env.DB,
          "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
          [new Date(kit.clock.now() - 60_000).toISOString(), id],
        ),
    },
  ])(
    'revokes generic and photo assets after a pass becomes $state',
    async ({ mode, deactivate }) => {
      const scanner = await kit.scanner({ templateIds: [template], mode });
      const pass = await kit.scanPass(template, {}, { mode });
      await putMemberPhoto(
        jobCtxOf(kit),
        system,
        pass.id,
        {
          png: btoa(String.fromCharCode(...photo)),
          includeInPass: true,
        },
        null,
      );
      const genericGrant = await genericAssetGrantFor(kit, scanner, pass.id);
      const photoGrant = await photoAssetGrantFor(kit, scanner, pass.id);
      const asset = (name: string) =>
        kit.get(
          scanner.headers,
          `/passes/${pass.id}/assets/${name}?g=${name === 'icon.png' ? genericGrant : photoGrant}`,
        );
      for (const name of names) {
        const response = await asset(name);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        if (name !== 'icon.png')
          expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          name === 'icon.png' ? ICON_PNG : photo,
        );
      }
      await deactivate(pass.id);
      for (const name of names) {
        const response = await asset(name);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
      }
    },
  );
});
