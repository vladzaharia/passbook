import {
  SETUP_ITEMS,
  type SetupItem,
  type SetupItemKey,
} from '../../../shared/contracts/idp-setup.ts';
import { AppError } from '../../platform/errors.ts';
import type { IdpHealth, SetupStatus } from './types.ts';

/** A push from Polaris ID with the active token this recent counts as a working sync. */
export const PUSH_FRESH_MS = 25 * 3_600_000;

/** What the matrix needs: one health read, one setup read, the token table and the directory mirror. */
export interface SetupFacts {
  health: IdpHealth;
  status: SetupStatus;
  token: { active: boolean; lastAuthAt: number | null };
  mirror: { users: number; groups: number };
  now: number;
}

/** The item a later one waits for. */
const DEPS: Partial<Record<SetupItemKey, SetupItemKey>> = {
  polaris_settings: 'binding',
  client: 'polaris_settings',
  groups: 'client',
  client_groups: 'groups',
  client_restricted: 'client_groups',
  client_logo: 'client_restricted',
  scim_token: 'client_restricted',
  scim_provider: 'client_restricted',
  scim_sync: 'scim_provider',
  scim_mirror: 'scim_sync',
  write_mode: 'binding',
};

type Own = Omit<SetupItem, 'key'>;
const done = (more: Partial<Own> = {}): Own => ({ status: 'done', ...more });
const needed = (more: Partial<Own> = {}): Own => ({ status: 'needed', ...more });
const blocked = (reason: string, owner = true, more: Partial<Own> = {}): Own => ({
  status: 'blocked',
  reason,
  ...(owner ? { owner } : {}),
  ...more,
});

function groupsItem(status: SetupStatus): Own {
  const roles = Object.entries(status.roles);
  const inUse = roles.find(([, s]) => s === 'in_use');
  if (inUse) return blocked(`group_in_use:${inUse[0]}`);
  const missing = roles.find(([, s]) => s === 'missing');
  if (missing)
    return blocked(
      missing[0] === 'platform_admin' ? 'admin_group_missing' : `group_missing:${missing[0]}`,
    );
  const rows = roles.map(([key, s]) => ({
    key,
    state: s === 'placed' ? ('placed' as const) : ('needed' as const),
  }));
  const placed = rows.filter((r) => r.state === 'placed').length;
  const counts = { placed, total: rows.length };
  return placed === rows.length ? done({ counts, rows }) : needed({ counts, rows });
}

function clientGroupsItem(f: SetupFacts): Own {
  const c = f.status.client;
  const aliases = c.aliases.filter((a) => a.exists);
  const allowed = c.missingRoles.length === 0 && aliases.every((a) => a.allowed);
  const rows = [
    ...Object.keys(f.status.roles).map((key) => ({
      key,
      state: c.missingRoles.includes(key) ? ('needed' as const) : ('allowed' as const),
    })),
    // The binding allows an alias group that exists and never writes it: a row to see, not a placement.
    ...aliases.map((a) => ({
      key: a.name,
      state: a.allowed ? ('allowed' as const) : ('needed' as const),
    })),
  ];
  const counts = {
    missing: c.missingRoles.length + aliases.filter((a) => !a.allowed).length,
    other: c.otherGroups,
  };
  return allowed ? done({ counts, rows }) : needed({ counts, rows });
}

function clientItem(c: SetupStatus['client']): Own {
  if (!c.found) return blocked('client_not_found');
  if (!c.cimd) return blocked('client_not_cimd');
  if (!c.ours) return blocked('client_not_ours');
  if (!c.callbacksOurs) return blocked('client_foreign_callbacks');
  return done();
}

function ownItems(f: SetupFacts): Record<SetupItemKey, Own> {
  const { health, status, token, mirror } = f;
  const c = status.client;
  const s = status.scim;
  const pushed = token.lastAuthAt !== null && f.now - token.lastAuthAt < PUSH_FRESH_MS;
  return {
    binding: health.frozen
      ? blocked('frozen')
      : health.layoutSuspect
        ? blocked('layout_suspect')
        : done(),
    polaris_settings:
      health.unsafe.length > 0
        ? blocked(health.unsafe[0] ?? 'unsafe', true, { counts: { reasons: health.unsafe.length } })
        : done(),
    client: clientItem(c),
    groups: groupsItem(status),
    client_groups: clientGroupsItem(f),
    client_restricted: c.restricted ? done() : needed(),
    client_logo: c.logo && c.darkLogo ? done() : needed(),
    scim_token: token.active ? done() : needed(),
    scim_provider:
      s.exists && !s.endpointOk
        ? blocked('scim_endpoint_foreign')
        : s.exists && s.token === 0
          ? done()
          : needed(),
    scim_sync: pushed ? done() : needed(),
    scim_mirror:
      mirror.users > 0 && mirror.groups > 0
        ? done({ counts: mirror })
        : blocked('scim_mirror_empty', false, { counts: mirror }),
    write_mode: done({ note: health.mode }),
  };
}

/**
 * The item matrix. An item whose predecessor is not done is `needed` with `after:<key>`: its own state says
 * nothing yet (a blocked group read means little before the client is found).
 */
export function buildItems(own: Record<SetupItemKey, Own>): SetupItem[] {
  const out = new Map<SetupItemKey, SetupItem>();
  for (const key of SETUP_ITEMS) {
    const dep = DEPS[key];
    const waits = dep !== undefined && out.get(dep)?.status !== 'done';
    out.set(key, { key, ...(waits ? needed({ reason: `after:${dep}` }) : own[key]) });
  }
  return [...out.values()];
}

export const itemsOf = (f: SetupFacts): SetupItem[] => buildItems(ownItems(f));

/** The binding is missing, refused or not answering: every item waits for it. */
export function bindingDown(reason: string, owner: boolean): SetupItem[] {
  const own = Object.fromEntries(SETUP_ITEMS.map((k) => [k, needed()])) as Record<
    SetupItemKey,
    Own
  >;
  own.binding = blocked(reason, owner);
  return buildItems(own);
}

/** The stop an operation fails with for a blocked item. The sentences are the kind's catalog; reasons are stable words, never ids. */
export function blockError(item: SetupItem): AppError {
  const reason = (item.reason ?? '').split(':')[0];
  if (item.key === 'polaris_settings')
    return new AppError('IDP_SETUP_SETTINGS', 409, 'Polaris ID settings need a change.');
  switch (reason) {
    case 'binding_absent':
      return new AppError('IDP_SETUP_BINDING_ABSENT', 409, 'The connector is not deployed.');
    case 'idp_auth':
      return new AppError('IDP_SETUP_AUTH', 409, 'Polaris ID refused the key.');
    case 'binding_unreachable':
      return new AppError('IDP_UNAVAILABLE', 503, 'Polaris ID is not reachable.');
    case 'layout_suspect':
      return new AppError('IDP_SETUP_LAYOUT', 409, 'The layout looks wrong.');
    case 'frozen':
      return new AppError('IDP_FROZEN', 503, 'Polaris ID changes are paused.');
    case 'client_not_found':
      return new AppError('IDP_SETUP_CLIENT_MISSING', 409, 'The app does not exist yet.');
    case 'group_in_use':
      return new AppError('IDP_SETUP_GROUP_IN_USE', 409, 'A role group is in use.');
    case 'admin_group_missing':
    case 'group_missing':
      return new AppError('IDP_SETUP_GROUP_MISSING', 409, 'A required group is missing.');
    case 'scim_endpoint_foreign':
      return new AppError('IDP_SCIM_FOREIGN', 409, 'The user sync points elsewhere.');
    case 'scim_mirror_empty':
      return new AppError('IDP_SETUP_MIRROR_EMPTY', 409, 'No users or groups arrived.');
    default:
      return new AppError('IDP_SETUP_CLIENT_WRONG', 409, 'The app is not set up as expected.');
  }
}
