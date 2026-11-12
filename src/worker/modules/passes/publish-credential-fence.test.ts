import { beforeAll, describe, expect, it, vi } from 'vitest';
import { crc32 } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { batch, first, run, stmt } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { applyConnectionRecord } from './connection-passes.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { overrideDeps } from './deps.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { type Pass, setBinding } from './repo.ts';
import { getPass } from './repo-read-pass.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const actor = { type: 'system', id: null } as const;

/** Reserve a generation using the real D1 transfer triggers; leave it pending. */
async function reserve(pass: Pass): Promise<void> {
  const db = kit.env.DB;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO pass_credential_transfers
      (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
       source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
       requested_by_type, requested_by_id, requested_at)
      SELECT ?, id, org_id, mode, 'pending', credential_generation, version, revision, row_version,
        lifecycle_generation, link_generation + 1, 'target@example.test', NULL, 'system', NULL, ?
      FROM passes WHERE id = ?`,
      [kit.fx.ids.id(), kit.clock.now(), pass.id],
    ),
    stmt(
      db,
      `UPDATE passes SET credential_generation = credential_generation + 1,
      link_generation = link_generation + 1, download_token = ? WHERE id = ?`,
      [kit.fx.ids.token(), pass.id],
    ),
  ]);
}

async function snapshot(id: string) {
  return first(
    kit.env.DB,
    `SELECT version, revision, credential_generation, lifecycle_generation,
    link_generation, personalization, field_sources, object_key, sync_error_code
    FROM passes WHERE id = ?`,
    [id],
  );
}

describe('publish credential transfer fences', () => {
  it('blocks unchanged, metadata-only, artifact and connection writes while a transfer is pending', async () => {
    const pass = await kit.pass();
    const connectionId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
      VALUES (?, ?, 'demo', 'pending publish', 1, 1, 1)`,
      [connectionId, pass.orgId],
    );
    await run(
      kit.env.DB,
      `UPDATE passes SET connection_id = ?, external_ref = 'ref', sync_error_code = 'OLD'
      WHERE id = ?`,
      [connectionId, pass.id],
    );
    await reserve(pass);
    const current = await getPass(kit.env.DB, pass.id);
    if (!current) throw new Error('Missing pending pass');
    const before = await snapshot(pass.id);
    const objects = await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` });
    const put = vi.spyOn(kit.env.BUCKET, 'put');
    try {
      for (const mutate of [
        () => ({}),
        () => ({ fieldSources: { memberName: 'connection' as const } }),
        () => ({
          personalization: { ...current.personalization, memberName: 'Private replacement' },
        }),
      ]) {
        await expect(
          publishPass(jobCtxOf(kit), { passId: pass.id, cause: 'admin', actor, mutate }),
        ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      }
      await expect(
        applyConnectionRecord(jobCtxOf(kit), {
          passId: pass.id,
          orgId: pass.orgId,
          mode: 'live',
          status: 'active',
          expectedVersion: current.version,
          ownerUserId: current.ownerUserId,
          linkGeneration: current.linkGeneration,
          connectionId,
          externalRef: 'ref',
          generation: 1,
          expectedConnectionMode: 'poll',
          identityId: current.identityId,
          credentialGeneration: current.credentialGeneration,
          lifecycleGeneration: current.lifecycleGeneration,
          credentialKeysetCommitment: await ensureCredentialRefKeyset(kit.env.DB, kit.env),
          transferPending: false,
          fields: { memberName: 'Private replacement' },
          cause: 'connection',
        }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(put).not.toHaveBeenCalled();
      expect(await snapshot(pass.id)).toEqual(before);
      expect(
        (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects
          .map((o) => o.key)
          .sort(),
      ).toEqual(objects.objects.map((o) => o.key).sort());
    } finally {
      put.mockRestore();
    }
  }, 60_000);

  it.each(['credential_generation', 'lifecycle_generation'] as const)(
    'rejects an in-flight %s change before writing an artifact',
    async (column) => {
      const pass = await kit.pass();
      const put = vi.spyOn(kit.env.BUCKET, 'put');
      let changed = false;
      overrideDeps(kit.env, {
        registry: {
          list: (q) => kit.registry.list(q),
          openAsset: (t, n) => kit.registry.openAsset(t, n),
          async resolve(id, version) {
            if (!changed) {
              changed = true;
              if (column === 'credential_generation') await reserve(pass);
              else
                await run(
                  kit.env.DB,
                  'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
                  [pass.id],
                );
            }
            return kit.registry.resolve(id, version);
          },
        },
      });
      try {
        await expect(
          publishPass(jobCtxOf(kit), {
            passId: pass.id,
            cause: 'admin',
            actor,
            mutate: (current) => ({
              personalization: { ...current.personalization, memberName: 'Raced' },
            }),
          }),
        ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
        expect(changed).toBe(true);
        expect(put).not.toHaveBeenCalled();
        expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
          version: pass.version,
          personalization: pass.personalization,
          objectKey: pass.objectKey,
        });
      } finally {
        put.mockRestore();
        overrideDeps(kit.env, { registry: kit.registry });
      }
    },
    60_000,
  );

  it('discards an artifact if a transfer reserves credentials after the pre-write check', async () => {
    const pass = await kit.pass();
    const put = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    let reserved = false;
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
      const object = await put(key, value, options);
      if (key.startsWith(`passes/${pass.id}/`) && !reserved) {
        reserved = true;
        await reserve(pass);
      }
      return object;
    });
    try {
      await expect(
        publishPass(jobCtxOf(kit), {
          passId: pass.id,
          cause: 'admin',
          actor,
          mutate: (current) => ({
            personalization: { ...current.personalization, memberName: 'Must not publish' },
          }),
        }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(reserved).toBe(true);
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        version: pass.version,
        credentialGeneration: pass.credentialGeneration + 1,
        personalization: pass.personalization,
        objectKey: pass.objectKey,
      });
      expect(
        (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects.map((o) => o.key),
      ).toEqual([pass.objectKey]);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('fences binding writes against lifecycle ABA and both stale and current pending snapshots', async () => {
    const pass = await kit.pass();
    const _credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const unbind = {
      connectionId: null,
      externalRef: null,
      generation: null,
      connectionMode: null,
      fieldSources: pass.fieldSources,
    };
    await reserve(pass);
    const pending = await getPass(kit.env.DB, pass.id);
    if (!pending) throw new Error('Missing pending pass');
    const before = await snapshot(pass.id);
    expect(await setBinding(jobCtxOf(kit), pass, unbind)).toBe(false);
    expect(await setBinding(jobCtxOf(kit), pending, unbind)).toBe(false);
    expect(await snapshot(pass.id)).toEqual(before);

    const lifecycle = await kit.pass();
    await run(
      kit.env.DB,
      'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [lifecycle.id],
    );
    const after = await snapshot(lifecycle.id);
    expect(
      await setBinding(jobCtxOf(kit), lifecycle, {
        connectionId: null,
        externalRef: null,
        generation: null,
        connectionMode: null,
        fieldSources: lifecycle.fieldSources,
      }),
    ).toBe(false);
    expect(await snapshot(lifecycle.id)).toEqual(after);
  }, 60_000);

  it('rejects binding when connection mode changes without a generation change', async () => {
    const pass = await kit.pass();
    const connectionId = kit.fx.ids.id();
    const _credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, mode, generation, created_at, updated_at)
      VALUES (?, ?, 'demo', 'mode race', 'poll', 1, 1, 1)`,
      [connectionId, pass.orgId],
    );
    await run(kit.env.DB, "UPDATE connections SET mode = 'hybrid' WHERE id = ?", [connectionId]);
    const before = await snapshot(pass.id);
    expect(
      await setBinding(jobCtxOf(kit), pass, {
        connectionId,
        externalRef: 'ref',
        generation: 1,
        connectionMode: 'poll',
        fieldSources: pass.fieldSources,
      }),
    ).toBe(false);
    expect(await snapshot(pass.id)).toEqual(before);
  }, 60_000);

  it('rejects image ABA between the artifact build and final publish CAS', async () => {
    const pass = await kit.pass();
    const a = `pass-assets/${pass.id}/${kit.fx.ids.token(8)}-a.png`;
    const b = `pass-assets/${pass.id}/${kit.fx.ids.token(8)}-b.png`;
    await kit.env.BUCKET.put(a, ICON_PNG);
    await kit.env.BUCKET.put(b, ICON_PNG);
    const digest = await sha1Hex(ICON_PNG);
    await run(
      kit.env.DB,
      `INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, width, height, crc32, created_at)
      VALUES (?, 'icon.png', ?, ?, ?, 38, 38, ?, ?)`,
      [pass.id, a, digest, ICON_PNG.length, crc32(ICON_PNG), kit.clock.now()],
    );
    const generation = await first<{ image_generation: number }>(
      kit.env.DB,
      'SELECT image_generation FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!generation) throw new Error('Missing image generation');
    const before = await snapshot(pass.id);
    const put = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    let raced = false;
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
      const object = await put(key, value, options);
      if (!raced && key.startsWith(`passes/${pass.id}/`)) {
        raced = true;
        await run(
          kit.env.DB,
          "UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = 'icon.png'",
          [b, pass.id],
        );
        await run(
          kit.env.DB,
          "UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = 'icon.png'",
          [a, pass.id],
        );
      }
      return object;
    });
    try {
      await expect(
        publishPass(jobCtxOf(kit), {
          passId: pass.id,
          cause: 'admin',
          actor,
          mutate: (current) => ({
            personalization: { ...current.personalization, memberName: 'Image race' },
          }),
        }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(raced).toBe(true);
      expect(
        await first(kit.env.DB, 'SELECT image_generation FROM passes WHERE id = ?', [pass.id]),
      ).toEqual({ image_generation: generation.image_generation + 2 });
      expect(await snapshot(pass.id)).toEqual(before);
      expect(
        (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects.map((o) => o.key),
      ).toEqual([pass.objectKey]);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('rejects an image writer whose staged generation was superseded before rebuild', async () => {
    const pass = await kit.pass();
    const before = await first<{ image_generation: number }>(
      kit.env.DB,
      'SELECT image_generation FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!before) throw new Error('Missing image generation');
    await run(
      kit.env.DB,
      `INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, width, height, crc32, created_at)
      VALUES (?, 'icon.png', ?, ?, ?, 38, 38, ?, ?)`,
      [
        pass.id,
        `pass-assets/${pass.id}/superseding.png`,
        await sha1Hex(ICON_PNG),
        ICON_PNG.length,
        crc32(ICON_PNG),
        kit.clock.now(),
      ],
    );
    const put = vi.spyOn(kit.env.BUCKET, 'put');
    try {
      await expect(
        publishPass(jobCtxOf(kit), {
          passId: pass.id,
          cause: 'admin',
          actor,
          force: true,
          expectedImageGeneration: before.image_generation,
        }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(put).not.toHaveBeenCalled();
      expect((await getPass(kit.env.DB, pass.id))?.version).toBe(pass.version);
    } finally {
      put.mockRestore();
    }
  }, 60_000);

  it('does not acknowledge a no-op after image ABA during its build', async () => {
    const pass = await kit.pass();
    const digest = await sha1Hex(ICON_PNG);
    const put = vi.spyOn(kit.env.BUCKET, 'put');
    let raced = false;
    overrideDeps(kit.env, {
      registry: {
        list: (q) => kit.registry.list(q),
        openAsset: (t, n) => kit.registry.openAsset(t, n),
        async resolve(id, version) {
          if (!raced) {
            raced = true;
            await run(
              kit.env.DB,
              `INSERT INTO pass_assets
            (pass_id, name, r2_key, sha1, size, width, height, crc32, created_at)
            VALUES (?, 'icon.png', ?, ?, ?, 38, 38, ?, ?)`,
              [
                pass.id,
                `pass-assets/${pass.id}/transient.png`,
                digest,
                ICON_PNG.length,
                crc32(ICON_PNG),
                kit.clock.now(),
              ],
            );
            await run(
              kit.env.DB,
              "DELETE FROM pass_assets WHERE pass_id = ? AND name = 'icon.png'",
              [pass.id],
            );
          }
          return kit.registry.resolve(id, version);
        },
      },
    });
    try {
      await expect(
        publishPass(jobCtxOf(kit), { passId: pass.id, cause: 'admin', actor }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(raced).toBe(true);
      expect(put).not.toHaveBeenCalled();
      expect((await getPass(kit.env.DB, pass.id))?.version).toBe(pass.version);
    } finally {
      put.mockRestore();
      overrideDeps(kit.env, { registry: kit.registry });
    }
  }, 60_000);
});
