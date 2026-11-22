import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser, withoutTrigger } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { PREVIEW_PASS_IDENTITY } from '../../../shared/copy/developer.ts';
import { run } from '../../platform/db.ts';
import { setupTillKit } from './guard-api-key-test-fixtures.ts';
import type { ScanKit } from './test-kit.ts';

let t: Awaited<ReturnType<typeof setupTillKit>>;
let kit: ScanKit;
beforeAll(async () => {
  t = await setupTillKit();
  kit = t.kit;
});

const setIdentity = (passId: string, passType: string, team: string) =>
  run(
    kit.env.DB,
    `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.passTypeIdentifier', ?, '$.teamIdentifier', ?)
     WHERE pass_id = ?`,
    [passType, team, passId],
  );
const kindOf = async (headers: Record<string, string>, passId: string) =>
  ScanOutcomeSchema.parse(await (await t.call(headers, '/resolve', t.read(passId))).json());

describe('the wallet identity a scanner expects', () => {
  it('is the preview identity for a sandbox org only', async () => {
    const till = await t.till();
    const pass = await kit.scanPass(t.templateId);
    const { passTypeIdentifier, teamIdentifier } = PREVIEW_PASS_IDENTITY;

    // An ordinary org's pass that carries the preview identity is refused.
    await setIdentity(pass.id, passTypeIdentifier, teamIdentifier);
    expect((await kindOf(till.headers, pass.id)).reason).toBe('not_found');

    // The same org as a sandbox: the preview identity matches, the stored platform one no longer does.
    const userId = (await makeUser(kit.fx)).id;
    await withoutTrigger(kit.env.DB, 'developer_sandboxes_org_is_developer', () =>
      run(
        kit.env.DB,
        'INSERT INTO developer_sandboxes (id, org_id, user_id, created_at) VALUES (?, ?, ?, 1)',
        [kit.fx.ids.id(), kit.org.id, userId],
      ),
    );
    expect((await kindOf(till.headers, pass.id)).reason).not.toBe('not_found');
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json = (
         SELECT json_set(pass_versions.pass_json, '$.passTypeIdentifier', si.pass_type_identifier,
           '$.teamIdentifier', si.team_identifier)
         FROM passes p JOIN signing_identities si ON si.id = p.identity_id WHERE p.id = pass_versions.pass_id)
       WHERE pass_id = ?`,
      [pass.id],
    );
    expect((await kindOf(till.headers, pass.id)).reason).toBe('not_found');
  });
});
