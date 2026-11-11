import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { countExpected, expectedCount } from './repo-counts.ts';
import { getConsoleEvent } from './repo-events.ts';
import { approveScanReleases, type ScanKit, setupScanKit } from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
let kit: ScanKit;
let credentialKeysetCommitment: string;

beforeEach(async () => {
  kit = await setupScanKit();
  credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

describe('expected count release eligibility', () => {
  it('counts the same version and compatible head promotions, but excludes incompatible builds', async () => {
    const templateId = await kit.scanTemplate(
      'Count builds',
      { actions: [CHECK_IN] },
      { releaseModes: ['live'] },
    );
    const original = await kit.registry.resolve(templateId);
    async function stage(version: string, buildKey: string) {
      const template = kit.registry.add({
        id: templateId,
        orgId: kit.org.id,
        version,
        manifest: original.manifest,
        passJson: original.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await run(
        kit.env.DB,
        `INSERT INTO template_versions
        (template_id,version,manifest,pass_json,assets,report,created_by,created_at,build_key)
        SELECT template_id,?,manifest,pass_json,assets,report,created_by,created_at,?
        FROM template_versions WHERE template_id=? AND version=?`,
        [version, buildKey, templateId, original.version],
      );
      return template;
    }
    const pinned = await stage('v2', 'same-build');
    await approveScanReleases(kit, templateId, { modes: ['live'], version: pinned.version });
    await kit.scanPass(templateId);
    const event = await kit.event({ templateIds: [templateId] });
    const row = await getConsoleEvent(kit.env.DB, event.id, credentialKeysetCommitment);
    if (!row) throw new Error('Missing event.');
    const actorEvent = {
      orgId: kit.org.id,
      mode: 'live' as const,
      matchInput: null,
      matchValues: null,
    };
    const counts = async () => [
      await expectedCount(kit.env.DB, actorEvent, [templateId], kit.clock.now()),
      await countExpected(kit.env.DB, row, kit.clock.now()),
    ];
    expect(await counts()).toEqual([1, 1]);
    await stage('v3', 'same-build');
    await approveScanReleases(kit, templateId, { modes: ['live'], version: 'v3' });
    expect(await counts()).toEqual([1, 1]);
    await stage('v4', 'different-build');
    await approveScanReleases(kit, templateId, { modes: ['live'], version: 'v4' });
    expect(await counts()).toEqual([0, 0]);
  });

  it.each([
    'newer-null',
    'malformed',
    'array',
    'serial',
    'pass-type',
    'team',
    'voided',
    'void-null',
    'expired',
    'expiry-invalid',
    'expiry-null',
  ] as const)('excludes a pass with %s current Wallet JSON', async (change) => {
    const templateId = await kit.scanTemplate(
      'Count wallet',
      { actions: [CHECK_IN] },
      { releaseModes: ['live'] },
    );
    const pass = await kit.scanPass(templateId);
    const event = await kit.event({ templateIds: [templateId] });
    const row = await getConsoleEvent(kit.env.DB, event.id, credentialKeysetCommitment);
    if (!row) throw new Error('Missing event.');
    const actorEvent = {
      orgId: kit.org.id,
      mode: 'live' as const,
      matchInput: null,
      matchValues: null,
    };
    const counts = async () => [
      await expectedCount(kit.env.DB, actorEvent, [templateId], kit.clock.now()),
      await countExpected(kit.env.DB, row, kit.clock.now()),
    ];
    expect(await counts()).toEqual([1, 1]);
    if (change === 'newer-null') {
      await run(
        kit.env.DB,
        `INSERT INTO pass_versions
        (pass_id,version,template_version,personalization,pass_json,cause,created_at)
        SELECT pass_id,version+1,template_version,personalization,NULL,cause,created_at
        FROM pass_versions WHERE pass_id=? AND version=?`,
        [pass.id, pass.version],
      );
      await run(kit.env.DB, 'UPDATE passes SET version=version+1 WHERE id=?', [pass.id]);
    } else if (change === 'malformed' || change === 'array') {
      await run(kit.env.DB, 'UPDATE pass_versions SET pass_json=? WHERE pass_id=?', [
        change === 'malformed' ? '{' : '[]',
        pass.id,
      ]);
    } else {
      const field =
        change === 'serial'
          ? 'serialNumber'
          : change === 'pass-type'
            ? 'passTypeIdentifier'
            : change === 'team'
              ? 'teamIdentifier'
              : change.startsWith('void')
                ? 'voided'
                : 'expirationDate';
      const value =
        change === 'voided'
          ? true
          : change === 'void-null' || change === 'expiry-null'
            ? null
            : change === 'expired'
              ? new Date(kit.clock.now() - 1_000).toISOString()
              : 'wrong';
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json=json_set(pass_json,?,json(?)) WHERE pass_id=?',
        [`$.${field}`, JSON.stringify(value), pass.id],
      );
    }
    expect(await counts()).toEqual([0, 0]);
  });

  it('ignores future snapshot versions and keeps an unexpired current Wallet snapshot countable', async () => {
    const templateId = await kit.scanTemplate(
      'Bounded wallet',
      { actions: [CHECK_IN] },
      { releaseModes: ['live'] },
    );
    const pass = await kit.scanPass(templateId);
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=?`,
      [new Date(kit.clock.now() + 60_000).toISOString(), pass.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO pass_versions
      (pass_id,version,template_version,personalization,pass_json,cause,created_at)
      SELECT pass_id,version+1,template_version,personalization,NULL,cause,created_at
      FROM pass_versions WHERE pass_id=? AND version=?`,
      [pass.id, pass.version],
    );
    const event = await kit.event({ templateIds: [templateId] });
    const row = await getConsoleEvent(kit.env.DB, event.id, credentialKeysetCommitment);
    if (!row) throw new Error('Missing event.');
    expect(await countExpected(kit.env.DB, row, kit.clock.now())).toBe(1);
    expect(
      await expectedCount(
        kit.env.DB,
        {
          orgId: kit.org.id,
          mode: 'live',
          matchInput: null,
          matchValues: null,
        },
        [templateId],
        kit.clock.now(),
      ),
    ).toBe(1);
    kit.clock.advance(61_000);
    expect(await countExpected(kit.env.DB, row, kit.clock.now())).toBe(0);
    expect(
      await expectedCount(
        kit.env.DB,
        {
          orgId: kit.org.id,
          mode: 'live',
          matchInput: null,
          matchValues: null,
        },
        [templateId],
        kit.clock.now(),
      ),
    ).toBe(0);
  });
});
