import { expect, it, vi } from 'vitest';
import {
  installKeysetTestEnv,
  tombstoneWithoutKeyset,
} from '../../../../test/helpers/credential-keyset.ts';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run, type SqlValue } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { withKitDatabase } from '../passes/pass-test-fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { credentialTombstoneRefsForInput, scanCredentialKeys } from './credential-input.ts';
import { getScanner } from './repo-device.ts';
import { scanReadAuthority, scanReadFence } from './repo-read-authority.ts';
import { readScannerScope } from './repo-scope.ts';
import { searchPassesStmt, searchRowsOf, searchWindowUnchanged } from './repo-search.ts';
import { planCandidateReads } from './resolve-candidates.ts';
import { makeLegacyScanPass, proofedScanActor, setupScanKit } from './test-kit.ts';

// The keyset is immutable once set and storage is per file: every case needs a fresh database.
const makeEnv = installKeysetTestEnv();

async function fixture(expiresIn?: number) {
  const env = await makeEnv();
  const kit = await withKitDatabase(env.DB, setupScanKit);
  const templateId = await kit.scanTemplate('Candidate keyset plan', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const scanner = await kit.scanner({
    templateIds: [templateId],
    ...(expiresIn === undefined ? {} : { expiresAt: kit.clock.now() + expiresIn }),
  });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row?.csrfSecret) throw new Error('Missing scanner authority');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(scannerActor(kit.ctx, row, 'live', 'cookie', scope), null),
    { keysetPolicy: 'defer' },
  );
  const input = { passId: pass.id, method: 'manual' as const };
  const refs = await credentialTombstoneRefsForInput(
    kit.ctx,
    actor.orgId,
    actor.mode,
    input,
    true,
    'defer',
  );
  return { kit, scanner, pass, template, actor, input, refs };
}

it('bootstraps the original keyset and candidate in the actor-fenced batch', async () => {
  const { kit, pass, actor, input, refs } = await fixture();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  const candidates = plan.finish(await kit.env.DB.batch(plan.stmts));
  expect(candidates).toMatchObject([
    {
      pass: { id: pass.id },
      credentialKeysetCommitment: refs.credentialKeysetCommitment,
      credentialTombstoneRefs: [],
      otherModeCredentialTombstoneRefs: [],
    },
  ]);
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toEqual({ commitment: refs.credentialKeysetCommitment });
});

it('reads the first scoped search page in the same bootstrap batch', async () => {
  const { kit, pass, actor, input, refs } = await fixture();
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, pass.id, false);
  expect(keys.credentialKeysetCommitment).toBe(refs.credentialKeysetCommitment);
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  const query = searchPassesStmt(
    kit.env.DB,
    actor,
    pass.id,
    null,
    keys,
    kit.clock.now(),
    0,
    keys.credentialTombstoneRefs,
  );
  if (!query) throw new Error('Missing scoped search query');
  const results = await kit.env.DB.batch([...plan.stmts, query]);
  expect(plan.finish(results.slice(0, plan.stmts.length))).toMatchObject([
    { pass: { id: pass.id } },
  ]);
  expect(searchRowsOf(results[plan.stmts.length])).toEqual([
    { id: pass.id, last_scan_at: null, last_scan_id: null },
  ]);
});

/** Run a miss's window check (`{org}` and `{mode}` are the grant's) for the actor's tenant. */
async function holds(
  kit: Awaited<ReturnType<typeof fixture>>['kit'],
  actor: { orgId: string; mode: string },
  window: { sql: string; params: readonly SqlValue[] } | null,
) {
  if (!window) return null;
  const sql = window.sql
    .replaceAll('{org}', `'${actor.orgId}'`)
    .replaceAll('{mode}', `'${actor.mode}'`);
  const row = await first<{ ok: number }>(
    kit.env.DB,
    `SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END AS ok`,
    window.params,
  );
  return row?.ok;
}

it('keeps a miss only while the same eligible match window stands, pending transfers included', async () => {
  const { kit, pass, actor } = await fixture();
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, pass.id, false);
  const window = (observed: number, scope = actor) =>
    searchWindowUnchanged(
      scope,
      pass.id,
      null,
      keys,
      kit.clock.now(),
      keys.credentialTombstoneRefs,
      observed,
    );
  expect(await holds(kit, actor, window(1))).toBe(1);
  // The read saw no match, and one exists now: the miss is stale.
  expect(await holds(kit, actor, window(0))).toBe(0);
  // The same input in the other mode is not this window.
  expect(await holds(kit, { ...actor, mode: 'test' }, window(1, { ...actor, mode: 'test' }))).toBe(
    0,
  );
  // A transfer reserves provider placeholders under the keyset (0043), so it needs one.
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id: kit.fx.ids.id(),
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
  });
  expect(await holds(kit, actor, window(1))).toBe(0);
});

it('escapes name prefixes in the shared search and miss window', async () => {
  const { kit, pass, actor } = await fixture();
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Alpha% literal',
    pass.id,
  ]);
  const window = async (q: string) => {
    const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, q, false);
    return holds(
      kit,
      actor,
      searchWindowUnchanged(actor, q, null, keys, kit.clock.now(), keys.credentialTombstoneRefs, 1),
    );
  };
  expect(await window('Alpha%')).toBe(1);
  expect(await window('Alpha_')).toBe(0);
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, 'a@', false);
  expect(
    searchWindowUnchanged(
      actor,
      'a@',
      null,
      undefined,
      kit.clock.now(),
      keys.credentialTombstoneRefs,
      1,
    ),
  ).toBeNull();
});

it('fences a hidden-only search window and detects pending matching transfers', async () => {
  const { kit, pass, template, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toHaveLength(1);
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Alpha original',
    pass.id,
  ]);
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, 'Alpha', false);
  const window = () =>
    holds(
      kit,
      actor,
      searchWindowUnchanged(
        actor,
        'Alpha',
        null,
        keys,
        kit.clock.now(),
        keys.credentialTombstoneRefs,
        1,
      ),
    );
  expect(await window()).toBe(1);
  // A second match enlarges the window.
  const replacement = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Alpha replacement',
    replacement.id,
  ]);
  expect(await window()).toBe(0);
  // The window keeps its size when one match leaves: only its size is compared, not who is in it.
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', ['Not matched', pass.id]);
  expect(await window()).toBe(1);
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Alpha original',
    pass.id,
  ]);
  await run(kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
    'Not matched',
    replacement.id,
  ]);
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id: kit.fx.ids.id(),
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
  });
  expect(await window()).toBe(0);
});

it('selects a deterministic latest scan within the same organization and mode', async () => {
  const { kit, scanner, pass, template, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toHaveLength(1);
  const at = kit.clock.now();
  for (const [id, mode, state, timestamp] of [
    ['scan-a', 'live', 'done', at],
    ['scan-b', 'live', 'done', at],
    ['scan-older', 'live', 'done', at - 1],
    ['scan-other-mode', 'test', 'done', at + 1],
    ['scan-pending', 'live', 'pending', at + 2],
  ] as const) {
    await run(
      kit.env.DB,
      `INSERT INTO scans
      (id,org_id,mode,pass_id,template_id,actor_type,actor_id,actor_key,
        idempotency_key,request_hash,method,state,at)
      VALUES (?,?,?,?,?,'scanner',?,?,?,?,'manual',?,?)`,
      [
        id,
        actor.orgId,
        mode,
        pass.id,
        template.id,
        scanner.id,
        actor.actorKey,
        id,
        id,
        state,
        timestamp,
      ],
    );
  }
  const countPlan = await planCandidateReads(kit.ctx, actor, input, refs, null);
  if (!countPlan.capacityStmt) throw new Error('Missing history capacity statement');
  const countResults = await kit.env.DB.batch([...countPlan.stmts, countPlan.capacityStmt]);
  expect(countPlan.finish(countResults.slice(0, countPlan.stmts.length))).toHaveLength(1);
  expect(countResults[countPlan.stmts.length]?.results).toEqual([{ id: pass.id, n: 4 }]);
  const keys = await scanCredentialKeys(kit.env, actor.orgId, actor.mode, pass.id, false);
  const query = searchPassesStmt(
    kit.env.DB,
    actor,
    pass.id,
    null,
    keys,
    at,
    0,
    keys.credentialTombstoneRefs,
  );
  if (!query) throw new Error('Missing scoped search query');
  expect(searchRowsOf(await query.all())).toEqual([
    { id: pass.id, last_scan_at: at, last_scan_id: 'scan-b' },
  ]);
});

it('does not bootstrap after the original actor loses authority', async () => {
  const { kit, scanner, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  expect(plan.stmts.length).toBeGreaterThan(0);
  await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
    kit.clock.now(),
    scanner.id,
  ]);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});

it.each(['default', 'claim'] as const)(
  'does not bootstrap or return credentials when the original actor expires during hashing (%s)',
  async (kind) => {
    const { kit, pass, actor } = await fixture(1_000);
    const input = { code: pass.serial, method: 'manual' as const };
    const refs = await credentialTombstoneRefsForInput(
      kit.ctx,
      actor.orgId,
      actor.mode,
      input,
      true,
      'defer',
    );
    const expiresAt = kit.clock.now() + 1_000;
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let expiredDuringHash = false;
    let guardNow: number | undefined;
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const result = await nativeDigest(algorithm, data);
      if (!expiredDuringHash && new TextDecoder().decode(data) === input.code) {
        expiredDuringHash = true;
        kit.clock.advance(1_000);
      }
      return result;
    });
    try {
      const plan = await planCandidateReads(
        kit.ctx,
        actor,
        input,
        refs,
        kind === 'claim'
          ? (now) => {
              guardNow = now;
              return scanReadFence(scanReadAuthority(actor, { now }));
            }
          : undefined,
      );
      expect(expiredDuringHash).toBe(true);
      expect(plan.now).toBe(expiresAt);
      if (kind === 'claim') expect(guardNow).toBe(expiresAt);
      expect(plan.stmts.length).toBeGreaterThan(0);
      expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          `SELECT name FROM sqlite_master
        WHERE type='trigger' AND name='credential_ref_keyset_insert_guard'`,
        ),
      ).toEqual({ name: 'credential_ref_keyset_insert_guard' });
    } finally {
      digest.mockRestore();
    }
  },
);

it('never bootstraps a read-only candidate plan', async () => {
  const { kit, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs, null);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});

it('does not initialize after a denied new-claim guard', async () => {
  const { kit, actor, input, refs } = await fixture();
  const plan = await planCandidateReads(kit.ctx, actor, input, refs, () => ({
    sql: '0',
    params: [],
  }));
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});

it('does not bootstrap a missing keyset over retained credential references', async () => {
  const { kit, actor, input, refs } = await fixture();
  // A retained pre-keyset reference: a transfer cannot be staged without a keyset any more (0043).
  await tombstoneWithoutKeyset(kit.env.DB);
  const plan = await planCandidateReads(kit.ctx, actor, input, refs);
  expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
  ).toBeNull();
});
