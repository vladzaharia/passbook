// Seed and actors of the join-once differential (authority-read-join.test.ts).
import { makeApiKey, makeOrg, makePass, makeTemplate } from '../../../test/helpers/index.ts';
import { db } from './authority-ext-fixtures.ts';
import type { GrantScope, Principal } from './authority-principal.ts';
import { world } from './authority-restrict-fixtures.ts';
import { all, run } from './db.ts';
import { sha256Hex } from './ids.ts';

export type Scope = Exclude<GrantScope, 'platform'>;
export const TABLES: { table: string; key: string; scope: Scope }[] = [
  { table: 'passes', key: 'x.id', scope: 'org_mode' },
  { table: 'pass_events', key: 'x.id', scope: 'org_mode' },
  { table: 'webhook_endpoints', key: 'x.id', scope: 'org_mode' },
  { table: 'webhook_deliveries', key: "x.endpoint_id || ':' || x.event_seq", scope: 'org_mode' },
  { table: 'scan_events', key: 'x.id', scope: 'org_mode' },
  { table: 'settings', key: "x.scope || '/' || x.key", scope: 'org' },
  { table: 'orgs', key: 'x.id', scope: 'org' },
];

let runs = 0;
export async function seed() {
  const L = `rj${++runs}`;
  const w = await world(L);
  const ident = (id: string) => `${L}-${id}`;
  const { f, org: a } = w.x.s;
  const b = await makeOrg(f);
  const template = async (
    orgId: string,
    id: string,
    styles: string[],
    modes: ('live' | 'test')[],
  ) => {
    const t = makeTemplate({ id: `${L}-${id}`, orgId });
    const passes: Record<string, string> = {};
    let first = true;
    for (const mode of modes) {
      const p = await makePass(f, { orgId, template: t.resolved, mode, persist: first });
      first = false;
      passes[mode] = p.id;
    }
    await run(db, 'UPDATE templates SET styles = ? WHERE id = ?', [
      JSON.stringify(styles),
      t.resolved.id,
    ]);
    return { id: t.resolved.id, passes };
  };
  const tt = await template(a.id, 'tt', ['storeCard'], ['live', 'test']);
  const tb = await template(b.id, 'b1', ['coupon'], ['live', 'test']);
  // Child rows of every pass and of both orgs, in both modes.
  const passIds = await all<{ id: string; org_id: string; mode: string }>(
    db,
    'SELECT id, org_id, mode FROM passes WHERE org_id IN (?, ?)',
    [a.id, b.id],
  );
  for (const p of passIds)
    await run(
      db,
      "INSERT INTO pass_events (id, org_id, pass_id, mode, kind, at) VALUES (?, ?, ?, ?, 'k', 1)",
      [`ev-${p.id}`, p.org_id, p.id, p.mode],
    );
  const endpoint = async (id: string, orgId: string, mode: string, templates: string[] | null) =>
    run(
      db,
      `INSERT INTO webhook_endpoints (id, org_id, mode, url, event_types, template_ids, api_version, created_at, updated_at)
       VALUES (?, ?, ?, 'https://example.test/h', '["pass.created"]', ?, 'v1', 1, 1)`,
      [id, orgId, mode, templates ? JSON.stringify(templates) : null],
    );
  await endpoint(ident('wh-a'), a.id, 'live', [w.a.id]);
  await endpoint(ident('wh-ab'), a.id, 'live', [w.a.id, w.b.id]);
  await endpoint(ident('wh-all'), a.id, 'live', null);
  await endpoint(ident('wh-tt'), a.id, 'test', [tt.id]);
  await endpoint(ident('wh-b'), b.id, 'live', [tb.id]);
  const delivery = async (
    endpointId: string,
    orgId: string,
    mode: string,
    templateId: string,
    passId: string,
  ) => {
    const r = await all<{ seq: number }>(
      db,
      `INSERT INTO event_feed (event_id, org_id, mode, pass_id, template_id, type, kind, data, at)
       VALUES (?, ?, ?, ?, ?, 't', 'k', '{}', 1) RETURNING seq`,
      [`${L}-evt-${endpointId}-${templateId}`, orgId, mode, passId, templateId],
    );
    await run(
      db,
      'INSERT INTO webhook_deliveries (endpoint_id, event_seq, org_id, mode) VALUES (?, ?, ?, ?)',
      [endpointId, r[0]?.seq ?? 0, orgId, mode],
    );
  };
  await delivery(ident('wh-a'), a.id, 'live', w.a.id, w.a.pass);
  await delivery(ident('wh-ab'), a.id, 'live', w.b.id, w.b.pass);
  await delivery(ident('wh-ab'), a.id, 'live', w.a.id, w.a.pass);
  await delivery(ident('wh-all'), a.id, 'live', w.c.id, w.c.pass);
  await delivery(ident('wh-tt'), a.id, 'test', tt.id, tt.passes.test ?? '');
  await delivery(ident('wh-b'), b.id, 'live', tb.id, tb.passes.live ?? '');
  for (const [orgId, mode] of [
    [a.id, 'live'],
    [a.id, 'test'],
    [b.id, 'live'],
  ] as const)
    await run(
      db,
      "INSERT INTO scan_events (id, org_id, mode, name, opens_at, closes_at, time_zone, created_at, updated_at) VALUES (?, ?, ?, 'E', 1, 2, 'UTC', 1, 1)",
      [`se-${orgId}-${mode}`, orgId, mode],
    );
  for (const o of [a, b])
    await run(
      db,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'rj.k', '1', 1)",
      [`org:${o.id}`],
    );
  return { w, f, a, b, tt, tb, ident };
}

export type Seed = Awaited<ReturnType<typeof seed>>;
export interface Actor {
  name: string;
  principal: Principal;
  scope: GrantScope;
  check?: string;
  /** A platform key's tenant: no org on the key, optionally the org it names. */
  platform?: { named?: string };
}

export async function actors(s: Seed): Promise<Actor[]> {
  const { w, f, a, b, tt } = s;
  const sx = w.x.s;
  const adminHash = await sha256Hex(sx.adminSession.cookieValue);
  const userHash = await sha256Hex(sx.session.cookieValue);
  const key = async (
    name: string,
    options: Parameters<typeof makeApiKey>[1],
    orgId?: string,
  ): Promise<Actor> => {
    const k = await makeApiKey(f, { scopes: ['passes:read', 'scans:read'], ...options });
    return {
      name,
      scope: 'org_mode',
      principal: {
        kind: 'api_key',
        keyId: k.id,
        scope: 'passes:read',
        ...(orgId ? { orgId } : {}),
      },
    };
  };
  const out: Actor[] = [
    { name: 'member live', scope: 'org_mode', principal: w.x.member() },
    { name: 'member test', scope: 'org_mode', principal: w.x.member({ mode: 'test' }) },
    {
      name: 'member session',
      scope: 'org_mode',
      principal: w.x.member({ sessionIdHash: userHash }),
    },
    {
      name: 'member stale session',
      scope: 'org_mode',
      principal: w.x.member({ sessionIdHash: 'nope' }),
    },
    { name: 'member passRow', scope: 'org_mode', principal: w.x.member(), check: 'own' },
    {
      name: 'member passRow of another org',
      scope: 'org_mode',
      principal: w.x.member(),
      check: 'other',
    },
    {
      name: 'scanner good epoch',
      scope: 'org_mode',
      principal: { kind: 'scanner', scannerId: sx.scannerId, credentialEpoch: 1 },
    },
    {
      name: 'scanner bad epoch',
      scope: 'org_mode',
      principal: { kind: 'scanner', scannerId: sx.scannerId, credentialEpoch: 99 },
    },
    {
      name: 'platform admin on org',
      scope: 'org_mode',
      principal: {
        kind: 'platform',
        userId: sx.admin.id,
        sessionIdHash: adminHash,
        orgId: a.id,
        mode: 'live',
      },
    },
    {
      name: 'platform admin on org, test',
      scope: 'org_mode',
      principal: {
        kind: 'platform',
        userId: sx.admin.id,
        sessionIdHash: adminHash,
        orgId: a.id,
        mode: 'test',
      },
    },
    {
      name: 'platform admin, no org',
      scope: 'platform',
      principal: { kind: 'platform', userId: sx.admin.id, sessionIdHash: adminHash, mode: 'live' },
    },
    {
      name: 'non-admin as platform',
      scope: 'org_mode',
      principal: {
        kind: 'platform',
        userId: sx.user.id,
        sessionIdHash: userHash,
        orgId: a.id,
        mode: 'live',
      },
    },
    {
      name: 'missing member',
      scope: 'org_mode',
      principal: {
        kind: 'membership',
        membershipId: 'nope',
        mode: 'live',
        via: 'deferred',
        orgAccessRevision: 1,
        userAccessRevision: 1,
        allowRequestContext: true,
      },
    },
    await key('org key', { orgId: a.id }),
    await key('org key, test mode', { orgId: a.id, mode: 'test' }),
    await key('one template', { orgId: a.id, templateIds: [w.a.id] }),
    await key('two templates', { orgId: a.id, templateIds: [w.a.id, w.b.id] }),
    await key('style', { orgId: a.id, passStyles: ['coupon'] }),
    await key('template and style', {
      orgId: a.id,
      templateIds: [w.b.id],
      passStyles: ['coupon', 'generic'],
    }),
    await key('test mode, limited', { orgId: a.id, mode: 'test', templateIds: [tt.id] }),
    await key('another org key, named', { orgId: b.id }, a.id),
    await key('another org key, own', { orgId: b.id }),
  ];
  const revoked = await key('revoked', { orgId: a.id });
  if (revoked.principal.kind === 'api_key')
    await run(db, 'UPDATE api_keys SET revoked_at = 5 WHERE id = ?', [revoked.principal.keyId]);
  out.push(revoked, {
    name: 'missing key',
    scope: 'org_mode',
    principal: { kind: 'api_key', keyId: 'no-such-key', scope: 'passes:read' },
  });
  for (const mode of ['live', 'test'] as const) {
    const p = await makeApiKey(f, { orgId: null, scopes: ['scans:read'], mode });
    const principal: Principal = { kind: 'api_key', keyId: p.id, scope: 'scans:read' };
    out.push(
      { name: `platform key ${mode}, all orgs`, scope: 'platform', principal, platform: {} },
      {
        name: `platform key ${mode}, named org`,
        scope: 'platform',
        principal,
        platform: { named: a.id },
      },
    );
  }
  return out;
}
