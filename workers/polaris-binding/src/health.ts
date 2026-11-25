import type { Call } from './call.ts';
import { assertNotFrozen, isFrozen } from './freeze.ts';
import { alert, budgetUse, logRefusal, type Meta, meta } from './ledger.ts';
import { type Deps, failure, ok, type Req } from './pocket-http.ts';
import { configReasons, envReasons, HEALTH_TTL, UNSAFE_TTL } from './policy.ts';
import type { Registry } from './registry.ts';
import type { Routes } from './routes.ts';
import { type HealthCore, readHealth, writeHealth } from './store.ts';
import { type BindingEnv, type Health, IdpError, type Role } from './types.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (body: unknown): unknown[] => {
  if (Array.isArray(body)) return body;
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
};

/** Polaris ID answers settings as `[{ key, value }]`; a plain object is accepted too. */
function settings(body: unknown): Record<string, string> {
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
    allowed.length === registry.ids.length &&
    registry.ids.every((id) => allowed.includes(id));
  return exact ? [] : ['client_open'];
}

/** One read of every registry group, the settings, the key owner's keys and user, and the PassBook client. No writes. */
async function probe(env: BindingEnv, r: Routes, registry: Registry, req: Req): Promise<Probe> {
  const groups: Partial<Record<Role, string | null>> = {};
  let missing = 0;
  for (const e of registry.entries) {
    const res = await req('GET', r.group(e.id));
    if (res.status === 404) {
      groups[e.role] = null;
      missing += 1;
      continue;
    }
    if (!ok(res)) throw failure(res);
    const name = str((res.body as { name?: unknown } | null)?.name);
    if (name === null)
      throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group.');
    groups[e.role] = name;
  }
  const live = registry.entries.map(
    (e) => [e.role, groups[e.role] ?? null, e.name] as [Role, string | null, string],
  );
  // Polaris ID answers 404 for every route of the other layout, so nothing past these reads can be trusted.
  if (missing === registry.entries.length)
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
  return {
    unsafe: configReasons(settings(config.body), live),
    warnings: await clientWarnings(env, r, registry, req),
    groups,
    layoutSuspect: false,
    // Every key of the binding's own user: the nearest expiry is the one to renew.
    keyExpiresAt: expiries.length ? Math.min(...expiries) : null,
    keySubject: str((me.body as { id?: unknown } | null)?.id),
  };
}

export interface Writable {
  registry: Registry;
  /** The binding key's own user, never edited. */
  keySubject: string | null;
}

/** The cached health read and the gates every write passes: not frozen, config safe. */
export function createGate(env: BindingEnv, deps: Deps, call: Call, r: Routes) {
  const db = env.DB;
  const own = envReasons(env);

  async function currentHealth(force = false): Promise<HealthCore> {
    if (own.reasons.length || !own.registry)
      return {
        checkedAt: deps.now(),
        unsafe: own.reasons,
        warnings: [],
        groups: {},
        keyExpiresAt: null,
        keySubject: null,
        layoutSuspect: false,
      };
    const registry = own.registry;
    const cached = await readHealth(db);
    const ttl = cached?.unsafe.length ? UNSAFE_TTL : HEALTH_TTL;
    if (!force && cached && deps.now() - cached.checkedAt < ttl) return cached;
    const fresh = {
      ...(await call.ledgered('health', meta('health'), (req) => probe(env, r, registry, req))),
      checkedAt: deps.now(),
    };
    await writeHealth(db, fresh);
    return fresh;
  }

  /** Writes stop when changes are frozen, then when the settings or Polaris ID's configuration are unsafe. */
  async function requireWrite(m: Meta): Promise<Writable> {
    await assertNotFrozen(db, m, deps.now());
    const h = await currentHealth();
    if (h.unsafe.length || !own.registry) {
      await logRefusal(db, m, deps.now(), 'IDP_UNSAFE_CONFIG');
      alert('error', 'binding.unsafe_config', { method: m.method, reasons: h.unsafe });
      throw new IdpError(
        'IDP_UNSAFE_CONFIG',
        `Unsafe Polaris ID configuration: ${h.unsafe.join(', ')}.`,
      );
    }
    return { registry: own.registry, keySubject: h.keySubject };
  }

  /** The registry when the settings parse, so a request can be refused before any Polaris ID read. */
  const peek = (): Registry | null => own.registry;

  /** Reads need the registry but not a safe configuration: a missing registry is the only refusal. */
  function readable(): Registry {
    if (!own.registry)
      throw new IdpError(
        'IDP_UNSAFE_CONFIG',
        `Unsafe binding settings: ${own.reasons.join(', ')}.`,
      );
    return own.registry;
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
