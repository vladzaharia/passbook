import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { assertNoLeakedGrants, insertLeakedGrant } from '../../../test/helpers/index.ts';
import {
  grant,
  grantedBatch,
  jobGrant,
  prepareGrantForTest,
  sweepLeakedGrants,
} from './authority.ts';
import { epochIs, orgRevision, passRow, rawCheck, rowIs } from './authority-checks.ts';
import type { AuthorityError } from './authority-error.ts';
import { authorityPredicate } from './authority-read.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { all, first, run } from './db.ts';
import { AppError } from './errors.ts';
import { sha256Hex } from './ids.ts';
import { createLogger } from './log.ts';

const db = env.DB;

const setup = setupGrant;

const title = (id: string) =>
  first<{ t: string | null }>(db, 'SELECT display_title AS t FROM passes WHERE id = ?', [id]);
const rowVersion = async (id: string) =>
  (await first<{ v: number }>(db, 'SELECT row_version AS v FROM passes WHERE id = ?', [id]))?.v ??
  0;
const grants = async () =>
  (await first<{ n: number }>(db, 'SELECT count(*) AS n FROM authority_grants'))?.n;

async function refused(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('grant commit', () => {
  it('applies typed writes from the grant row and leaves no grant behind', async () => {
    const { s, route, member } = await setup('g-happy');
    const before = await rowVersion(s.pass.id);
    const g = grant(route, {
      purpose: 'org_mode.pass.publish',
      principal: member({ sessionIdHash: await sha256Hex(s.session.cookieValue) }),
      checks: passRow(s.pass.id, before),
    });
    g.update('passes', { set: { display_title: 'granted' }, where: { id: s.pass.id } });
    await g.commit();
    expect((await title(s.pass.id))?.t).toBe('granted');
    expect(await rowVersion(s.pass.id)).toBeGreaterThan(before);
    expect(await grants()).toBe(0);
  });

  it('writes outside the grant tenant match nothing', async () => {
    const { s, route, member } = await setup('g-tenant2');
    const other = await setup('g-tenant2-other');
    await run(db, "UPDATE passes SET mode = 'test' WHERE id = ?", [other.s.pass.id]).catch(
      () => undefined,
    );
    const g = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    const crossOrg = g.update('passes', {
      set: { display_title: 'x' },
      where: { id: other.s.pass.id },
    });
    expect(crossOrg).toBeDefined();
    const [r] = await g.commit();
    expect(r?.meta.changes).toBe(0);
    expect((await title(other.s.pass.id))?.t).not.toBe('x');
    expect(s.pass.id).not.toBe(other.s.pass.id);
  });

  it('org_mode grants take the grant mode: a test-mode pass is untouched by a live grant', async () => {
    const { s, route, member } = await setup('g-mode');
    await run(db, 'UPDATE passes SET status = status WHERE id = ?', [s.pass.id]);
    const live = grant(route, {
      purpose: 'org_mode.pass.publish',
      principal: member({ mode: 'test' }),
    });
    live.update('passes', { set: { display_title: 'test-grant' }, where: { id: s.pass.id } });
    const [r] = await live.commit();
    expect(r?.meta.changes).toBe(0);
  });

  it('insertSelect takes the org from the grant row', async () => {
    const { s, route, member } = await setup('g-insert');
    const g = grant(route, {
      purpose: 'org.settings.update',
      principal: member({ mode: undefined }),
    });
    g.insertSelect('settings', ['key', 'value', 'updated_at'], ['wp0.insert', '1', 1]);
    await g.commit();
    const rows = await all<{ scope: string }>(
      db,
      "SELECT scope FROM settings WHERE key = 'wp0.insert'",
    );
    expect(rows).toEqual([{ scope: `org:${s.org.id}` }]);
  });

  it('refuses epoch writes, scope columns and unguarded tables', async () => {
    const { route, member } = await setup('g-misuse');
    const g = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as AuthorityError).code;
      }
      return null;
    };
    expect(code(() => g.update('passes', { set: { row_version: 9 }, where: { id: 'x' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(code(() => g.update('passes', { set: { org_id: 'x' }, where: { id: 'x' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(code(() => g.update('passes', { set: { status: 'x' }, where: { org_id: 'x' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(code(() => g.update('passes', { set: { status: 'x' }, where: { mode: 'live' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(
      code(() => g.update('wallet_provider_accounts', { set: { a: 1 }, where: { id: 'x' } })),
    ).toBe('GRANT_UNGUARDED_TABLE');
    expect(code(() => g.update('passes', { set: { status: 'x' }, where: {} }))).toBe(
      'GRANT_BAD_PURPOSE',
    );
    expect(code(() => g.insertSelect('passes', ['org_id'], ['x']))).toBe('GRANT_SCOPE_OVERRIDE');
  });
});

describe('joined targets', () => {
  it('reach a child through its grant-scoped parent and refuse a request-bound org or mode', async () => {
    const { s, route, member } = await setup('g-joined');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    const attempt = (where: Record<string, string>) => () =>
      g.joined('scan_event_templates', { where, delete: true });
    for (const key of ['org_id', 'mode'])
      expect(attempt({ [key]: 'x' })).toThrow(/grant supplies it/);
    expect(attempt({ template_id: 'none' })).not.toThrow();
    await g.commit();
    expect(s.event.id).toBeTruthy();
  });

  it('applies only when the parent is in the grant tenant', async () => {
    const { s, route, member } = await setup('g-joined2');
    const other = await setup('g-joined2-other');
    const tpl = s.template.resolved.id;
    await run(db, 'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)', [
      other.s.event.id,
      tpl,
    ]);
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    g.joined('scan_event_templates', {
      where: { template_id: tpl },
      delete: true,
    });
    const [r] = await g.commit();
    expect(r?.meta.changes).toBe(0);
    expect(
      (
        await first<{ n: number }>(
          db,
          'SELECT count(*) AS n FROM scan_event_templates WHERE event_id = ?',
          [other.s.event.id],
        )
      )?.n,
    ).toBe(1);
  });
});

describe('refusals', () => {
  it('abort the whole batch with a classified reason and leave nothing behind', async () => {
    const { s, route, member } = await setup('g-deny');
    const before = await rowVersion(s.pass.id);
    const cases: [string, Parameters<typeof grant>[1], string, number][] = [
      [
        'stale',
        {
          purpose: 'org_mode.pass.publish',
          principal: member(),
          checks: passRow(s.pass.id, before + 100),
          codes: { stale: 'PASS_CHANGED' },
        },
        'PASS_CHANGED',
        409,
      ],
      [
        'lineage',
        { purpose: 'org_mode.pass.publish', principal: member(), checks: passRow('missing-pass') },
        'LINEAGE_CHANGED',
        409,
      ],
      [
        'config',
        {
          purpose: 'org_mode.scan.update',
          principal: member(),
          checks: [epochIs('scan_events', s.event.id, 'config_epoch', 999)],
        },
        'SCAN_CONFIG_CHANGED',
        409,
      ],
      [
        'release',
        {
          purpose: 'org_mode.pass.publish',
          principal: member(),
          checks: [rawCheck('release', 'EXISTS (SELECT 1 WHERE 0)')],
        },
        'TEMPLATE_RELEASE_CHANGED',
        409,
      ],
      [
        'retention',
        {
          purpose: 'org_mode.pass.publish',
          principal: member(),
          checks: [rawCheck('retention', 'EXISTS (SELECT 1 WHERE 0)')],
        },
        'RETENTION_CHANGED',
        409,
      ],
      [
        'actor',
        {
          purpose: 'org_mode.pass.publish',
          principal: {
            kind: 'membership',
            membershipId: 'nobody',
            mode: 'live',
            via: 'deferred',
            userAccessRevision: 1,
            allowRequestContext: true,
            orgAccessRevision: 1,
          },
        },
        'ACTOR_CHANGED',
        403,
      ],
      [
        'org',
        { purpose: 'org_mode.pass.publish', principal: member(), checks: [orgRevision(999)] },
        'ORG_ACCESS_CHANGED',
        403,
      ],
    ];
    for (const [name, input, code, status] of cases) {
      const g = grant(route, input);
      g.update('passes', { set: { display_title: `denied-${name}` }, where: { id: s.pass.id } });
      const error = await refused(g.commit());
      expect([name, error.code, error.status]).toEqual([name, code, status]);
      expect((await title(s.pass.id))?.t, name).not.toBe(`denied-${name}`);
      expect(await grants()).toBe(0);
    }
  });

  it('check membership, user and session state: revoked, disabled, signed out', async () => {
    const { s, route, member } = await setup('g-actor');
    const idHash = await sha256Hex(s.session.cookieValue);
    const run1 = async (input: Parameters<typeof member>[0] = {}) => {
      const g = grant(route, { purpose: 'org_mode.pass.publish', principal: member(input) });
      g.update('passes', { set: { display_title: 'ok' }, where: { id: s.pass.id } });
      return g.commit();
    };
    await expect(run1({ sessionIdHash: idHash })).resolves.toBeDefined();
    await run(db, 'UPDATE sessions SET revoked_at = 1 WHERE id_hash = ?', [idHash]);
    expect((await refused(run1({ sessionIdHash: idHash }))).code).toBe('ACTOR_CHANGED');
    await expect(run1()).resolves.toBeDefined();
    await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [s.user.id]);
    expect((await refused(run1())).code).toBe('ACTOR_CHANGED');
    await run(db, "UPDATE users SET status = 'active' WHERE id = ?", [s.user.id]);
    await run(db, 'UPDATE org_memberships SET revoked_at = 5 WHERE id = ?', [s.membershipId]);
    expect((await refused(run1())).code).toBe('ACTOR_CHANGED');
  });

  it('deny precedence: org beats actor beats config beats lineage beats stale', async () => {
    const { s, route, member } = await setup('g-precedence');
    const bad = [
      epochIs('scan_events', s.event.id, 'config_epoch', 999),
      ...passRow('missing-pass'),
      rowIs('passes', s.pass.id, { row_version: 999 }, 'stale'),
    ];
    const reason = async (principal: Parameters<typeof grant>[1]['principal'], checks = bad) => {
      const g = grant(route, { purpose: 'org_mode.pass.publish', principal, checks });
      g.update('passes', { set: { display_title: 'p' }, where: { id: s.pass.id } });
      return (await refused(g.commit())).code;
    };
    expect(await reason(member())).toBe('SCAN_CONFIG_CHANGED');
    expect(await reason(member(), bad.slice(1))).toBe('LINEAGE_CHANGED');
    expect(await reason(member(), bad.slice(2))).toBe('STALE');
    await run(db, 'UPDATE org_memberships SET revoked_at = 5 WHERE id = ?', [s.membershipId]);
    expect(await reason(member())).toBe('ACTOR_CHANGED');
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [s.org.id]);
    expect(await reason(member())).toBe('ORG_ACCESS_CHANGED');
  });

  it('staff drift is its own 409 between actor and config, and ahead of stale', async () => {
    const { s, route, member } = await setup('g-staff');
    const staff = rawCheck('staff', '0');
    const reason = async (
      checks: Parameters<typeof grant>[1]['checks'],
      codes?: Record<string, string>,
    ) => {
      const g = grant(route, {
        purpose: 'org_mode.pass.publish',
        principal: member(),
        ...(checks ? { checks } : {}),
        ...(codes ? { codes } : {}),
      });
      g.update('passes', { set: { display_title: 'p' }, where: { id: s.pass.id } });
      const error = await refused(g.commit());
      return [error.status, error.code];
    };
    const stale = rowIs('passes', s.pass.id, { row_version: 999 }, 'stale');
    const config = epochIs('scan_events', s.event.id, 'config_epoch', 999);
    expect(await reason([stale, staff])).toEqual([409, 'SCAN_STAFF_CHANGED']);
    expect(await reason([config, staff])).toEqual([409, 'SCAN_STAFF_CHANGED']);
    expect(await reason([stale, staff], { staff: 'OTHER' })).toEqual([409, 'OTHER']);
    // Pass staleness keeps its own code next to a staff check that holds.
    expect(await reason([stale], { stale: 'PASS_CHANGED' })).toEqual([409, 'PASS_CHANGED']);
    await run(db, 'UPDATE org_memberships SET revoked_at = 5 WHERE id = ?', [s.membershipId]);
    expect(await reason([staff])).toEqual([403, 'ACTOR_CHANGED']);
  });

  it('a suspended org is refused, and suspend then reactivate invalidates a captured revision', async () => {
    const { s, route, member } = await setup('g-suspend');
    const captured =
      (
        await first<{ r: number }>(db, 'SELECT access_revision AS r FROM orgs WHERE id = ?', [
          s.org.id,
        ])
      )?.r ?? 0;
    const send = async () => {
      const g = grant(route, {
        purpose: 'org_mode.pass.publish',
        principal: member({ orgAccessRevision: captured }),
      });
      g.update('passes', { set: { display_title: 'q' }, where: { id: s.pass.id } });
      return g.commit();
    };
    await expect(send()).resolves.toBeDefined();
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [s.org.id]);
    expect((await refused(send())).code).toBe('ORG_ACCESS_CHANGED');
    await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [s.org.id]);
    expect((await refused(send())).code).toBe('ORG_ACCESS_CHANGED');
  });
});

describe('statements stay inside their batch', () => {
  it('a granted statement cannot run, bind or be committed by another grant', async () => {
    const { s, route, member } = await setup('g-outside');
    const a = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    const b = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    const stmt = a.update('passes', { set: { display_title: 'x' }, where: { id: s.pass.id } });
    for (const call of [() => stmt.run(), () => stmt.first(), () => stmt.all(), () => stmt.bind()])
      expect(call).toThrow(/inside its grant batch/);
    await expect(env.DB.batch([stmt as never])).rejects.toThrow();
    expect(() => b.add(stmt)).toThrow(/different grant/);
    expect((await title(s.pass.id))?.t).not.toBe('x');
    await a.commit();
    await expect(a.commit()).rejects.toThrow(/committed/);
    expect(() =>
      a.update('passes', { set: { display_title: 'y' }, where: { id: s.pass.id } }),
    ).toThrow(/committed/);
  });

  it('several grants commit in one transaction; one refusal rolls back all', async () => {
    const { s, route, member } = await setup('g-multi');
    const ok = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    ok.update('passes', { set: { display_title: 'multi' }, where: { id: s.pass.id } });
    const bad = grant(route, {
      purpose: 'org_mode.pass.publish',
      principal: member(),
      checks: passRow('missing'),
    });
    bad.update('passes', { set: { display_title: 'never' }, where: { id: s.pass.id } });
    await expect(grantedBatch(db, [ok, bad])).rejects.toBeInstanceOf(AppError);
    expect((await title(s.pass.id))?.t).not.toBe('multi');
    const a = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    a.update('passes', { set: { display_title: 'one' }, where: { id: s.pass.id } });
    const c = grant(route, {
      purpose: 'org.settings.update',
      principal: member({ mode: undefined }),
    });
    c.insertSelect('settings', ['key', 'value', 'updated_at'], ['wp0.multi', '1', 1]);
    const [ra, rc] = await grantedBatch(db, [a, c]);
    expect([ra?.length, rc?.length]).toEqual([1, 1]);
    expect(await grants()).toBe(0);
  });

  it('a grant whose delete is missing fails at commit (deferred sentinel foreign key)', async () => {
    const { s, route, member } = await setup('g-sentinel');
    const g = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    g.update('passes', { set: { display_title: 'leaky' }, where: { id: s.pass.id } });
    const [insert, write] = prepareGrantForTest(g);
    await expect(
      db.batch([insert as D1PreparedStatement, write as D1PreparedStatement]),
    ).rejects.toThrow();
    expect(await grants()).toBe(0);
    expect((await title(s.pass.id))?.t).not.toBe('leaky');
  });
});

describe('who may mint which grant', () => {
  it('a route context cannot mint a system grant; a job context can', async () => {
    const { s, ctx, route } = await setup('g-system');
    const input = {
      job: 'wp0.test',
      purpose: 'org_mode.job.cleanup',
      orgId: s.org.id,
      mode: 'live' as const,
    };
    expect(() => jobGrant(route, input)).toThrow(/queue, cron or workflow/);
    expect(() =>
      grant(ctx, {
        purpose: 'org_mode.job.cleanup',
        principal: { kind: 'system', job: 'x', orgId: s.org.id, mode: 'live' },
      }),
    ).toThrow(/jobGrant/);
    const g = jobGrant(ctx, input);
    g.update('passes', { set: { display_title: 'job' }, where: { id: s.pass.id } });
    await g.commit();
    expect((await title(s.pass.id))?.t).toBe('job');
    const suspended = jobGrant(ctx, { ...input, orgAccessRevision: 999 });
    suspended.update('passes', { set: { display_title: 'job2' }, where: { id: s.pass.id } });
    expect((await refused(suspended.commit())).code).toBe('ORG_ACCESS_CHANGED');
  });

  it('system purposes must be job purposes (CHECK) and membership cannot hold platform scope', async () => {
    const { s, ctx, route, member } = await setup('g-purpose');
    // JS refuses a non-job purpose with a classified error before the CHECK is reached...
    const bad = () =>
      jobGrant(ctx, { job: 'x', purpose: 'org_mode.pass.publish', orgId: s.org.id, mode: 'live' });
    expect(bad).toThrow(/names a job/);
    try {
      bad();
    } catch (e) {
      expect((e as AuthorityError).code).toBe('GRANT_BAD_PURPOSE');
    }
    // ...and the CHECK still refuses a system principal on a non-job purpose.
    await expect(
      run(
        db,
        `INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, created_at, leak_guard)
         VALUES ('sys-1', 'org_mode', ?, 'live', 'system:x', 'org_mode.pass.publish', 1, 'sys-1')`,
        [s.org.id],
      ),
    ).rejects.toThrow(/CHECK|constraint/i);
    expect(() => grant(route, { purpose: 'platform.org.status', principal: member() })).toThrow(
      /platform grant/,
    );
    expect(() => grant(route, { purpose: 'bogus', principal: member() })).toThrow(
      /Bad grant purpose/,
    );
    expect(() =>
      grant(route, {
        purpose: 'org_mode.pass.x',
        principal: {
          kind: 'membership',
          membershipId: 'm',
          via: 'deferred',
          userAccessRevision: 1,
          orgAccessRevision: 1,
          allowRequestContext: true,
        },
      }),
    ).toThrow(/needs a mode/);
  });

  it('connection purposes require live mode', async () => {
    const { route, member } = await setup('g-connection');
    const g = grant(route, {
      purpose: 'org_mode.connection.sync',
      principal: member({ mode: 'test' }),
    });
    g.update('connections', { set: { name: 'x' }, where: { id: 'c' } });
    await expect(g.commit()).rejects.toThrow(/CHECK|constraint/i);
  });
});

describe('other principals', () => {
  it('platform admin sessions: org target from the row, non-admin refused, platform scope has no org', async () => {
    const { s, route } = await setup('g-platform');
    const idHash = await sha256Hex(s.adminSession.cookieValue);
    const principal = {
      kind: 'platform',
      userId: s.admin.id,
      sessionIdHash: idHash,
      orgId: s.org.id,
    } as const;
    const g = grant(route, { purpose: 'org.settings.update', principal });
    g.insertSelect('settings', ['key', 'value', 'updated_at'], ['wp0.platform', '1', 1]);
    await g.commit();
    expect(
      (await first<{ scope: string }>(db, "SELECT scope FROM settings WHERE key = 'wp0.platform'"))
        ?.scope,
    ).toBe(`org:${s.org.id}`);
    const global = grant(route, {
      purpose: 'platform.org.status',
      principal: { kind: 'platform', userId: s.admin.id, sessionIdHash: idHash },
    });
    global.update('orgs', { set: { status: 'suspended' }, where: { id: s.org.id } });
    await global.commit();
    expect(
      (await first<{ status: string }>(db, 'SELECT status FROM orgs WHERE id = ?', [s.org.id]))
        ?.status,
    ).toBe('suspended');
    const plain = grant(route, {
      purpose: 'platform.org.status',
      principal: {
        kind: 'platform',
        userId: s.user.id,
        sessionIdHash: await sha256Hex(s.session.cookieValue),
      },
    });
    plain.update('orgs', { set: { status: 'active' }, where: { id: s.org.id } });
    expect((await refused(plain.commit())).code).toBe('ACTOR_CHANGED');
    const missing = grant(route, {
      purpose: 'org.settings.update',
      principal: { ...principal, orgId: 'no-such-org' },
    });
    missing.insertSelect('settings', ['key', 'value', 'updated_at'], ['wp0.none', '1', 1]);
    expect((await refused(missing.commit())).code).toBe('ORG_ACCESS_CHANGED');
  });

  it('api keys take org and mode from the key row; revoked and expired keys are refused', async () => {
    const { s, route } = await setup('g-key');
    const send = async () => {
      const g = grant(route, {
        purpose: 'org_mode.pass.publish',
        principal: { kind: 'api_key', keyId: s.key.id, scope: 'passes:write' },
      });
      g.update('passes', { set: { display_title: 'key' }, where: { id: s.pass.id } });
      return g.commit();
    };
    await send();
    expect((await title(s.pass.id))?.t).toBe('key');
    await run(db, 'UPDATE api_keys SET revoked_at = 5 WHERE id = ?', [s.key.id]);
    expect((await refused(send())).code).toBe('ACTOR_CHANGED');
    const platformKey = grant(route, {
      purpose: 'platform.org.status',
      principal: { kind: 'api_key', keyId: s.key.id, scope: 'passes:write' },
    });
    platformKey.update('orgs', { set: { status: 'active' }, where: { id: s.org.id } });
    expect((await refused(platformKey.commit())).status).toBe(403);
  });

  it('scanners: a rotated credential is a re-pair (401), a config change is a 409', async () => {
    const { s, route } = await setup('g-scanner');
    const epoch = async (c: string) =>
      (
        await first<Record<string, number>>(db, `SELECT ${c} AS v FROM scanners WHERE id = ?`, [
          s.scannerId,
        ])
      )?.v ?? 0;
    const credential = await epoch('credential_epoch');
    const config = await epoch('config_epoch');
    const g = (cred: number, cfg: number) => {
      const x = grant(route, {
        purpose: 'org_mode.scan.checkin',
        principal: { kind: 'scanner', scannerId: s.scannerId, credentialEpoch: cred },
        checks: [epochIs('scanners', s.scannerId, 'config_epoch', cfg)],
      });
      x.update('scanners', { set: { last_seen_at: 5 }, where: { id: s.scannerId } });
      return x.commit();
    };
    await expect(g(credential, config)).resolves.toBeDefined();
    expect(await g(credential + 9, config).catch((e) => [e.status, e.code])).toEqual([
      401,
      'SCANNER_REPAIR',
    ]);
    expect(await g(credential, config + 9).catch((e) => [e.status, e.code])).toEqual([
      409,
      'SCAN_CONFIG_CHANGED',
    ]);
    await run(db, "UPDATE scanners SET time_zone = 'Asia/Tokyo' WHERE id = ?", [s.scannerId]);
    expect(await g(credential, config).catch((e) => e.code)).toBe('SCAN_CONFIG_CHANGED');
  });
});

describe('statement corpus', () => {
  it('compiles on D1 and stays within budget for every principal kind with a full check mix', async () => {
    const { s, route, member } = await setup('g-corpus');
    const idHash = await sha256Hex(s.session.cookieValue);
    const adminHash = await sha256Hex(s.adminSession.cookieValue);
    const at = async (table: string, id: string, column: string) =>
      (
        await first<Record<string, number>>(
          db,
          `SELECT ${column} AS v FROM ${table} WHERE id = ?`,
          [id],
        )
      )?.v ?? 0;
    const fresh = async () => [
      ...passRow(s.pass.id, await rowVersion(s.pass.id)),
      epochIs(
        'scan_events',
        s.event.id,
        'config_epoch',
        await at('scan_events', s.event.id, 'config_epoch'),
      ),
      epochIs(
        'scan_staff',
        s.staff.id,
        'auth_epoch',
        await at('scan_staff', s.staff.id, 'auth_epoch'),
      ),
      epochIs(
        'scanning_sessions',
        s.scanningSessionId,
        'config_epoch',
        await at('scanning_sessions', s.scanningSessionId, 'config_epoch'),
      ),
      orgRevision(await at('orgs', s.org.id, 'access_revision')),
    ];
    const principals = {
      membership: member({
        sessionIdHash: idHash,
        orgAccessRevision: await at('orgs', s.org.id, 'access_revision'),
      }),
      api_key: { kind: 'api_key', keyId: s.key.id, scope: 'passes:write' } as const,
      scanner: {
        kind: 'scanner',
        scannerId: s.scannerId,
        credentialEpoch: await at('scanners', s.scannerId, 'credential_epoch'),
      } as const,
      platform: {
        kind: 'platform',
        userId: s.admin.id,
        sessionIdHash: adminHash,
        orgId: s.org.id,
        mode: 'live',
      } as const,
    };
    const numbers: Record<string, unknown> = {};
    for (const [kind, principal] of Object.entries(principals)) {
      const g = grant(route, {
        purpose: 'org_mode.pass.publish',
        principal,
        checks: await fresh(),
      });
      g.update('passes', { set: { display_title: `corpus-${kind}` }, where: { id: s.pass.id } });
      numbers[kind] = g.inspect();
      const { grant: gs, writes } = g.inspect();
      expect(gs.params, kind).toBeLessThanOrEqual(90);
      expect(gs.bytes, kind).toBeLessThan(32 * 1024);
      for (const w of writes) expect(w.params).toBeLessThanOrEqual(40);
      await g.commit();
      expect((await title(s.pass.id))?.t, kind).toBe(`corpus-${kind}`);
    }
    // Recorded in the design doc (WP0 spike results): tenant grants bind 19-23 values and stay under 1.8 KB.
    for (const n of Object.values(numbers) as { grant: { params: number; bytes: number } }[]) {
      expect(n.grant.params).toBeLessThanOrEqual(25);
      expect(n.grant.bytes).toBeLessThan(2000);
    }
  });

  it('enforces the write and size budgets', async () => {
    const { route, member } = await setup('g-budget');
    const g = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    const wide = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`c${i}`, i]));
    expect(() => g.update('passes', { set: wide, where: { id: 'x' } })).toThrow(
      /SQL_BIND_BUDGET|binds/,
    );
    const checks = Array.from({ length: 95 }, (_, i) =>
      rawCheck('stale', 'EXISTS (SELECT 1 WHERE ? = ?)', [i, i]),
    );
    expect(() =>
      grant(route, { purpose: 'org_mode.pass.publish', principal: member(), checks }),
    ).toThrow(/binds/);
  });
});

describe('leaks and reads', () => {
  it('a grant row left behind is detected, removed, and swept', async () => {
    const { s, ctx } = await setup('g-leak');
    await insertLeakedGrant(db, {
      id: 'leak-1',
      scope: 'org_mode',
      orgId: s.org.id,
      mode: 'live',
      purpose: 'org_mode.pass.publish',
    });
    await expect(assertNoLeakedGrants(db)).rejects.toThrow(/AUTHORITY_GRANT_LEAK/);
    expect(await grants()).toBe(0);
    await insertLeakedGrant(db, {
      id: 'leak-2',
      scope: 'org',
      orgId: s.org.id,
      mode: null,
      purpose: 'org.settings.update',
    });
    const lines: string[] = [];
    const logged = { ...ctx, log: createLogger({}, { sink: (l) => lines.push(l) }) };
    expect(await sweepLeakedGrants(logged)).toBe(1);
    expect(lines.join('')).toContain('AUTHORITY_GRANT_LEAK');
    expect(await sweepLeakedGrants(logged)).toBe(0);
  });

  it('grant rows are immutable', async () => {
    await expect(
      run(db, "UPDATE authority_grants SET purpose = 'x' WHERE id = 'none'"),
    ).resolves.toBeDefined();
    await insertLeakedGrant(db, {
      id: 'imm-1',
      scope: 'platform',
      orgId: null,
      mode: null,
      purpose: 'platform.org.status',
    });
    await expect(
      run(db, "UPDATE authority_grants SET purpose = 'platform.x.y' WHERE id = 'imm-1'"),
    ).rejects.toThrow(/immutable/);
    await assertNoLeakedGrants(db).catch(() => undefined);
  });

  it('authorityPredicate allows an active member and refuses revoked or suspended ones, without writing', async () => {
    const { s, member } = await setup('g-read');
    const now = s.f.clock.now();
    const ask = async (principal: ReturnType<typeof member>) => {
      const p = authorityPredicate(principal, {
        scope: 'org_mode',
        now,
        checks: passRow(s.pass.id),
      });
      const row = await first<{ org_id: string; mode: string }>(
        db,
        `WITH ${p.ctes} SELECT org_id, mode FROM actor_ok`,
        p.params,
      );
      return row;
    };
    expect(await ask(member())).toEqual({ org_id: s.org.id, mode: 'live' });
    expect(await grants()).toBe(0);
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [s.org.id]);
    expect(await ask(member())).toBeNull();
    await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [s.org.id]);
    await run(db, 'UPDATE org_memberships SET revoked_at = 5 WHERE id = ?', [s.membershipId]);
    expect(await ask(member())).toBeNull();
  });
});
