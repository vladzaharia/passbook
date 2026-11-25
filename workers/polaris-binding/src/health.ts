import type { Call } from './call.ts';
import { keyKind } from './claims.ts';
import { assertNotFrozen, isFrozen } from './freeze.ts';
import { composeRegistry } from './group-state.ts';
import { alert, budgetUse, logRefusal, type Meta, meta } from './ledger.ts';
import { type Deps, failure, ok, type Req } from './pocket-http.ts';
import { configReasons, envReasons, HEALTH_TTL, UNSAFE_TTL } from './policy.ts';
import { ID, type Registry, type Settings } from './registry.ts';
import type { Routes } from './routes.ts';
import {
  abandonIntent,
  type HealthCore,
  listGroupRows,
  readHealth,
  recordAdopted,
  setGroupLive,
  writeHealth,
} from './store.ts';
import { type BindingEnv, type Health, IdpError } from './types.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (body: unknown): unknown[] => {
  if (Array.isArray(body)) return body;
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
};

/** Polaris ID answers settings as `[{ key, value }]`; a plain object is accepted too. */
function settings_(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(body)) {
    for (const item of body as { key?: unknown; value?: unknown }[]) {
      const key = str(item?.key);
      const value = str(item?.value);
      if (key !== null && value !== null) out[key] = value;
    }
  } else if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

type Probe = Omit<HealthCore, 'checkedAt'>;

/** Does the PassBook client allow exactly the registry groups? Anything else is `client_open`, a warning. */
async function clientWarnings(env: BindingEnv, r: Routes, registry: Registry, req: Req) {
  const res = await req('GET', r.client(env.PASSBOOK_CLIENT_ID));
  if (res.status === 404) return ['client_not_found'];
  if (!ok(res)) throw failure(res);
  const c = res.body as {
    isGroupRestricted?: unknown;
    allowedUserGroups?: { id?: unknown }[];
  } | null;
  const allowed = (Array.isArray(c?.allowedUserGroups) ? c.allowedUserGroups : []).map(
    (g) => g?.id,
  );
  const exact =
    c?.isGroupRestricted === true &&
    registry.ids.every((id) => allowed.includes(id)) &&
    allowed.every(
      (id) =>
        typeof id === 'string' &&
        registry.ids.concat(registry.custom.map((c) => c.id)).includes(id),
    );
  const out = exact ? [] : ['client_open'];
  // A custom group on the PassBook client would let its members sign in.
  if (registry.custom.some((c) => allowed.includes(c.id))) out.push('custom_group_on_client');
  return out;
}

const items = (body: unknown): { id?: unknown; name?: unknown; createdAt?: unknown }[] => {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group list.');
  return data as { id?: unknown; name?: unknown; createdAt?: unknown }[];
};

/**
 * A crash between the intent and its read-back leaves a pending row. Exactly one group with the exact name made
 * since the intent is the binding's own, and is recorded; none means the POST never landed. This is the only way an
 * existing group is recorded as created by the binding, and only for its own pending name.
 */
async function settlePending(db: D1Database, r: Routes, req: Req) {
  for (const row of (await listGroupRows(db)).filter((x) => x.state === 'pending')) {
    const res = await req('GET', r.groupSearch(row.name));
    if (!ok(res)) throw failure(res);
    const hits = items(res.body).filter(
      (g) =>
        g?.name === row.name &&
        typeof g.id === 'string' &&
        ID.test(g.id) &&
        Date.parse(String(g.createdAt)) >= row.createdAt - 120_000,
    );
    if (hits.length === 1) await setGroupLive(db, row.key, hits[0]?.id as string);
    else if (hits.length === 0) await abandonIntent(db, row.key);
  }
}

/** First sight of an adopted group: its name is recorded, and later writes need the live name to match. */
async function recordAdoptedNames(
  db: D1Database,
  r: Routes,
  settings: Settings,
  req: Req,
  at: number,
) {
  const known = new Set(
    (await listGroupRows(db)).filter((x) => x.kind === 'adopted').map((x) => x.key),
  );
  for (const a of settings.adopt.filter((x) => !known.has(x.key))) {
    const res = await req('GET', r.group(a.id));
    if (res.status === 404) continue;
    if (!ok(res)) throw failure(res);
    const name = str((res.body as { name?: unknown } | null)?.name);
    if (name !== null) await recordAdopted(db, a.key, a.id, name, at);
  }
}

type Compose = () => Promise<Registry>;

/** One read of every managed group, the settings, the key owner's keys and user, and the PassBook client. */
async function probe(
  env: BindingEnv,
  r: Routes,
  settings: Settings,
  compose: Compose,
  req: Req,
  deps: Deps,
): Promise<Probe> {
  await settlePending(env.DB, r, req);
  await recordAdoptedNames(env.DB, r, settings, req, deps.now());
  const registry = await compose();
  const groups: Record<string, string | null> = {};
  const live: [string, string | null, string][] = [];
  const targets = [
    ...registry.entries.map((e) => ({ label: e.role as string, id: e.id, name: e.name })),
    ...registry.custom.map((c) => ({ label: `g:${c.key}`, id: c.id, name: c.name })),
  ];
  let missing = 0;
  for (const e of targets) {
    const res = await req('GET', r.group(e.id));
    if (res.status === 404) {
      groups[e.label] ??= null;
      live.push([e.label, null, e.name]);
      missing += 1;
      continue;
    }
    if (!ok(res)) throw failure(res);
    const name = str((res.body as { name?: unknown } | null)?.name);
    if (name === null)
      throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group.');
    groups[e.label] = groups[e.label] ?? name;
    live.push([e.label, name, e.name]);
  }
  // Polaris ID answers 404 for every route of the other layout, so nothing past these reads can be trusted.
  if (missing === targets.length)
    return {
      unsafe: configReasons({}, live).filter((x) => x.startsWith('group_')),
      warnings: [],
      groups,
      layoutSuspect: true,
      keyExpiresAt: null,
      keySubject: null,
    };

  const config = await req('GET', r.config);
  if (!ok(config)) throw failure(config);
  const keys = await req('GET', r.apiKeys);
  if (!ok(keys)) throw failure(keys);
  const me = await req('GET', r.me);
  if (!ok(me)) throw failure(me);
  const expiries = list(keys.body)
    .map((k) => Date.parse(str((k as { expiresAt?: unknown } | null)?.expiresAt) ?? ''))
    .filter((t) => !Number.isNaN(t));
  const keySubject = str((me.body as { id?: unknown } | null)?.id);
  const cfg = settings_(config.body);
  const warnings = await clientWarnings(env, r, registry, req);
  for (const u of registry.unplaced) warnings.push(`role_unplaced:${u.role}`);
  if (defaultClaimsManaged(cfg.signupDefaultCustomClaims, settings.claimKeys))
    warnings.push('default_claims_managed');
  return {
    unsafe: [
      ...configReasons(cfg, live),
      // Without the key user's id the binding cannot refuse to edit it.
      ...(keySubject ? [] : ['key_user_unknown']),
    ],
    warnings,
    groups,
    layoutSuspect: false,
    // Every key of the binding's own user: the nearest expiry is the one to renew.
    keyExpiresAt: expiries.length ? Math.min(...expiries) : null,
    keySubject,
  };
}

/** Signup default claims land on every new account: one holding a managed key is a warning. */
function defaultClaimsManaged(raw: string | undefined, claimKeys: string[]): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      Array.isArray(parsed) &&
      parsed.some(
        (c) =>
          typeof (c as { key?: unknown })?.key === 'string' &&
          keyKind((c as { key: string }).key, claimKeys),
      )
    );
  } catch {
    return false;
  }
}

export interface Writable {
  registry: Registry;
  settings: Settings;
  /** The binding key's own user, never edited. */
  keySubject: string | null;
}

/** The cached health read and the gates every write passes: not frozen, config safe. */
export function createGate(env: BindingEnv, deps: Deps, call: Call, r: Routes) {
  const db = env.DB;
  const own = envReasons(env);
  const base = own.registry;
  const settings = own.settings;
  /** The registry with what the binding recorded: read fresh for each call. */
  const compose = async (): Promise<Registry> => {
    if (!base || !settings) throw new IdpError('IDP_UNSAFE_CONFIG', 'Unsafe binding settings.');
    return composeRegistry(db, base, settings);
  };

  async function currentHealth(force = false): Promise<HealthCore> {
    if (own.reasons.length || !base || !settings)
      return {
        checkedAt: deps.now(),
        unsafe: own.reasons,
        warnings: [],
        groups: {},
        keyExpiresAt: null,
        keySubject: null,
        layoutSuspect: false,
      };
    const cached = await readHealth(db);
    const ttl = cached?.unsafe.length ? UNSAFE_TTL : HEALTH_TTL;
    if (!force && cached && deps.now() - cached.checkedAt < ttl) return cached;
    const fresh = {
      ...(await call.ledgered('health', meta('health'), (req) =>
        probe(env, r, settings, compose, req, deps),
      )),
      checkedAt: deps.now(),
    };
    await writeHealth(db, fresh);
    return fresh;
  }

  /** Writes stop when changes are frozen, then when the settings or Polaris ID's configuration are unsafe. */
  async function requireWrite(m: Meta): Promise<Writable> {
    await assertNotFrozen(db, m, deps.now());
    const h = await currentHealth();
    if (h.unsafe.length || !base || !settings) {
      await logRefusal(db, m, deps.now(), 'IDP_UNSAFE_CONFIG');
      alert('error', 'binding.unsafe_config', { method: m.method, reasons: h.unsafe });
      throw new IdpError(
        'IDP_UNSAFE_CONFIG',
        `Unsafe Polaris ID configuration: ${h.unsafe.join(', ')}.`,
      );
    }
    // After the health read, so a group the read just recorded is already in.
    return { registry: await compose(), settings, keySubject: h.keySubject };
  }

  /** The static registry when the settings parse, so a request can be refused before any Polaris ID read. */
  const peek = (): Registry | null => base;

  /** Reads need the registry but not a safe configuration: a missing registry is the only refusal. */
  async function readable(): Promise<{ registry: Registry; settings: Settings }> {
    if (!base || !settings)
      throw new IdpError(
        'IDP_UNSAFE_CONFIG',
        `Unsafe binding settings: ${own.reasons.join(', ')}.`,
      );
    return { registry: await compose(), settings };
  }

  async function health(): Promise<Health> {
    const h = await currentHealth();
    const frozen = await isFrozen(db);
    const { keySubject: _k, ...core } = h;
    return {
      ...core,
      ok: h.unsafe.length === 0 && !frozen,
      layout: env.POCKET_ID_API,
      mode: env.WRITE_MODE === 'live' ? 'live' : 'dry_run',
      frozen,
      budget: await budgetUse(db, deps.now()),
    };
  }

  return { requireWrite, readable, peek, health };
}
export type Gate = ReturnType<typeof createGate>;
