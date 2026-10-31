import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { deletePassAsset, putPassAsset } from './asset-service.ts';
import { reissuePage } from './bulk.ts';
import { createPassIdempotent } from './create.ts';
import { overrideDeps } from './deps.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo.ts';
import {
  applyConnectionRecord,
  createPassFromConnection,
  createPassRow,
  updatePass,
} from './service.ts';
import { expectValidZip, ICON_PNG, type Kit, setupKit, TINY_PNG } from './test-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const actor = { type: 'system', id: null } as const;
const count = async (sql: string, params: (string | number)[] = []) =>
  (await first<{ n: number }>(kit.env.DB, sql, params))?.n ?? 0;
/** Pending pushes coalesce, so settle the existing ones first to see new rows. */
const settled = (passId: string) =>
  run(kit.env.DB, "UPDATE outbox SET state = 'sent' WHERE pass_id = ? AND kind = 'push'", [passId]);
const pushes = (passId: string) =>
  count("SELECT count(*) AS n FROM outbox WHERE pass_id = ? AND kind = 'push'", [passId]);
const bytesOf = async (key: string) => {
  const object = await kit.env.BUCKET.get(key);
  if (!object) throw new Error(`missing ${key}`);
  return new Uint8Array(await object.arrayBuffer());
};

async function connection() {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', 'c', 1, 1, 1)`,
    [id, kit.org.id],
  );
  return id;
}

describe('image overrides', () => {
  it('keeps a shared object while another slot still uses it', async () => {
    const pass = await kit.pass();
    const logo = makePng(40, 40);
    await putPassAsset(kit.ctx, actor, pass.id, 'logo.png', logo, null);
    await putPassAsset(kit.ctx, actor, pass.id, 'logo@2x.png', logo, null);
    const keys = await all<{ name: string; r2_key: string }>(
      kit.env.DB,
      'SELECT name, r2_key FROM pass_assets WHERE pass_id = ? ORDER BY name',
      [pass.id],
    );
    expect(new Set(keys.map((k) => k.r2_key)).size).toBe(2);
    // Rows written before keys carried the slot name share one object.
    await run(
      kit.env.DB,
      "UPDATE pass_assets SET r2_key = (SELECT r2_key FROM pass_assets WHERE pass_id = ?1 AND name = 'logo.png') WHERE pass_id = ?1 AND name = 'logo@2x.png'",
      [pass.id],
    );
    await deletePassAsset(kit.ctx, actor, pass.id, 'logo@2x.png', null);
    const left = await first<{ r2_key: string }>(
      kit.env.DB,
      "SELECT r2_key FROM pass_assets WHERE pass_id = ? AND name = 'logo.png'",
      [pass.id],
    );
    expect(await kit.env.BUCKET.head(left?.r2_key ?? '')).not.toBeNull();
    await expect(
      updatePass(kit.ctx, actor, pass.id, { input: { memberName: 'Rebuilt' } }, { scope: null }),
    ).resolves.toBeDefined();
  });

  it('rejects truncated and corrupt PNGs', async () => {
    const pass = await kit.pass();
    const corrupt = ICON_PNG.slice();
    corrupt[corrupt.length - 20] = (corrupt[corrupt.length - 20] ?? 0) ^ 0xff;
    for (const bad of [ICON_PNG.slice(0, 50), corrupt]) {
      await expect(
        putPassAsset(kit.ctx, actor, pass.id, 'icon.png', bad, null),
      ).rejects.toMatchObject({
        code: 'ASSET_NOT_PNG',
      });
    }
  });

  it('stores correct CRCs for overridden images, including rows without a stored CRC', async () => {
    const pass = await kit.pass();
    await putPassAsset(kit.ctx, actor, pass.id, 'icon.png', ICON_PNG, null);
    const published = await getPass(kit.env.DB, pass.id);
    expect(expectValidZip(await bytesOf(published?.objectKey ?? ''))).toContain('icon.png');
    await run(kit.env.DB, 'UPDATE pass_assets SET crc32 = NULL WHERE pass_id = ?', [pass.id]);
    await updatePass(kit.ctx, actor, pass.id, { input: { memberName: 'Legacy' } }, { scope: null });
    const next = await getPass(kit.env.DB, pass.id);
    expectValidZip(await bytesOf(next?.objectKey ?? ''));
  });
});

describe('template upgrades and re-sign', () => {
  /** A fresh template id per test, so other tests keep resolving the kit template. */
  async function upgradable() {
    const id = `tpl-up-${kit.fx.ids.token(4)}`;
    const add = async (version: string, description?: string) => {
      const t = kit.registry.add({
        id,
        version,
        manifest: kit.template.manifest,
        passJson: { ...kit.template.passJson, ...(description ? { description } : {}) },
        assets: { 'icon.png': TINY_PNG },
      });
      await persistTemplate(kit.fx, t);
    };
    await add('v1');
    const pass = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: id,
      templateVersion: 'v1',
      input: { memberName: 'Up' },
      source: 'manual',
      actor,
    });
    return { pass, add };
  }

  it('moves the version without a new object or push when the content is identical', async () => {
    const { pass, add } = await upgradable();
    await add('same-1');
    await settled(pass.id);
    const before = await pushes(pass.id);
    const result = await updatePass(
      kit.ctx,
      actor,
      pass.id,
      { templateVersion: 'same-1' },
      { scope: null },
    );
    const after = await getPass(kit.env.DB, pass.id);
    expect(result.templateVersion).toBe('same-1');
    expect(after?.objectKey).toBe(pass.objectKey);
    expect(await pushes(pass.id)).toBe(before);
  });

  it('publishes and pushes when the upgrade changes the pass', async () => {
    const { pass, add } = await upgradable();
    await add('changed-1', 'Changed description');
    await settled(pass.id);
    await updatePass(kit.ctx, actor, pass.id, { templateVersion: 'changed-1' }, { scope: null });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.objectKey).not.toBe(pass.objectKey);
    expect(await pushes(pass.id)).toBe(1);
  });

  it('re-signs into a new object without queuing a push', async () => {
    const pass = await kit.pass();
    await settled(pass.id);
    const before = await pushes(pass.id);
    await publishPass(kit.ctx, { passId: pass.id, cause: 'resign', actor, force: true });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.objectKey).not.toBe(pass.objectKey);
    expect(after?.version).toBe(2);
    expect(await pushes(pass.id)).toBe(before);
  });
});

describe('idempotent create', () => {
  it('keeps the key after the pass row exists, so a retry replays the pass', async () => {
    const params = {
      orgId: kit.org.id,
      templateId: kit.template.id,
      input: { memberName: 'Idem' },
      holderEmail: 'idem@example.com',
      externalId: 'idem-after-insert',
      sendEmail: true,
      source: 'manual' as const,
      actor,
    };
    await run(
      kit.env.DB,
      "CREATE TRIGGER fail_email BEFORE INSERT ON outbox WHEN NEW.kind = 'email' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      await expect(createPassIdempotent(kit.ctx, params, 'key-after-insert')).rejects.toThrow();
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_email');
    }
    const replay = await createPassIdempotent(kit.ctx, params, 'key-after-insert');
    expect(replay.externalId).toBe('idem-after-insert');
    expect(
      await count("SELECT count(*) AS n FROM passes WHERE external_id = 'idem-after-insert'"),
    ).toBe(1);
  });
});

describe('connection records', () => {
  const input = (connectionId: string, externalRef: string) => ({
    orgId: kit.org.id,
    templateId: kit.template.id,
    connectionId,
    externalRef,
    fields: { memberName: 'Race' },
    holderEmail: 'race@example.com',
    sendEmail: true,
  });

  it('creates one pass and one email for concurrent syncs of the same ref', async () => {
    const connectionId = await connection();
    const results = await Promise.all([
      createPassFromConnection(kit.ctx, input(connectionId, 'ref-race')),
      createPassFromConnection(kit.ctx, input(connectionId, 'ref-race')),
    ]);
    expect(results[0].passId).toBe(results[1].passId);
    expect(
      await count('SELECT count(*) AS n FROM passes WHERE connection_id = ? AND external_ref = ?', [
        connectionId,
        'ref-race',
      ]),
    ).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        results[0].passId,
      ]),
    ).toBe(1);
  });

  it('refuses a duplicate ref at the database', async () => {
    const connectionId = await connection();
    const first = await createPassFromConnection(kit.ctx, input(connectionId, 'ref-dup'));
    await expect(
      createPassRow(kit.ctx, {
        ...input(connectionId, 'ref-dup'),
        input: { memberName: 'Dup' },
        source: 'connection',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'PASS_REF_TAKEN' });
    expect(first.passId).toBeTruthy();
  });

  it('records a holder assignment only when the email changes', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(kit.ctx, {
      ...input(connectionId, 'ref-audit'),
      holderEmail: null,
    });
    const base = { passId, connectionId, generation: 1, fields: {}, cause: 'connection' as const };
    for (let i = 0; i < 3; i++)
      await applyConnectionRecord(kit.ctx, { ...base, holderEmail: 'Same@Example.com' });
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'holder.assign' AND target_id = ?",
        [passId],
      ),
    ).toBe(1);
    await applyConnectionRecord(kit.ctx, { ...base, holderEmail: 'next@example.com' });
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'holder.assign' AND target_id = ?",
        [passId],
      ),
    ).toBe(2);
  });
});

describe('registry failures', () => {
  const failing = () =>
    overrideDeps(kit.env, {
      registry: {
        list: (q) => kit.registry.list(q),
        openAsset: (t, n) => kit.registry.openAsset(t, n),
        resolve: async () => {
          throw new Error('D1_ERROR: Network connection lost.');
        },
      },
    });
  const restore = () => overrideDeps(kit.env, { registry: kit.registry });

  it('retries a reissue page instead of dropping it as TEMPLATE_NOT_FOUND', async () => {
    const pass = await kit.pass();
    failing();
    try {
      await expect(
        reissuePage(
          kit.ctx,
          {
            templateId: kit.template.id,
            version: 'next-version',
            orgId: kit.org.id,
            identityId: pass.identityId,
            cause: 'template_upgrade',
          },
          null,
        ),
      ).rejects.toThrow('D1_ERROR');
    } finally {
      restore();
    }
  });

  it('still reports a missing template as 404', async () => {
    await expect(
      createPassRow(kit.ctx, {
        orgId: kit.org.id,
        templateId: 'nope',
        input: {},
        source: 'manual',
        actor,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'TEMPLATE_NOT_FOUND' });
  });
});

describe('parallel edits', () => {
  function loseRaces(passId: string, times: number) {
    let left = times;
    overrideDeps(kit.env, {
      registry: {
        list: (q) => kit.registry.list(q),
        openAsset: (t, n) => kit.registry.openAsset(t, n),
        async resolve(id, version) {
          if (left > 0) {
            left--;
            await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [passId]);
          }
          return kit.registry.resolve(id, version);
        },
      },
    });
  }
  const restore = () => overrideDeps(kit.env, { registry: kit.registry });

  it('keeps versions contiguous and objects referenced', async () => {
    const pass = await kit.pass();
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((i) =>
        updatePass(kit.ctx, actor, pass.id, { input: { memberName: `P${i}` } }, { scope: null }),
      ),
    );
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const versions = await all<{ version: number; object_key: string }>(
      kit.env.DB,
      'SELECT version, object_key FROM pass_versions WHERE pass_id = ? ORDER BY version',
      [pass.id],
    );
    expect(versions.map((v) => v.version)).toEqual(versions.map((_, i) => i + 1));
    const stored = (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects;
    const referenced = new Set(versions.map((v) => v.object_key));
    for (const object of stored) expect(referenced.has(object.key)).toBe(true);
    const current = await getPass(kit.env.DB, pass.id);
    expect(await kit.env.BUCKET.head(current?.objectKey ?? '')).not.toBeNull();
  });

  it('answers 412 and deletes the new object when If-Match is current but the CAS is lost', async () => {
    const pass = await kit.pass();
    const before = (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects.length;
    loseRaces(pass.id, 1);
    try {
      await expect(
        updatePass(
          kit.ctx,
          actor,
          pass.id,
          { input: { memberName: 'Late' } },
          { scope: null, ifMatch: 1 },
        ),
      ).rejects.toBeInstanceOf(PreconditionFailedError);
    } finally {
      restore();
    }
    expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(
      before,
    );
  });

  it('retries a metadata-only write that lost the race', async () => {
    const pass = await kit.pass();
    loseRaces(pass.id, 1);
    try {
      await updatePass(kit.ctx, actor, pass.id, { externalId: 'meta-race' }, { scope: null });
    } finally {
      restore();
    }
    expect((await getPass(kit.env.DB, pass.id))?.externalId).toBe('meta-race');
  });
});
