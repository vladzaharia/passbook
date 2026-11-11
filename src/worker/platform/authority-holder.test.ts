import { describe, expect, it } from 'vitest';
import { makePass } from '../../../test/helpers/index.ts';
import { grant } from './authority.ts';
import { noReleaseHead } from './authority-checks.ts';
import { tenantCheck } from './authority-cond.ts';
import { codeOf, count, db, refusal } from './authority-ext-fixtures.ts';
import { builtOf } from './authority-granted.ts';
import type { HolderProof, Principal } from './authority-principal.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first, run } from './db.ts';
import { sha256Hex } from './ids.ts';

type Setup = Awaited<ReturnType<typeof setupGrant>>;
const PURPOSE = {
  session: 'org_mode.pass.holder_remove',
  verified_email: 'org_mode.pass.holder_attach',
  device: 'org_mode.pass.personalize',
} as const;

const holder = (passId: string, proof: HolderProof): Principal => ({
  kind: 'holder',
  passId,
  proof,
});
const passRow = (id: string) =>
  first<{
    identity_id: string;
    serial: string;
    auth_token: string;
    credential_generation: number;
    org_id: string;
    mode: string;
  }>(
    db,
    'SELECT identity_id, serial, auth_token, credential_generation, org_id, mode FROM passes WHERE id = ?',
    [id],
  );
const deviceProof = async (id: string): Promise<HolderProof> => {
  const p = await passRow(id);
  return {
    via: 'device',
    identityId: p?.identity_id ?? '',
    serial: p?.serial ?? '',
    authToken: p?.auth_token ?? '',
    credentialGeneration: p?.credential_generation ?? 0,
  };
};
const forProof = (x: Setup, passId: string, proof: HolderProof) =>
  grant(x.route, { purpose: PURPOSE[proof.via], principal: holder(passId, proof) });
const title = async (id: string) =>
  (
    await first<{ t: string | null }>(db, 'SELECT display_title AS t FROM passes WHERE id = ?', [
      id,
    ])
  )?.t;

describe('holder principal (27)', () => {
  it('takes org and mode from the pass; writes only its pass', async () => {
    const x = await setupGrant('hp-basic');
    const other = await makePass(x.s.f, { orgId: x.s.org.id, template: x.s.template.resolved });
    const g = forProof(x, x.s.pass.id, await deviceProof(x.s.pass.id));
    g.update('passes', { set: { display_title: 'held' }, where: { status: 'active' } });
    g.insertSelect(
      'pass_events',
      ['pass_id', 'kind', 'data', 'at'],
      [x.s.pass.id, 'personalize', '{}', 1],
    );
    await g.commit();
    expect(await title(x.s.pass.id)).toBe('held');
    expect(await title(other.id)).not.toBe('held');
    expect(
      await first(db, "SELECT org_id, mode FROM pass_events WHERE kind = 'personalize'"),
    ).toEqual({
      org_id: x.s.org.id,
      mode: 'live',
    });
    expect(await count('SELECT count(*) AS n FROM authority_grants')).toBe(0);
  });

  it('refuses another pass id in where or an insert, and any table without a pass column', async () => {
    const x = await setupGrant('hp-tables');
    const other = await makePass(x.s.f, { orgId: x.s.org.id, template: x.s.template.resolved });
    const g = forProof(x, x.s.pass.id, await deviceProof(x.s.pass.id));
    const bad = (fn: () => unknown) => codeOf(fn);
    expect(
      bad(() => g.update('passes', { set: { display_title: 'x' }, where: { id: other.id } })),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad(() => g.delete('pass_events', { where: { pass_id: other.id } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(
      bad(() =>
        g.insertSelect('pass_events', ['pass_id', 'kind', 'data', 'at'], [other.id, 'k', '{}', 1]),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad(() => g.insertSelect('pass_events', ['kind', 'data', 'at'], ['k', '{}', 1]))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad(() => g.joined('pass_assets', { where: { pass_id: other.id }, delete: true }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad(() => g.joined('pass_assets', { where: { kind: 'x' }, delete: true }))).toBeNull();
    expect(bad(() => g.update('scans', { set: { reason: 'x' }, where: { id: 'x' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(
      bad(() => g.insertSelect('settings', ['key', 'value', 'updated_at'], ['k', 'v', 1])),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      bad(() =>
        g.upsert('scan_gates', ['pass_id', 'action_id', 'scope'], [x.s.pass.id, 'a', ''], {
          doNothing: true,
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      bad(() => g.joined('scan_event_templates', { where: { template_id: 't' }, delete: true })),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      bad(() =>
        g.joined('bundle_passes', {
          via: 'bundle_id',
          where: { pass_id: x.s.pass.id },
          delete: true,
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      bad(() =>
        g.insertJoined('pass_assets', {
          parents: { pass_id: other.id },
          columns: ['kind'],
          values: ['x'],
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      builtOf(
        g.update('pass_credential_transfers', { set: { state: 'completed' }, where: { id: 't' } }),
      ).sql,
    ).toContain('g.target_id = pass_credential_transfers.pass_id');
    expect(
      g.audit({
        at: 1,
        orgId: x.s.org.id,
        actorType: 'user',
        actorId: null,
        action: 'a',
        targetType: null,
        targetId: null,
        requestId: null,
        ipPrefix: null,
        detail: null,
      }),
    ).toBeDefined();
  });

  it('outbox rows are pinned to the pass or to its issuance delivery', async () => {
    const x = await setupGrant('hp-outbox');
    const other = await makePass(x.s.f, { orgId: x.s.org.id, template: x.s.template.resolved });
    for (const [id, pass] of [
      ['ob-1', x.s.pass.id],
      ['ob-2', other.id],
    ] as const)
      await run(
        db,
        "INSERT INTO outbox (id, org_id, kind, pass_id, state, created_at) VALUES (?, ?, 'push', ?, 'pending', 1)",
        [id, x.s.org.id, pass],
      );
    const g = forProof(x, x.s.pass.id, await deviceProof(x.s.pass.id));
    g.update('outbox', { set: { state: 'cancelled', finished_at: 5 }, where: { kind: 'push' } });
    await g.commit();
    const states = await db.prepare('SELECT id, state FROM outbox ORDER BY id').all();
    expect(states.results).toEqual([
      { id: 'ob-1', state: 'cancelled' },
      { id: 'ob-2', state: 'pending' },
    ]);
    expect(
      codeOf(() => g.update('outbox', { set: { state: 'x' }, where: { pass_id: other.id } })),
    ).toBe('GRANT_SCOPE_OVERRIDE');
  });

  it('allows only the purpose of its proof, an org_mode scope, and its own pass as target', async () => {
    const x = await setupGrant('hp-purposes');
    const id = x.s.pass.id;
    const device = await deviceProof(id);
    const proofs: HolderProof[] = [
      { via: 'session', userId: x.s.user.id, sessionIdHash: 'h' },
      { via: 'verified_email', userId: x.s.user.id },
      device,
    ];
    for (const proof of proofs) {
      expect(
        codeOf(() => forProof(x, id, proof)),
        proof.via,
      ).toBeNull();
      for (const purpose of [
        ...Object.values(PURPOSE).filter((p) => p !== PURPOSE[proof.via]),
        'org_mode.pass.publish',
        'org.pass.personalize',
      ])
        expect(
          codeOf(() => grant(x.route, { purpose, principal: holder(id, proof) })),
          `${proof.via} ${purpose}`,
        ).toBe('GRANT_BAD_PRINCIPAL');
      expect(
        codeOf(() =>
          grant(x.route, {
            purpose: PURPOSE[proof.via],
            principal: holder(id, proof),
            target: 'other',
          }),
        ),
      ).toBe('GRANT_BAD_PRINCIPAL');
      expect(
        codeOf(() =>
          grant(x.route, { purpose: PURPOSE[proof.via], principal: holder(id, proof), target: id }),
        ),
      ).toBeNull();
    }
    expect(await count('SELECT count(*) AS n FROM authority_grants')).toBe(0);
  });

  it('the grant row carries the pass as its target, and a CHECK net refuses a holder row with another purpose', async () => {
    const x = await setupGrant('hp-check');
    await expect(
      run(
        db,
        "INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, created_at, leak_guard) VALUES ('hc-1', 'org_mode', ?, 'live', 'holder:u', 'org_mode.pass.publish', 1, 'hc-1')",
        [x.s.org.id],
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(
        db,
        "INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, created_at, leak_guard) VALUES ('hc-2', 'org_mode', ?, 'live', 'device:p', 'org_mode.pass.holder_attach', 1, 'hc-2')",
        [x.s.org.id],
      ),
    ).rejects.toThrow(/CHECK/);
    await run(db, 'DELETE FROM authority_grants');
  });
});

describe('session proof (28)', () => {
  const setup = async (label: string) => {
    const x = await setupGrant(label);
    const owned = await makePass(x.s.f, {
      orgId: x.s.org.id,
      template: x.s.template.resolved,
      ownerUserId: x.s.user.id,
    });
    const theirs = await makePass(x.s.f, {
      orgId: x.s.org.id,
      template: x.s.template.resolved,
      ownerUserId: x.s.admin.id,
    });
    const hash = await sha256Hex(x.s.session.cookieValue);
    const commit = (passId = owned.id) =>
      forProof(x, passId, { via: 'session', userId: x.s.user.id, sessionIdHash: hash }).commit();
    return { x, owned, theirs, commit };
  };

  it('commits for the owner with a live session', async () => {
    const { commit } = await setup('hs-ok');
    await expect(commit()).resolves.toBeDefined();
  });

  it('refuses a revoked or expired session and an owner who changed (actor)', async () => {
    const { x, theirs, commit } = await setup('hs-bad');
    expect(await refusal(commit(theirs.id))).toMatchObject({ code: 'ACTOR_CHANGED' });
    await run(db, 'UPDATE sessions SET revoked_at = 1 WHERE user_id = ?', [x.s.user.id]);
    expect(await refusal(commit())).toMatchObject({ code: 'ACTOR_CHANGED' });
    await run(db, 'UPDATE sessions SET revoked_at = NULL WHERE user_id = ?', [x.s.user.id]);
    const now = x.s.f.clock.now();
    x.s.f.clock.advance(365 * 24 * 3600_000);
    expect(await refusal(commit())).toMatchObject({ code: 'ACTOR_CHANGED' });
    x.s.f.clock.set(now);
    await expect(commit()).resolves.toBeDefined();
  });
});

describe('verified_email proof (29)', () => {
  const setup = async (label: string) => {
    const x = await setupGrant(label);
    const email = `${label}@example.com`;
    const mk = (ownerUserId?: string) =>
      makePass(x.s.f, {
        orgId: x.s.org.id,
        template: x.s.template.resolved,
        holderEmail: email,
        ...(ownerUserId ? { ownerUserId } : {}),
      });
    const pass = await mk();
    const verify = () =>
      run(
        db,
        "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'magic_link', 1)",
        [email, x.s.user.id],
      );
    const commit = (passId = pass.id, checks: ReturnType<typeof tenantCheck>[] = []) =>
      grant(x.route, {
        purpose: PURPOSE.verified_email,
        principal: holder(passId, { via: 'verified_email', userId: x.s.user.id }),
        checks,
      }).commit();
    return { x, pass, mk, verify, commit };
  };

  it('commits for the active user who verified the pass email', async () => {
    const { verify, commit } = await setup('hv-ok');
    await verify();
    await expect(commit()).resolves.toBeDefined();
  });

  it('refuses an unverified email, a disabled user and an owned pass (actor)', async () => {
    const { x, mk, verify, commit } = await setup('hv-bad');
    expect(await refusal(commit())).toMatchObject({ code: 'ACTOR_CHANGED' });
    await verify();
    await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [x.s.user.id]);
    expect(await refusal(commit())).toMatchObject({ code: 'ACTOR_CHANGED' });
    await run(db, "UPDATE users SET status = 'active' WHERE id = ?", [x.s.user.id]);
    await expect(commit()).resolves.toBeDefined();
    const owned = await mk(x.s.admin.id);
    expect(await refusal(commit(owned.id))).toMatchObject({ code: 'ACTOR_CHANGED' });
  });

  it('a block row is part of the proof and refuses (actor); an owner check composes too', async () => {
    const { x, pass, verify, commit } = await setup('hv-unique');
    await verify();
    const unblocked = tenantCheck(
      'lineage',
      'NOT EXISTS (SELECT 1 FROM pass_attach_blocks blk WHERE blk.pass_id = ? AND blk.user_id = ?)',
      [pass.id, x.s.user.id],
    );
    await expect(commit(pass.id, [unblocked])).resolves.toBeDefined();
    await run(
      db,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)',
      [pass.id, x.s.user.id],
    );
    expect(await refusal(commit(pass.id, [unblocked]))).toMatchObject({ code: 'ACTOR_CHANGED' });
  });
});

describe('device proof (30)', () => {
  const commit = async (
    x: Setup,
    passId: string,
    over: Partial<Extract<HolderProof, { via: 'device' }>> = {},
  ) => forProof(x, passId, { ...(await deviceProof(passId)), ...over } as HolderProof).commit();

  it('commits for the captured credential and refuses a stale snapshot (actor)', async () => {
    const x = await setupGrant('hd-stale');
    const id = x.s.pass.id;
    await expect(commit(x, id)).resolves.toBeDefined();
    expect(await refusal(commit(x, id, { authToken: 'rotated' }))).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
    expect(await refusal(commit(x, id, { credentialGeneration: 99 }))).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
    expect(await refusal(commit(x, id, { serial: 'other' }))).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
    expect(await refusal(commit(x, id, { identityId: 'other' }))).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
  });

  it('refuses a quarantined pass (actor) and a suspended org (org)', async () => {
    const x = await setupGrant('hd-state');
    const id = x.s.pass.id;
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [x.s.org.id]);
    expect(await refusal(commit(x, id))).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
    await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [x.s.org.id]);
    await run(db, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [id]);
    expect(await refusal(commit(x, id))).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(await refusal(commit(x, 'no-such-pass', { serial: 'x' }))).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
  });
});

describe('noReleaseHead (31)', () => {
  const hex = (n: number) => n.toString(16).padStart(64, '0');
  let counter = 1;
  const templateOf = async (x: Setup) =>
    (
      await first<{ t: string }>(db, 'SELECT template_id AS t FROM passes WHERE id = ?', [
        x.s.pass.id,
      ])
    )?.t ?? '';
  /** The template as baked sync leaves it, owned by `orgId` (null: platform), with a release head. */
  const baked = async (x: Setup, orgId: string | null, mode: string) => {
    const t = await templateOf(x);
    await run(db, "UPDATE templates SET org_id = ?, origin = 'baked' WHERE id = ?", [orgId, t]);
    const v = await first<{ version: string }>(
      db,
      'SELECT version FROM template_versions WHERE template_id = ?',
      [t],
    );
    await run(
      db,
      `INSERT OR IGNORE INTO template_version_hashes (template_id, version, content_hash, asset_hashes, created_at)
       VALUES (?, ?, ?, '[]', 1)`,
      [t, v?.version ?? '', hex(9)],
    );
    await run(
      db,
      `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
         content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action, created_at)
       VALUES (?, ?, ?, ?, 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'system', 'system', 1)`,
      [x.s.f.ids.id(), t, orgId, mode, v?.version ?? '', hex(counter++), hex(9)],
    );
    return t;
  };
  const attempt = async (x: Setup, templateId: string) =>
    refusal(
      grant(x.route, {
        purpose: 'org_mode.pass.publish',
        principal: x.member(),
        checks: [noReleaseHead(templateId)],
      }).commit(),
    );

  it('passes with no head, and with a head in the other mode', async () => {
    const x = await setupGrant('nrh-none');
    expect(await attempt(x, await templateOf(x))).toBeNull();
    const t = await baked(x, x.s.org.id, 'test');
    expect(await attempt(x, t)).toBeNull();
  });

  it('refuses with an org head, or with the platform head of an unassigned baked template', async () => {
    const x = await setupGrant('nrh-head');
    const t = await baked(x, x.s.org.id, 'live');
    expect(await attempt(x, t)).toMatchObject({ code: 'TEMPLATE_RELEASE_CHANGED' });
    const y = await setupGrant('nrh-platform');
    const u = await baked(y, null, 'live');
    expect(await attempt(y, u)).toMatchObject({ code: 'TEMPLATE_RELEASE_CHANGED' });
  });

  it('binds four values and needs an org_mode grant', async () => {
    const x = await setupGrant('nrh-binds');
    const mk = (checks: ReturnType<typeof noReleaseHead>[]) =>
      grant(x.route, { purpose: 'org_mode.pass.publish', principal: x.member(), checks });
    expect(
      mk([noReleaseHead('t', 'apple')]).inspect().grant.params - mk([]).inspect().grant.params,
    ).toBe(4);
    const orgG = () =>
      grant(x.route, {
        purpose: 'org.pass.publish',
        principal: x.member({ mode: undefined }),
        checks: [noReleaseHead('t')],
      });
    expect(codeOf(orgG)).toBe('GRANT_SCOPE_OVERRIDE');
  });
});
