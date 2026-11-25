import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { presetValues } from '../../../shared/contracts/entitlements.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { applyKit } from '../channels/apply-test-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setPreset } from './presets-service.ts';

const OLD = ['csv-url', 'webhook-push/*'];
const NEW = ['csv-url', 'webhook-push/*', 'file-upload', 'demo'];

describe('0212 connector presets', () => {
  it('moves aligned trial and starter orgs, leaves the rest, and the next edit still works', async () => {
    const t = await applyKit(1);
    const db = t.kit.env.DB;
    const sql = (
      env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }
    ).TEST_MIGRATIONS.find((m) => m.name === '0212_connector_presets.sql')?.queries;
    expect(sql?.length).toBe(4);

    // The presets as they stood before: the old list, revision 3, no record of an earlier edit.
    for (const preset of ['trial', 'starter'])
      await run(
        db,
        "UPDATE entitlement_presets SET value = ? WHERE preset = ? AND key = 'connectors'",
        [JSON.stringify(OLD), preset],
      );
    await run(
      db,
      "UPDATE entitlement_preset_meta SET revision = 3, previous_values = NULL, updated_at = 5, updated_by = 'someone' WHERE preset IN ('trial', 'starter')",
    );
    const before = Object.fromEntries(
      await Promise.all(
        ['trial', 'starter', 'standard', 'legacy'].map(async (p) => [
          p,
          Object.fromEntries(
            (
              await all<{ key: string; value: string }>(
                db,
                'SELECT key, value FROM entitlement_presets WHERE preset = ?',
                [p],
              )
            ).map((r) => [r.key, JSON.parse(r.value)]),
          ),
        ]),
      ),
    );

    const orgs: [string, string, number][] = [
      ['m-trial', 'trial', 3],
      ['m-trial-pending', 'trial', 2],
      ['m-starter', 'starter', 3],
      ['m-standard', 'standard', 1],
      ['m-legacy', 'legacy', 1],
    ];
    for (const [id, preset, at] of orgs) {
      await run(
        db,
        'INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
        [id, id, id],
      );
      await run(
        db,
        'INSERT INTO org_entitlements (org_id, preset, preset_revision, updated_at) VALUES (?, ?, ?, 1)',
        [id, preset, at],
      );
    }
    const overrides: [string, string[]][] = [
      ['m-trial', [...OLD, 'extra/x']],
      ['m-starter', ['csv-url']],
      ['m-trial-pending', [...OLD, 'demo']],
      ['m-standard', [...OLD, 'extra/x']],
      ['m-legacy', ['*']],
    ];
    for (const [id, list] of overrides)
      await run(
        db,
        "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at, updated_by) VALUES (?, 'connectors', ?, 1, 'u')",
        [id, JSON.stringify(list)],
      );

    for (const q of sql ?? []) await run(db, q);

    const preset = async (p: string) =>
      JSON.parse(
        (
          await first<{ value: string }>(
            db,
            "SELECT value FROM entitlement_presets WHERE preset = ? AND key = 'connectors'",
            [p],
          )
        )?.value ?? 'null',
      );
    expect(await preset('trial')).toEqual(NEW);
    expect(await preset('starter')).toEqual(NEW);
    expect(await preset('standard')).toEqual(['*']);
    expect(await preset('legacy')).toEqual(['*']);
    expect(await preset('developer')).toEqual([]);
    // Everything but the connectors row is as it was.
    for (const p of ['trial', 'starter', 'standard', 'legacy']) {
      const now = Object.fromEntries(
        (
          await all<{ key: string; value: string }>(
            db,
            'SELECT key, value FROM entitlement_presets WHERE preset = ?',
            [p],
          )
        ).map((r) => [r.key, JSON.parse(r.value)]),
      );
      expect({ ...now, connectors: null }).toEqual({ ...before[p], connectors: null });
    }
    // The registry is the source of truth.
    expect(presetValues('trial').connectors).toEqual(NEW);

    const meta = await all<{
      preset: string;
      revision: number;
      previous_values: string | null;
      updated_by: string | null;
    }>(
      db,
      "SELECT preset, revision, previous_values, updated_by FROM entitlement_preset_meta WHERE preset IN ('trial', 'starter', 'standard', 'legacy') ORDER BY preset",
    );
    const byPreset = Object.fromEntries(meta.map((m) => [m.preset, m]));
    for (const p of ['trial', 'starter']) {
      expect(byPreset[p]?.revision).toBe(4);
      expect(byPreset[p]?.updated_by).toBeNull();
      expect(JSON.parse(byPreset[p]?.previous_values ?? 'null')).toEqual({
        ...before[p],
        connectors: OLD,
      });
    }
    expect(byPreset.standard?.previous_values).toBeNull();
    expect(byPreset.standard?.revision).not.toBe(4);
    expect(byPreset.legacy?.previous_values).toBeNull();

    const orgRows = Object.fromEntries(
      (
        await all<{ org_id: string; revision: number; preset_revision: number }>(
          db,
          "SELECT org_id, revision, preset_revision FROM org_entitlements WHERE org_id LIKE 'm-%'",
        )
      ).map((r) => [r.org_id, r]),
    );
    expect(orgRows['m-trial']).toMatchObject({ revision: 2, preset_revision: 4 });
    expect(orgRows['m-starter']).toMatchObject({ revision: 2, preset_revision: 4 });
    // Waiting on an earlier edit: untouched, and a gap org on its next move.
    expect(orgRows['m-trial-pending']).toMatchObject({ revision: 1, preset_revision: 2 });
    expect(orgRows['m-standard']).toMatchObject({ revision: 1, preset_revision: 1 });
    expect(orgRows['m-legacy']).toMatchObject({ revision: 1, preset_revision: 1 });

    const ov = Object.fromEntries(
      (
        await all<{ org_id: string; value: string; updated_by: string | null; updated_at: number }>(
          db,
          "SELECT org_id, value, updated_by, updated_at FROM org_entitlement_overrides WHERE org_id LIKE 'm-%' AND key = 'connectors'",
        )
      ).map((r) => [r.org_id, r]),
    );
    // A superset gains both items; a subset, a `*` and other presets' overrides stay.
    expect(JSON.parse(ov['m-trial']?.value ?? '')).toEqual([
      ...OLD,
      'extra/x',
      'file-upload',
      'demo',
    ]);
    expect(ov['m-trial']?.updated_by).toBeNull();
    expect(ov['m-trial']?.updated_at).toBe(1795478400000);
    expect(JSON.parse(ov['m-trial-pending']?.value ?? '')).toEqual([...OLD, 'demo', 'file-upload']);
    expect(JSON.parse(ov['m-starter']?.value ?? '')).toEqual(['csv-url']);
    expect(JSON.parse(ov['m-standard']?.value ?? '')).toEqual([...OLD, 'extra/x']);
    expect(JSON.parse(ov['m-legacy']?.value ?? '')).toEqual(['*']);

    // Running it again changes nothing.
    for (const q of sql ?? []) await run(db, q);
    expect(await preset('trial')).toEqual(NEW);
    expect(
      (
        await first<{ revision: number }>(
          db,
          "SELECT revision FROM entitlement_preset_meta WHERE preset = 'trial'",
        )
      )?.revision,
    ).toBe(4);

    // A later edit of the preset goes through.
    const user = await makeUser(t.kit.fx);
    const s = await makeSession(t.kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const session = await createSessionStore(t.kit.env, t.kit.clock).resolve(s.cookieValue);
    if (!session) throw new Error('Session fixture missing');
    const out = await setPreset(
      jobCtxOf(t.kit),
      { type: 'user', id: user.id },
      { userId: user.id, sessionId: session.sessionId },
      { preset: 'starter', expectedRevision: 4, values: { 'wallet.google': 0 } },
      50,
    );
    expect(out.preset.revision).toBe(5);
    expect(out.moved).toBeGreaterThanOrEqual(1);
  });
});
