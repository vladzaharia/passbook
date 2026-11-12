import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { captureCredentialKeyEnv, ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { credentialTombstoneRef } from '../passes/credential-tombstones.ts';
import { credentialTombstoneRefsForInput, scanCredentialKeys } from './credential-input.ts';
import {
  credentialTombstonesClear,
  noCredentialTombstonesSql,
} from './repo-credential-tombstones.ts';
import { candidateById } from './repo-lookup.ts';
import { foundOf } from './resolve.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

async function retire(
  db: D1Database,
  passId: string,
  mode: 'live' | 'test',
  generation: number,
  ref: string,
  kind = 'serial',
) {
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await stagePendingCredentialTransfer(db, passId, {
    id,
    token: kit.fx.ids.token(),
    now,
    targetHolderEmail: 'new@example.test',
  });
  const inserted = await run(
    db,
    `INSERT INTO pass_credential_tombstones
    (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
    SELECT pass_id, org_id, mode, source_generation, ?, ?, ?
    FROM pass_credential_transfers WHERE id=? AND mode=? AND source_generation=?`,
    [kind, ref, now, id, mode, generation],
  );
  expect(inserted.changes).toBe(1);
}

const request = (input: unknown) => ({ idempotencyKey: key(), input, clientTs: kit.clock.now() });

describe('scanner credential tombstones', () => {
  it('uses keyed cross-kind refs for free text but permits an explicit authorized passId', async () => {
    const templateId = await kit.scanTemplate('Credential selection', {
      actions: [CHECK_IN],
      lookup: { input: 'memberNo' },
    });
    const other = await kit.scanPass(templateId);
    const live = await kit.scanPass(templateId, { memberNo: other.serial });
    const test = await kit.scanPass(templateId, { memberNo: other.serial }, { mode: 'test' });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { lookup: true, roleWithoutSignIn: 'desk' },
    });
    const keys = await scanCredentialKeys(kit.env, kit.org.id, 'live', other.serial);
    expect(keys.credentialTombstoneRefs.length).toBeGreaterThan(0);
    expect(keys.credentialTombstoneRefs.every((ref) => /^[0-9a-f]{64}$/.test(ref))).toBe(true);
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        keys.credentialTombstoneRefs,
        keys.credentialKeysetCommitment,
      ),
    ).toBe(true);
    expect(
      noCredentialTombstonesSql(
        undefined,
        { orgIdSql: 'p.org_id', modeSql: 'p.mode' },
        keys.credentialKeysetCommitment,
      ).sql,
    ).toBe('0');
    const directProof = noCredentialTombstonesSql(
      [],
      { orgIdSql: 'p.org_id', modeSql: 'p.mode' },
      keys.credentialKeysetCommitment,
    );
    expect(directProof.sql).toContain('credential_ref_keyset');
    expect(directProof.params).toEqual([keys.credentialKeysetCommitment]);
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        [],
        keys.credentialKeysetCommitment,
      ),
    ).toBe(true);
    const wrongKeyset =
      keys.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    expect(await credentialTombstonesClear(kit.env.DB, kit.org.id, 'live', [], wrongKeyset)).toBe(
      false,
    );
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        keys.credentialTombstoneRefs,
        wrongKeyset,
      ),
    ).toBe(false);
    const changedEnv = { ...kit.env, KEK_V1: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' };
    const changedKeys = await scanCredentialKeys(changedEnv, kit.org.id, 'live', other.serial);
    expect(changedKeys.credentialKeysetCommitment).not.toBe(keys.credentialKeysetCommitment);
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        changedKeys.credentialTombstoneRefs,
        changedKeys.credentialKeysetCommitment,
      ),
    ).toBe(false);
    await expect(
      credentialTombstoneRefsForInput(
        { ...kit.ctx, env: changedEnv },
        kit.org.id,
        'live',
        { passId: live.id, method: 'manual' },
        true,
        'require',
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    const mutableEnv = { ...kit.env };
    const frozenKeys = scanCredentialKeys(mutableEnv, kit.org.id, 'live', other.serial);
    mutableEnv.KEK_V1 = changedEnv.KEK_V1;
    expect((await frozenKeys).credentialTombstoneRefs).toEqual(keys.credentialTombstoneRefs);
    const originalRing = captureCredentialKeyEnv(kit.env);
    const injectedOlderKey = { ...kit.env, KEK_V0: changedEnv.KEK_V1 };
    const isolated = await scanCredentialKeys(
      injectedOlderKey,
      kit.org.id,
      'live',
      other.serial,
      true,
      undefined,
      keys.credentialKeysetCommitment,
      originalRing,
    );
    expect(isolated.credentialKeysetCommitment).toBe(keys.credentialKeysetCommitment);
    expect(isolated.credentialTombstoneRefs).toEqual(keys.credentialTombstoneRefs);
    const inputEnv = { ...kit.env };
    const frozenInput = credentialTombstoneRefsForInput(
      { ...kit.ctx, env: inputEnv },
      kit.org.id,
      'live',
      { code: other.serial, method: 'manual' },
      true,
      'defer',
    );
    inputEnv.KEK_V1 = changedEnv.KEK_V1;
    expect((await frozenInput).credentialTombstoneRefs).toEqual(keys.credentialTombstoneRefs);
    const noDb = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'prepare' || prop === 'batch')
          return () => {
            throw new Error('Deferred input touched D1');
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const deferred = await credentialTombstoneRefsForInput(
      { ...kit.ctx, env: { ...kit.env, DB: noDb } },
      kit.org.id,
      'live',
      { code: other.serial, method: 'manual' },
      true,
      'defer',
    );
    expect(deferred).toEqual({
      credentialKeysetCommitment: keys.credentialKeysetCommitment,
      credentialTombstoneRefs: keys.credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs: keys.otherModeCredentialTombstoneRefs,
    });
    const before = await kit.post(scanner.headers, '/lookup', { q: other.serial });
    const beforeBody = (await before.json()) as { items: { passId: string }[] };
    expect(beforeBody.items.map((item) => item.passId)).toContain(live.id);
    for (const secret of [keys.credentialKeysetCommitment, ...keys.credentialTombstoneRefs])
      expect(JSON.stringify(beforeBody)).not.toContain(secret);
    const testLookupRef = await credentialTombstoneRef(
      kit.env,
      kit.org.id,
      'test',
      keys.lookupHash,
    );
    await retire(kit.env.DB, test.id, 'test', test.credentialGeneration, testLookupRef, 'lookup');
    const pendingTest = await candidateById(kit.env.DB, kit.org.id, test.id);
    expect(pendingTest).toMatchObject({
      transferPending: true,
      pass: { credentialGeneration: test.credentialGeneration + 1 },
    });
    expect(pendingTest && (await foundOf(kit.ctx, pendingTest))).toBeNull();
    const wrongMode = await kit.post(
      scanner.headers,
      '/resolve',
      request({ passId: test.id, method: 'manual' }),
    );
    expect(await wrongMode.json()).toMatchObject({
      reason: 'not_found',
      card: null,
      display: null,
    });
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        keys.credentialTombstoneRefs,
        keys.credentialKeysetCommitment,
      ),
    ).toBe(true);
    await retire(
      kit.env.DB,
      other.id,
      'live',
      other.credentialGeneration,
      keys.credentialTombstoneRefs[0]!,
    );
    const pendingLive = await candidateById(kit.env.DB, kit.org.id, other.id);
    expect(pendingLive).toMatchObject({
      transferPending: true,
      pass: { credentialGeneration: other.credentialGeneration + 1 },
    });
    expect(pendingLive && (await foundOf(kit.ctx, pendingLive))).toBeNull();
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        keys.credentialTombstoneRefs,
        keys.credentialKeysetCommitment,
      ),
    ).toBe(false);
    const lookup = await kit.post(scanner.headers, '/lookup', { q: other.serial });
    expect(await lookup.json()).toEqual({ items: [], more: false });
    for (const route of ['resolve', 'actions'] as const) {
      const response = await kit.post(scanner.headers, `/${route}`, {
        ...request({ code: other.serial, method: 'manual' }),
        ...(route === 'actions' ? { actionId: 'check_in' } : {}),
      });
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ reason: 'not_found', card: null, display: null });
      expect(text).not.toContain(live.id);
    }
    const direct = await kit.post(
      scanner.headers,
      '/resolve',
      request({ passId: live.id, method: 'manual' }),
    );
    expect(await direct.json()).toMatchObject({ kind: 'ready', card: { passId: live.id } });
    expect(
      await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [live.id]),
    ).toHaveLength(0);
  });

  it('treats a search name as a credential in its own tenant and mode', async () => {
    const templateId = await kit.scanTemplate('Ambiguous search credential', {
      actions: [CHECK_IN],
      lookup: { input: 'memberNo' },
    });
    const source = await kit.scanPass(templateId);
    const victim = await kit.scanPass(templateId, { memberName: `${source.serial} Guest` });
    const otherMode = await kit.scanPass(templateId, { memberNo: source.serial }, { mode: 'test' });
    const foreignOrg = await makeOrg(kit.fx);
    const foreignTemplate = await kit.scanTemplate(
      'Foreign search credential',
      {
        actions: [CHECK_IN],
        lookup: { input: 'memberNo' },
      },
      { orgId: foreignOrg.id },
    );
    const foreign = await kit.scanPass(
      foreignTemplate,
      { memberNo: source.serial },
      { orgId: foreignOrg.id },
    );
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { lookup: true, roleWithoutSignIn: 'desk' },
    });
    const keys = await scanCredentialKeys(kit.env, kit.org.id, 'live', source.serial);
    const search = async (q: string) =>
      (await (await kit.post(scanner.headers, '/lookup', { q })).json()) as {
        items: { passId: string }[];
        more: boolean;
      };
    expect((await search(source.serial)).items.map((item) => item.passId)).toContain(victim.id);
    const testRef = await credentialTombstoneRef(kit.env, kit.org.id, 'test', keys.lookupHash);
    await retire(
      kit.env.DB,
      otherMode.id,
      'test',
      otherMode.credentialGeneration,
      testRef,
      'lookup',
    );
    expect((await search(source.serial)).items.map((item) => item.passId)).toContain(victim.id);
    const foreignRef = await credentialTombstoneRef(
      kit.env,
      foreignOrg.id,
      'live',
      keys.lookupHash,
    );
    await retire(
      kit.env.DB,
      foreign.id,
      'live',
      foreign.credentialGeneration,
      foreignRef,
      'lookup',
    );
    expect((await search(source.serial)).items.map((item) => item.passId)).toContain(victim.id);
    await retire(
      kit.env.DB,
      source.id,
      'live',
      source.credentialGeneration,
      keys.credentialTombstoneRefs[0]!,
    );
    expect(await search(source.serial)).toEqual({ items: [], more: false });
    expect((await search(source.serial.slice(0, 8))).items.map((item) => item.passId)).toContain(
      victim.id,
    );
  });

  it('filters pending transfers before the search page limit', async () => {
    const templateId = await kit.scanTemplate('Pending search page', { actions: [CHECK_IN] });
    const seed = await kit.scanPass(templateId, { memberName: 'Seed Person' });
    const allowed = await kit.scanPass(templateId, { memberName: 'Queue Z Eligible' });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { lookup: true, roleWithoutSignIn: 'desk' },
    });
    const prefix = `pending-${kit.fx.ids.token(6)}-`;
    await run(
      kit.env.DB,
      `WITH RECURSIVE seq(n) AS (
      SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<49
    ) INSERT INTO passes
      (id, org_id, identity_id, serial, template_id, template_version, release_id, auth_token,
       download_token, web_service_url, personalization, display_title, object_key, modified_at,
       created_at, mode, pending_pass_json)
      SELECT ? || printf('%02d', n), p.org_id, p.identity_id, p.serial || '-pending-' || n,
        p.template_id, p.template_version, p.release_id, p.auth_token, p.download_token || '-pending-' || n,
        p.web_service_url, json_set(p.personalization, '$.memberName', 'Queue A-' || printf('%02d', n)),
        'Queue A-' || printf('%02d', n), p.object_key, p.modified_at, p.created_at, p.mode,
        json_set(v.pass_json, '$.serialNumber', p.serial || '-pending-' || n)
      FROM passes p JOIN pass_versions v ON v.pass_id=p.id AND v.version=p.version
      CROSS JOIN seq WHERE p.id=?`,
      [prefix, seed.id],
    );
    const pending = await all<{ id: string }>(kit.env.DB, 'SELECT id FROM passes WHERE id GLOB ?', [
      `${prefix}*`,
    ]);
    expect(pending).toHaveLength(50);
    for (const row of pending) {
      await stagePendingCredentialTransfer(kit.env.DB, row.id, {
        id: kit.fx.ids.id(),
        token: kit.fx.ids.token(),
        now: kit.clock.now(),
        targetHolderEmail: 'new@example.test',
      });
    }
    const real = kit.env.DB;
    let searches = 0;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            if (sql.includes('FROM passes p JOIN templates t') && sql.includes('LIMIT 50 OFFSET'))
              searches++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    let response: Response;
    try {
      response = await kit.post(scanner.headers, '/lookup', { q: 'Queue' });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ passId: allowed.id }], more: false });
    expect(searches).toBe(1);
  });

  it('masks a cross-mode warning if the other-mode ref is retired after its precheck', async () => {
    const templateId = await kit.scanTemplate('Cross-mode credential race', {
      actions: [CHECK_IN],
      lookup: { input: 'memberNo' },
    });
    const other = await kit.scanPass(templateId, {}, { mode: 'test' });
    const pass = await kit.scanPass(
      templateId,
      {
        memberName: 'Cross Mode Credential Private',
        memberNo: other.serial,
      },
      { mode: 'test' },
    );
    const scanner = await kit.scanner({ templateIds: [templateId], mode: 'live' });
    const keys = await scanCredentialKeys(kit.env, kit.org.id, 'live', other.serial);
    const real = kit.env.DB;
    let fired = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          if (prop === 'first')
            return async () => {
              const row = await target.first();
              if (!fired) {
                fired = true;
                await retire(
                  real,
                  other.id,
                  'test',
                  other.credentialGeneration,
                  keys.otherModeCredentialTombstoneRefs[0]!,
                );
              }
              return row;
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            // The other-mode precheck (`credentialTombstonesClearStmt`); its predicate is parenthesized.
            if (
              !sql.startsWith(
                'SELECT 1 WHERE (NOT EXISTS (SELECT 1 FROM pass_credential_tombstones',
              )
            )
              return statement;
            return new Proxy(statement, {
              get(inner, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = inner.bind(...values);
                    return values[1] === 'test' ? wrap(bound) : bound;
                  };
                const value = Reflect.get(inner, member, inner);
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    let response: Response;
    try {
      response = await kit.post(
        scanner.headers,
        '/resolve',
        request({ code: other.serial, method: 'manual' }),
      );
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    expect(fired).toBe(true);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      card: null,
      display: null,
    });
    expect(text).not.toContain(pass.id);
    expect(text).not.toContain('Cross Mode Credential Private');
  });
});
