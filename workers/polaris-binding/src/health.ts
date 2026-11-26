import type { Call } from './call.ts';
import { keyKind } from './claims.ts';
import { assertNotFrozen, isFrozen } from './freeze.ts';
import { aliasIds } from './group-find.ts';
import { composeRegistry, withoutBlocked } from './group-state.ts';
import { readTargets, recordAdoptedNames, settlePending } from './health-groups.ts';
import { alert, budgetUse, logRefusal, type Meta, meta } from './ledger.ts';
import { type Deps, failure, ok, type Req } from './pocket-http.ts';
import { configReasons, envReasons, HEALTH_TTL, UNSAFE_TTL } from './policy.ts';
import type { Registry, Settings } from './registry.ts';
import type { Routes } from './routes.ts';
import { type HealthCore, readHealth, writeHealth } from './store.ts';
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
  const aliases = await aliasIds(r, req, registry.aliases);
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
        registry.ids
          .concat(
            registry.custom.map((c) => c.id),
            aliases,
          )
          .includes(id),
    );
  const out = exact ? [] : ['client_open'];
  // A custom group on the PassBook client would let its members sign in.
  if (registry.custom.some((c) => allowed.includes(c.id))) out.push('custom_group_on_client');
  return out;
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
  const refused = await recordAdoptedNames(
    env.DB,
    r,
    settings,
    await compose(),
    env.GROUP_PREFIX,
    req,
    deps.now(),
  );
  const registry = await compose();
  const read = await readTargets(env.DB, r, registry, req, deps.now());
  const { groups, roles: live } = read;
  const blocked = [...new Set([...read.blocked, ...refused])];
  // Polaris ID answers 404 for every route of the other layout, so nothing past these reads can be trusted.
  if (live.length && live.every(([, name]) => name === null))
    return {
      unsafe: configReasons({}, live).filter((x) => x.startsWith('group_')),
      warnings: [],
      groups,
      blocked,
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
  // A protected role is unplaced while none of its names has an id. Admin unplaced stops every write.
  const placedRoles = new Set(registry.entries.map((e) => e.role));
  const unplacedProtected = [
    ...new Set(registry.unplacedProtected.map((u) => u.role).filter((r) => !placedRoles.has(r))),
  ];
  for (const role of unplacedProtected)
    if (role !== 'platform_admin') warnings.push(`role_unplaced:${role}`);
  if (defaultClaimsManaged(cfg.signupDefaultCustomClaims, settings.claimKeys))
    warnings.push('default_claims_managed');
  return {
    unsafe: [
      ...(unplacedProtected.includes('platform_admin') ? ['role_unplaced:platform_admin'] : []),
      ...configReasons(cfg, live),
      // Without the key user's id the binding cannot refuse to edit it.
      ...(keySubject ? [] : ['key_user_unknown']),
    ],
    warnings: [...warnings, ...blocked.map((t) => `blocked:${t}`)],
    groups,
    blocked,
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
        blocked: [],
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
    // A custom or adopted group that is renamed or gone stops only its own target.
    return {
      registry: withoutBlocked(await compose(), h.blocked),
      settings,
      keySubject: h.keySubject,
    };
  }

  /**
   * The gate of the seven setup writes: not frozen, the deployment's own settings parse, and no recorded group
   * has been renamed or deleted. Other Polaris ID configuration reasons do not block: these writes only tighten
   * PassBook's own client, and they must run before the platform admin group is placed, which is the one thing
   * that keeps every other write refused.
   */
  async function requireSetup(m: Meta): Promise<{ registry: Registry; settings: Settings }> {
    await assertNotFrozen(db, m, deps.now());
    if (own.reasons.length || !base || !settings) {
      await logRefusal(db, m, deps.now(), 'IDP_UNSAFE_CONFIG');
      throw new IdpError(
        'IDP_UNSAFE_CONFIG',
        `Unsafe binding settings: ${own.reasons.join(', ')}.`,
      );
    }
    const registry = await compose();
    // A recorded group whose live name changed (or that is gone) is no longer the group the record meant: the
    // client would be allowed, or locked to, a stranger's group. Other reasons do not block setup. With no
    // group recorded yet there is nothing to compare, so the probe is not spent.
    const stale = registry.entries.length
      ? (await currentHealth()).unsafe.filter((x) => /^group_(name_mismatch|not_found):/.test(x))
      : [];
    if (stale.length) {
      await logRefusal(db, m, deps.now(), 'IDP_UNSAFE_CONFIG');
      alert('error', 'binding.unsafe_config', { method: m.method, reasons: stale });
      throw new IdpError(
        'IDP_UNSAFE_CONFIG',
        `Unsafe Polaris ID configuration: ${stale.join(', ')}.`,
      );
    }
    return { registry, settings };
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
      transport: deps.transport ?? 'https',
      mode: env.WRITE_MODE === 'live' ? 'live' : 'dry_run',
      frozen,
      budget: await budgetUse(db, deps.now()),
    };
  }

  return { requireWrite, requireSetup, readable, peek, health };
}
export type Gate = ReturnType<typeof createGate>;
