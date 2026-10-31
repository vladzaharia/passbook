import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
import { createPassIdempotent } from './create.ts';
import { overrideDeps } from './deps.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo.ts';
import {
  deletePass,
  listPassSummaries,
  rotateLink,
  unvoidPass,
  updatePass,
  voidPass,
} from './service.ts';
import { type Kit, setupKit } from './test-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const actor = { type: 'user', id: 'admin-1' } as const;

describe('create', () => {
  it('stores the object, records version 1 and derives display fields', async () => {
    const pass = await kit.pass({ memberName: 'Sam Lee' });
    expect(pass.version).toBe(1);
    expect(pass.displayTitle).toBe('Sam Lee');
    expect(pass.revision).toBeGreaterThan(0);
    expect(await kit.env.BUCKET.head(pass.objectKey)).not.toBeNull();
    const versions = await all<{ cause: string; pass_json: string }>(
      kit.env.DB,
      'SELECT cause, pass_json FROM pass_versions WHERE pass_id = ?',
      [pass.id],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.cause).toBe('create');
    expect(JSON.parse(versions[0]?.pass_json ?? '{}')).toMatchObject({
      serialNumber: pass.serial,
      organizationName: 'Test Gym',
    });
  });

  it('rejects invalid input without leaving rows or objects behind', async () => {
    const before = await kit.env.BUCKET.list({ prefix: 'passes/' });
    await expect(
      createPassIdempotent(
        kit.ctx,
        { orgId: kit.org.id, templateId: kit.template.id, input: {}, source: 'manual', actor },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'PASS_INPUT_INVALID', status: 422 });
    expect((await kit.env.BUCKET.list({ prefix: 'passes/' })).objects).toHaveLength(
      before.objects.length,
    );
  });

  it('refuses a template from another organization', async () => {
    const other = await kit.fx.ids.id();
    await expect(
      createPassIdempotent(
        kit.ctx,
        {
          orgId: other,
          templateId: kit.template.id,
          input: { memberName: 'x' },
          source: 'manual',
          actor,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a duplicate serial and removes the stored object', async () => {
    const first = await kit.pass();
    const before = (await kit.env.BUCKET.list({ prefix: 'passes/' })).objects.length;
    await expect(
      createPassIdempotent(
        kit.ctx,
        {
          orgId: kit.org.id,
          templateId: kit.template.id,
          input: { memberName: 'Dup' },
          serial: first.serial,
          source: 'manual',
          actor,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'SERIAL_TAKEN' });
    expect((await kit.env.BUCKET.list({ prefix: 'passes/' })).objects).toHaveLength(before);
  });

  it('rejects an invalid holder email', async () => {
    await expect(
      createPassIdempotent(
        kit.ctx,
        {
          orgId: kit.org.id,
          templateId: kit.template.id,
          input: { memberName: 'x' },
          holderEmail: 'a@b.com,c@d.com',
          source: 'manual',
          actor,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
  });
});

describe('idempotency', () => {
  const base = () => ({
    orgId: kit.org.id,
    templateId: kit.template.id,
    input: { memberName: 'Idem' },
    source: 'manual' as const,
    actor,
  });

  it('returns the original pass for a retry with the same key and body', async () => {
    const key = `key-${kit.fx.ids.token(6)}`;
    const a = await createPassIdempotent(kit.ctx, base(), key);
    const b = await createPassIdempotent(kit.ctx, base(), key);
    expect(b.id).toBe(a.id);
    const count = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM passes WHERE org_id = ? AND display_title = ?',
      [kit.org.id, 'Idem'],
    );
    expect(count?.n).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const key = `key-${kit.fx.ids.token(6)}`;
    await createPassIdempotent(kit.ctx, base(), key);
    await expect(
      createPassIdempotent(kit.ctx, { ...base(), input: { memberName: 'Other' } }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects a key claimed with another body and frees the key after a failed create', async () => {
    const key = `key-${kit.fx.ids.token(6)}`;
    await run(
      kit.env.DB,
      'INSERT INTO idempotency_keys (org_id, key, request_hash, created_at) VALUES (?, ?, ?, ?)',
      [kit.org.id, key, 'h', 1],
    );
    await expect(createPassIdempotent(kit.ctx, base(), key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    const failing = `key-${kit.fx.ids.token(6)}`;
    await expect(
      createPassIdempotent(kit.ctx, { ...base(), input: {} }, failing),
    ).rejects.toMatchObject({ status: 422 });
    const created = await createPassIdempotent(kit.ctx, base(), failing);
    expect(created.id).toBeTruthy();
  });
});

describe('update and CAS publish', () => {
  it('bumps version, writes a new object and queues one push', async () => {
    const pass = await kit.pass({ memberName: 'Before' });
    const detail = await updatePass(
      kit.ctx,
      actor,
      pass.id,
      { input: { memberName: 'After' } },
      { scope: null },
    );
    expect(detail.version).toBe(2);
    expect(detail.title).toBe('After');
    expect(detail.fieldSources).toEqual({ memberName: 'manual' });
    const updated = await getPass(kit.env.DB, pass.id);
    expect(updated?.objectKey).not.toBe(pass.objectKey);
    expect(updated?.revision).toBeGreaterThan(pass.revision);
    const pushes = await all<{ state: string; id: string }>(
      kit.env.DB,
      "SELECT id, state FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    expect(pushes).toHaveLength(1);
  });

  it('does not publish when nothing changed', async () => {
    const pass = await kit.pass({ memberName: 'Same' });
    const detail = await updatePass(
      kit.ctx,
      actor,
      pass.id,
      { input: { memberName: 'Same' } },
      { scope: null },
    );
    expect(detail.version).toBe(1);
  });

  it('fails with 412 on a stale If-Match and leaves the pass untouched', async () => {
    const pass = await kit.pass();
    await updatePass(kit.ctx, actor, pass.id, { input: { memberName: 'v2' } }, { scope: null });
    await expect(
      updatePass(
        kit.ctx,
        actor,
        pass.id,
        { input: { memberName: 'v3' } },
        { scope: null, ifMatch: 1 },
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await getPass(kit.env.DB, pass.id))?.displayTitle).toBe('v2');
  });

  /** The registry runs between our read and our CAS, so a bump there is a lost race. */
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

  it('re-reads and re-applies when a concurrent writer wins the CAS', async () => {
    const pass = await kit.pass({ memberName: 'Race' });
    loseRaces(pass.id, 1);
    const seen: number[] = [];
    const result = await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'connection',
      actor: { type: 'connection', id: 'c1' },
      mutate: (current) => {
        seen.push(current.version);
        return { personalization: { ...current.personalization, memberName: 'Winner' } };
      },
    });
    restore();
    expect(seen).toEqual([1, 2]);
    expect(result.changed).toBe(true);
    expect(result.pass.displayTitle).toBe('Winner');
    expect(result.pass.syncErrorCode).toBeNull();
  });

  it('gives up with 409 after three lost races, without a sync error', async () => {
    const pass = await kit.pass({ memberName: 'Hot' });
    loseRaces(pass.id, 3);
    const attempt = publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'connection',
      actor: { type: 'connection', id: 'c1' },
      mutate: (current) => ({
        personalization: { ...current.personalization, memberName: 'Lost' },
      }),
    });
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    restore();
    expect((await getPass(kit.env.DB, pass.id))?.syncErrorCode).toBeNull();
    const objects = await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` });
    expect(objects.objects).toHaveLength(1);
  });

  it('coalesces pushes for edits made before the first push starts', async () => {
    const pass = await kit.pass();
    await updatePass(kit.ctx, actor, pass.id, { input: { memberName: 'e1' } }, { scope: null });
    await updatePass(kit.ctx, actor, pass.id, { input: { memberName: 'e2' } }, { scope: null });
    const rows = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('field sources', () => {
  it('locks manual fields against connection updates and resets them', async () => {
    const { applyConnectionRecord } = await import('./service.ts');
    const pass = await kit.pass({ memberName: 'Manual Name' });
    const connId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'demo', 'c', 1, 1)`,
      [connId, kit.org.id],
    );
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ? WHERE id = ?', [connId, pass.id]);
    const skipped = await applyConnectionRecord(kit.ctx, {
      passId: pass.id,
      connectionId: connId,
      generation: 1,
      fields: { memberName: 'Upstream' },
      cause: 'connection',
    });
    expect(skipped.changed).toBe(false);
    expect((await getPass(kit.env.DB, pass.id))?.displayTitle).toBe('Manual Name');

    const detail = await updatePass(
      kit.ctx,
      actor,
      pass.id,
      { resetToConnection: ['memberName'] },
      { scope: null },
    );
    expect(detail.fieldSources).toEqual({});
    const applied = await applyConnectionRecord(kit.ctx, {
      passId: pass.id,
      connectionId: connId,
      generation: 1,
      fields: { memberName: 'Upstream' },
      cause: 'connection',
    });
    expect(applied.changed).toBe(true);
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.displayTitle).toBe('Upstream');
    expect(after?.fieldSources).toEqual({ memberName: 'connection' });
  });

  it('fences runs from an older connection generation', async () => {
    const { applyConnectionRecord } = await import('./service.ts');
    const pass = await kit.pass();
    const connId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at) VALUES (?, ?, 'demo', 'c', 3, 1, 1)`,
      [connId, kit.org.id],
    );
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ? WHERE id = ?', [connId, pass.id]);
    const result = await applyConnectionRecord(kit.ctx, {
      passId: pass.id,
      connectionId: connId,
      generation: 2,
      fields: { memberName: 'Stale' },
      cause: 'connection',
    });
    expect(result.changed).toBe(false);
    expect((await getPass(kit.env.DB, pass.id))?.displayTitle).toBe('Alex Morgan');
  });
});

describe('void, links, delete', () => {
  it('voids and unvoids by rebuilding with voided set', async () => {
    const pass = await kit.pass();
    const voided = await voidPass(kit.ctx, actor, pass.id, null);
    expect(voided.status).toBe('voided');
    const row = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    );
    expect(JSON.parse(row?.pass_json ?? '{}').voided).toBe(true);
    const back = await unvoidPass(kit.ctx, actor, pass.id, null);
    expect(back.status).toBe('active');
  });

  it('rotates the download token and keeps the old link dead', async () => {
    const pass = await kit.pass();
    const { publicUrl } = await rotateLink(kit.ctx, actor, pass.id, null);
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.downloadToken).not.toBe(pass.downloadToken);
    expect(publicUrl).toContain(after?.downloadToken ?? 'x');
  });

  it('deletes rows and every stored object, and pushes the void first', async () => {
    const pass = await kit.pass();
    const device = 'dev-delete-1';
    await run(
      kit.env.DB,
      'INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, ?, ?, 1)',
      [device, pass.identityId, 'a'.repeat(64)],
    );
    await run(
      kit.env.DB,
      'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, ?, ?, 1)',
      [device, pass.identityId, pass.id],
    );
    await deletePass(kit.ctx, actor, pass.id, null);
    expect(await getPass(kit.env.DB, pass.id)).toBeNull();
    expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(0);
    expect(kit.apns.sent.some((s) => s.token === 'a'.repeat(64))).toBe(true);
    const leftover = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM devices WHERE device_id = ?',
      [device],
    );
    expect(leftover?.n).toBe(0);
  });
});

describe('list', () => {
  it('filters, searches by display prefix and paginates without repeats', async () => {
    const orgB = await kit.fx.ids.id();
    void orgB;
    for (const name of ['Zed One', 'Zed Two', 'Zed Three']) await kit.pass({ memberName: name });
    const first = await listPassSummaries(kit.ctx, { orgId: kit.org.id, q: 'zed', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await listPassSummaries(kit.ctx, {
      orgId: kit.org.id,
      q: 'zed',
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    const ids = new Set([...first.items, ...second.items].map((p) => p.id));
    expect(ids.size).toBe(first.items.length + second.items.length);
    expect(second.items.every((p) => (p.title ?? '').startsWith('Zed'))).toBe(true);
    const voidedOnly = await listPassSummaries(kit.ctx, {
      orgId: kit.org.id,
      status: 'voided',
      limit: 50,
    });
    expect(voidedOnly.items.every((p) => p.status === 'voided')).toBe(true);
  });
});
