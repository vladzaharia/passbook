import { describe, expect, it } from 'vitest';
import { makeApiKey, makePass } from '../../../test/helpers/index.ts';
import { makeJoinLink } from '../../../test/helpers/join.ts';
import { grant, jobGrant } from './authority.ts';
import { codeOf, db, refusal } from './authority-ext-fixtures.ts';
import { grantInsert, JOIN_PURPOSE, JOIN_TABLES, scopeOf } from './authority-granted.ts';
import type { Principal } from './authority-principal.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { all, first, run } from './db.ts';
import { sha256Hex } from './ids.ts';

type Setup = Awaited<ReturnType<typeof setupGrant>>;

/** An org, a live link on its template, and a pass of the link's org and mode to attach. */
async function seed(label: string, extra: { mode?: 'live' | 'test' } = {}) {
  const x = await setupGrant(label);
  const mode = extra.mode ?? 'live';
  const pass = await makePass(x.s.f, {
    orgId: x.s.org.id,
    template: x.s.template.resolved,
    mode,
  });
  const link = await makeJoinLink(x.s.f, {
    orgId: x.s.org.id,
    templateId: x.s.template.resolved.id,
    mode,
  });
  return { x, pass, link };
}

const join = (link: { id: string; generation: number }): Principal => ({
  kind: 'join',
  linkId: link.id,
  generation: link.generation,
});

/** A join grant that records the pass in the ledger. */
function ledger(x: Setup, link: { id: string; generation: number }, passId: string) {
  const g = grant(x.route, {
    purpose: JOIN_PURPOSE,
    principal: join(link),
    target: passId,
    tables: JOIN_TABLES,
    codes: { actor: 'JOIN_LINK_CLOSED' },
  });
  g.insertSelect(
    'join_issues',
    ['id', 'link_id', 'link_generation', 'created_at'],
    [x.s.f.ids.id(), link.id, link.generation, 1],
    { from: { table: 'passes', where: { id: passId }, copy: { pass_id: 'id' } } },
  );
  return g;
}
const issues = (linkId: string) =>
  all<{ org_id: string; mode: string; pass_id: string }>(
    db,
    'SELECT org_id, mode, pass_id FROM join_issues WHERE link_id = ?',
    [linkId],
  );

describe('join principal', () => {
  it('takes org and mode from the link row', async () => {
    for (const mode of ['live', 'test'] as const) {
      const { x, pass, link } = await seed(`jp-mode-${mode}`, { mode });
      await ledger(x, link, pass.id).commit();
      expect(await issues(link.id)).toEqual([{ org_id: x.s.org.id, mode, pass_id: pass.id }]);
    }
  });

  it('refuses with actor when the link is off', async () => {
    const { x, pass, link } = await seed('jp-off');
    await run(db, 'UPDATE join_links SET enabled = 0 WHERE id = ?', [link.id]);
    const e = await refusal(ledger(x, link, pass.id).commit());
    expect(e?.code).toBe('JOIN_LINK_CLOSED');
    expect(await issues(link.id)).toEqual([]);
  });

  it('refuses with actor when the link was rotated (generation moved)', async () => {
    const { x, pass, link } = await seed('jp-rotated');
    await run(db, 'UPDATE join_links SET generation = generation + 1 WHERE id = ?', [link.id]);
    expect((await refusal(ledger(x, link, pass.id).commit()))?.code).toBe('JOIN_LINK_CLOSED');
    expect(await issues(link.id)).toEqual([]);
  });

  it('refuses with actor when the link is deleted', async () => {
    const { x, pass, link } = await seed('jp-deleted');
    await run(db, 'DELETE FROM join_links WHERE id = ?', [link.id]);
    expect((await refusal(ledger(x, link, pass.id).commit()))?.code).toBe('JOIN_LINK_CLOSED');
  });

  it('refuses with org when the org is suspended', async () => {
    const { x, pass, link } = await seed('jp-suspended');
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [x.s.org.id]);
    const e = await refusal(ledger(x, link, pass.id).commit());
    expect(e?.code).toBe('ORG_ACCESS_CHANGED');
  });

  it('labels the grant row and the audit actor join:<linkId>', async () => {
    const { x, pass, link } = await seed('jp-label');
    const g = ledger(x, link, pass.id);
    g.audit({
      at: 1,
      orgId: x.s.org.id,
      actorType: 'system',
      actorId: `join:${link.id}`,
      action: 'pass.create',
      targetType: 'pass',
      targetId: pass.id,
      requestId: null,
      ipPrefix: null,
      detail: null,
    });
    // The label bound into the grant row's `principal` column.
    const insert = grantInsert(
      g.id,
      g.scope,
      { purpose: JOIN_PURPOSE, principal: join(link), target: pass.id },
      [],
      1,
    );
    expect(insert.params).toContain(`join:${link.id}`);
    expect(insert.params).toContain(JOIN_PURPOSE);
    await g.commit();
    expect(
      await first(
        db,
        "SELECT actor_id FROM audit_log WHERE action = 'pass.create' AND target_id = ?",
        [pass.id],
      ),
    ).toEqual({ actor_id: `join:${link.id}` });
  });

  it('refuses a system principal with the join purpose in scopeOf', async () => {
    const { x } = await seed('jp-scopeof');
    expect(
      codeOf(() =>
        scopeOf({
          purpose: JOIN_PURPOSE,
          principal: { kind: 'system', job: 'j', orgId: x.s.org.id, mode: 'live' },
          target: 'p',
          tables: JOIN_TABLES,
        }),
      ),
    ).toBe('GRANT_BAD_PRINCIPAL');
  });
});

describe('join grant pin', () => {
  it('writes only its target pass and only inserts', async () => {
    const { x, pass, link } = await seed('jpin');
    const other = await makePass(x.s.f, { orgId: x.s.org.id, template: x.s.template.resolved });
    const g = grant(x.route, {
      purpose: JOIN_PURPOSE,
      principal: join(link),
      target: pass.id,
      tables: JOIN_TABLES,
    });
    expect(g.pinned).toBe(true);
    // Changing, deleting or upserting is not what a join does, even on its own pass.
    for (const fn of [
      () => g.update('passes', { set: { holder_email: 'x@y.co' }, where: { id: other.id } }),
      () => g.update('passes', { set: { holder_email: 'x@y.co' }, where: { id: pass.id } }),
      () => g.delete('join_issues', { where: { pass_id: other.id } }),
      () => g.upsert('scans', ['id'], ['i'], { doNothing: true }),
    ])
      expect(codeOf(fn)).toBe('GRANT_SCOPE_OVERRIDE');
    // An insert names the target pass, not another.
    expect(
      codeOf(() =>
        g.insertSelect('pass_events', ['pass_id', 'kind', 'data', 'at'], [other.id, 'k', '{}', 1]),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      codeOf(() =>
        g.insertSelect('pass_events', ['kind', 'data', 'at'], ['k', '{}', 1], {
          from: { table: 'passes', where: { id: pass.id }, copy: { pass_id: 'id' } },
        }),
      ),
    ).toBeNull();
    // The ledger names its own link and generation.
    for (const [linkId, generation] of [
      ['other-link', link.generation],
      [link.id, link.generation + 1],
    ] as const)
      expect(
        codeOf(() =>
          g.insertSelect(
            'join_issues',
            ['id', 'link_id', 'link_generation', 'created_at'],
            ['i', linkId, generation, 1],
            {
              from: { table: 'passes', where: { id: pass.id }, copy: { pass_id: 'id' } },
            },
          ),
        ),
      ).toBe('GRANT_SCOPE_OVERRIDE');
  });

  it('a pinned grant cannot reach a table without a pass column', async () => {
    const { x, pass, link } = await seed('jpin-table');
    const g = grant(x.route, {
      purpose: JOIN_PURPOSE,
      principal: join(link),
      target: pass.id,
      tables: ['passes'],
    });
    expect(codeOf(() => g.insertSelect('passes', ['id'], ['someone-else']))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
  });
});

describe('join purpose bound', () => {
  it('a join principal holds org_mode.pass.join only', async () => {
    const { x, link } = await seed('jb-purpose');
    const base = { principal: join(link), target: 'p', tables: ['passes'] };
    for (const purpose of [
      'org_mode.pass.create',
      'org_mode.pass.holder_remove',
      'org.join.manage',
      'platform.join.manage',
      'org_mode.pass.join.extra',
    ])
      expect(
        codeOf(() => grant(x.route, { ...base, purpose })),
        purpose,
      ).toBe('GRANT_BAD_PRINCIPAL');
  });

  it('refuses a join grant with no target, no table list, or a table outside the create list', async () => {
    const { x, link } = await seed('jb-tables');
    const p = { purpose: JOIN_PURPOSE, principal: join(link) };
    expect(codeOf(() => grant(x.route, { ...p, tables: ['passes'] }))).toBe('GRANT_BAD_PRINCIPAL');
    expect(codeOf(() => grant(x.route, { ...p, target: 'p' }))).toBe('GRANT_BAD_PRINCIPAL');
    expect(codeOf(() => grant(x.route, { ...p, target: 'p', tables: ['passes', 'orgs'] }))).toBe(
      'GRANT_BAD_PRINCIPAL',
    );
    expect(codeOf(() => grant(x.route, { ...p, target: 'p', tables: ['join_links'] }))).toBe(
      'GRANT_BAD_PRINCIPAL',
    );
    expect(codeOf(() => grant(x.route, { ...p, target: 'p', tables: JOIN_TABLES }))).toBeNull();
  });

  it('the grant writes only its listed tables', async () => {
    const { x, link } = await seed('jb-write');
    const g = grant(x.route, {
      purpose: JOIN_PURPOSE,
      principal: join(link),
      target: 'p',
      tables: ['join_issues'],
    });
    expect(codeOf(() => g.insertSelect('orgs', ['name'], ['x']))).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(codeOf(() => g.insertSelect('join_links', ['id'], ['x']))).toBe(
      'GRANT_TABLE_NOT_ALLOWED',
    );
  });

  it('no other principal holds org_mode.pass.join', async () => {
    const { x } = await seed('jb-others');
    const key = await makeApiKey(x.s.f, { orgId: x.s.org.id });
    const others: Principal[] = [
      x.member(),
      { kind: 'api_key', keyId: key.id, scope: 'passes:write' },
      { kind: 'scanner', scannerId: x.s.scannerId, credentialEpoch: 1 },
      {
        kind: 'holder',
        passId: x.s.pass.id,
        proof: { via: 'verified_email', userId: x.s.user.id },
      },
      {
        kind: 'platform',
        userId: x.s.admin.id,
        sessionIdHash: await sha256Hex(x.s.adminSession.cookieValue),
        orgId: x.s.org.id,
        mode: 'live',
      },
    ];
    for (const principal of others)
      expect(
        codeOf(() =>
          grant(x.route, { purpose: JOIN_PURPOSE, principal, target: 'p', tables: JOIN_TABLES }),
        ),
        principal.kind,
      ).toBe('GRANT_BAD_PRINCIPAL');
  });

  it('a system principal cannot hold it through a job grant', async () => {
    const { x } = await seed('jb-system');
    expect(
      codeOf(() =>
        jobGrant(x.ctx, {
          job: 'join',
          orgId: x.s.org.id,
          mode: 'live',
          purpose: JOIN_PURPOSE,
          tables: JOIN_TABLES,
        }),
      ),
    ).toBe('GRANT_BAD_PURPOSE');
  });

  it('a pass of another mode than the link is not copied into the ledger', async () => {
    const { x, link } = await seed('jb-mode-forged');
    // A test pass behind a live link: the grant's mode is the link's, the copied pass row's is not.
    const other = await makePass(x.s.f, {
      orgId: x.s.org.id,
      template: x.s.template.resolved,
      mode: 'test',
    });
    // The pass is read under the grant's tenant, so a pass of the other mode is not found: nothing lands.
    expect(await refusal(ledger(x, link, other.id).commit())).toBeNull();
    expect(await issues(link.id)).toEqual([]);
  });

  it('leaves no grant row behind', async () => {
    const { x, pass, link } = await seed('jb-leak');
    await ledger(x, link, pass.id).commit();
    expect(await first(db, 'SELECT count(*) AS n FROM authority_grants')).toEqual({ n: 0 });
  });
});
