import { beforeEach, describe, expect, it } from 'vitest';
import { makeTemplate, persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import {
  createPreviewAuthorityFixture,
  type PreviewAuthorityFixture,
} from './routes-display-authority-split-fixture.ts';
import { startScanCredentialTransfer } from './test-kit.ts';

let fixture: PreviewAuthorityFixture;

beforeEach(async () => {
  fixture = await createPreviewAuthorityFixture();
});

describe('scan display preview tenant authorization', () => {
  it('still returns a scope after a template revision changes and changes back', async () => {
    const { f, org, own, clock, memberSession, atPreviewAudit, preview } = fixture;
    const session = await memberSession(['pass_operator']);
    const next = makeTemplate({ id: own.templateId, orgId: org.id, version: 'v2' });
    await persistTemplate(f, next.resolved, { registry: next.registry });
    const response = await atPreviewAudit(
      async (db) => {
        await run(
          db,
          "UPDATE templates SET active_version = 'v2', updated_at = MAX(updated_at + 1, ?) WHERE id = ?",
          [clock.now(), own.templateId],
        );
        await run(
          db,
          "UPDATE templates SET active_version = 'v1', updated_at = MAX(updated_at + 1, ?) WHERE id = ?",
          [clock.now(), own.templateId],
        );
      },
      () => preview(own, session.headers),
    );
    // A template revision (even A-B-A) is content, not authority: the preview is still served.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('scope');
  });

  it('masks a preview when the current template policy becomes unavailable during audit', async () => {
    const { f, org, own, memberSession, atPreviewAudit, preview, problem, previewAudits } = fixture;
    const session = await memberSession(['pass_operator']);
    const response = await atPreviewAudit(
      async (db) => {
        await run(
          db,
          "UPDATE templates SET status = 'archived', updated_at = updated_at + 1 WHERE id = ?",
          [own.templateId],
        );
      },
      () => preview(own, session.headers),
    );
    const unknown = await preview({ ...own, passId: f.ids.id() }, session.headers);
    expect(response.status).toBe(404);
    expect(await problem(response)).toEqual(await problem(unknown));
    expect(await previewAudits(session.userId)).toEqual([
      { org_id: org.id, target_id: own.passId },
    ]);
  });

  it('does not return a scope after its check-in policy changes during audit', async () => {
    const { clock, org, own, memberSession, atPreviewAudit, preview } = fixture;
    const session = await memberSession(['pass_operator']);
    const response = await atPreviewAudit(
      async (db) => {
        await run(
          db,
          `INSERT INTO pass_check_in(pass_id, org_id, rules, updated_at)
          VALUES (?, ?, '{"mode":"single"}', ?)
          ON CONFLICT(pass_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`,
          [own.passId, org.id, clock.now()],
        );
      },
      () => preview(own, session.headers),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Alex Morgan');
  });

  it('fences same-version release supersession even if legacy version and timestamp match', async () => {
    const { env, org, own, ownReleaseFixture, memberSession, atPreviewAudit, preview } = fixture;
    const session = await memberSession(['pass_operator']);
    const original = await first<{ updated_at: number }>(
      env.DB,
      'SELECT updated_at FROM templates WHERE id = ?',
      [own.templateId],
    );
    if (!original) throw new Error('Expected the preview template');
    const response = await atPreviewAudit(
      async (db) => {
        await approveAppleRelease(ownReleaseFixture, {
          orgId: org.id,
          templateId: own.templateId,
          version: 'v1',
          mode: 'live',
          db,
        });
        // Simulate an ABA timestamp so only the captured release identity can reject it.
        await run(db, 'UPDATE templates SET updated_at = ? WHERE id = ?', [
          original.updated_at,
          own.templateId,
        ]);
      },
      () => preview(own, session.headers),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('scope');
  });

  it.each([
    [
      'voided Wallet',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
    ],
    ['invalid Wallet', "UPDATE pass_versions SET pass_json = '{' WHERE pass_id = ?"],
    [
      'changed valid Wallet',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.organizationName', 'Changed') WHERE pass_id = ?",
    ],
    [
      'different Wallet bytes',
      "UPDATE pass_versions SET pass_json = ' ' || pass_json WHERE pass_id = ?",
    ],
    [
      'changed Wallet personalization',
      'UPDATE pass_versions SET personalization = \'{"memberName":"Earlier"}\' WHERE pass_id = ?',
    ],
    [
      'changed Wallet template version',
      "UPDATE pass_versions SET template_version = 'earlier' WHERE pass_id = ?",
    ],
    [
      'changed signing identity revision',
      'UPDATE signing_identities SET nfc_enabled = CASE WHEN nfc_enabled = 1 THEN 0 ELSE 1 END WHERE id = (SELECT identity_id FROM passes WHERE id = ?)',
    ],
    [
      'changed personalization',
      'UPDATE passes SET personalization = \'{"memberName":"Changed"}\' WHERE id = ?',
    ],
    [
      'changed source provenance',
      'UPDATE passes SET field_sources = \'{"memberName":"connection"}\' WHERE id = ?',
    ],
    [
      'changed lifecycle generation',
      'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
    ],
    [
      'changed link generation',
      'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?',
    ],
    ['quarantined pass', 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?'],
    ['removed pass', 'UPDATE passes SET removed_at = 1 WHERE id = ?'],
  ])('does not return a captured scope after %s changes during audit', async (_change, sql) => {
    const { own, memberSession, atPreviewAudit, preview } = fixture;
    const session = await memberSession(['pass_operator']);
    const response = await atPreviewAudit(
      async (db) => {
        await run(db, sql, [own.passId]);
      },
      () => preview(own, session.headers),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Alex Morgan');
  });

  it('does not return a captured scope after a real credential transfer during audit', async () => {
    const { env, own, ownReleaseFixture, memberSession, atPreviewAudit, preview } = fixture;
    const session = await memberSession(['pass_operator']);
    const before = await first<{ credential_generation: number }>(
      env.DB,
      'SELECT credential_generation FROM passes WHERE id = ?',
      [own.passId],
    );
    if (!before) throw new Error('Missing pass generation');
    const response = await atPreviewAudit(
      async (db) => {
        await startScanCredentialTransfer(ownReleaseFixture, own.passId, { db });
      },
      () => preview(own, session.headers),
    );
    const after = await first<{ credential_generation: number }>(
      env.DB,
      'SELECT credential_generation FROM passes WHERE id = ?',
      [own.passId],
    );
    expect(after?.credential_generation).toBe(before.credential_generation + 1);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Alex Morgan');
  });

  it('fences the exact bounded Wallet row even when a newer row has identical contents', async () => {
    const { env, own, memberSession, atPreviewAudit, preview } = fixture;
    const session = await memberSession(['pass_operator']);
    await run(env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [own.passId]);
    const response = await atPreviewAudit(
      async (db) => {
        await run(
          db,
          `INSERT INTO pass_versions
          (pass_id, version, object_key, object_sha256, template_version, personalization, pass_json,
           cause, actor_type, actor_id, created_at, purged_at)
          SELECT pass_id, 2, object_key, object_sha256, template_version, personalization, pass_json,
            cause, actor_type, actor_id, created_at, purged_at
          FROM pass_versions WHERE pass_id = ? AND version = 1`,
          [own.passId],
        );
      },
      () => preview(own, session.headers),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Alex Morgan');
  });

  it('fences signing identity revision across an ABA change during audit', async () => {
    const { env, own, memberSession, atPreviewAudit, preview } = fixture;
    const session = await memberSession(['pass_operator']);
    const identity = await first<{ id: string; team_identifier: string }>(
      env.DB,
      `SELECT si.id, si.team_identifier FROM passes p
       JOIN signing_identities si ON si.id = p.identity_id WHERE p.id = ?`,
      [own.passId],
    );
    if (!identity) throw new Error('Missing pass signing identity');
    const response = await atPreviewAudit(
      async (db) => {
        await run(db, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
          `${identity.team_identifier}-changed`,
          identity.id,
        ]);
        await run(db, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
          identity.team_identifier,
          identity.id,
        ]);
      },
      () => preview(own, session.headers),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Alex Morgan');
  });

  it.each([
    [
      'voided Wallet',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
    ],
    ['invalid Wallet', "UPDATE pass_versions SET pass_json = '{' WHERE pass_id = ?"],
    ['missing Wallet', 'DELETE FROM pass_versions WHERE pass_id = ?'],
    ['null Wallet', 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?'],
    [
      'wrong Wallet serial',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.serialNumber', 'foreign') WHERE pass_id = ?",
    ],
    [
      'wrong Wallet team',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.teamIdentifier', 'foreign') WHERE pass_id = ?",
    ],
    [
      'expired Wallet',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', '2001-01-01T00:00:00Z') WHERE pass_id = ?",
    ],
    [
      'malformed Wallet expiration',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', 'tomorrow') WHERE pass_id = ?",
    ],
    ['removed pass', 'UPDATE passes SET removed_at = 1 WHERE id = ?'],
    ['quarantined pass', 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?'],
  ])('rejects a %s before preview', async (_change, sql) => {
    const { env, own, memberSession, preview, previewAudits } = fixture;
    const session = await memberSession(['pass_operator']);
    await run(env.DB, sql, [own.passId]);
    const response = await preview(own, session.headers);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Alex Morgan');
    expect(await previewAudits(session.userId)).toEqual([]);
  });

  it.each(['before preview', 'during audit'] as const)(
    'does not disclose a scope when credential transfer starts %s',
    async (timing) => {
      const {
        env,
        org,
        own,
        memberSession,
        atPreviewAudit,
        startTransfer,
        preview,
        previewAudits,
      } = fixture;
      const session = await memberSession(['pass_operator']);
      if (timing === 'before preview') await startTransfer(env.DB, own.passId);
      const response =
        timing === 'before preview'
          ? await preview(own, session.headers)
          : await atPreviewAudit(
              (db) => startTransfer(db, own.passId),
              () => preview(own, session.headers),
            );
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Alex Morgan');
      const transfer = await first<{
        state: string;
        target_generation: number;
        credential_generation: number;
      }>(
        env.DB,
        `SELECT t.state, t.target_generation, p.credential_generation
         FROM pass_credential_transfers t JOIN passes p ON p.id = t.pass_id
         WHERE t.pass_id = ?`,
        [own.passId],
      );
      expect(transfer?.state).toBe('pending');
      expect(transfer?.credential_generation).toBe(transfer?.target_generation);
      expect(await previewAudits(session.userId)).toEqual(
        timing === 'before preview' ? [] : [{ org_id: org.id, target_id: own.passId }],
      );
    },
  );
});
