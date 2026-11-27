// The admin console's scope lives in the URL: /admin/platform/..., /admin/o/$orgId/... or
// /admin/all/passes (the caller's readable organizations together).
// Pure helpers only: route configs load this with the entry chunk.

export type AdminScope = { kind: 'platform' } | { kind: 'all' } | { kind: 'org'; orgId: string };

export const PLATFORM: AdminScope = { kind: 'platform' };
export const PLATFORM_ROOT = '/admin/platform';
export const ALL: AdminScope = { kind: 'all' };
export const ALL_ROOT = '/admin/all';
const ORG_PATH = /^\/admin\/o\/([^/]+)(\/.*)?$/;

const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

export function orgPath(orgId: string, rest = ''): string {
  return `/admin/o/${encodeURIComponent(orgId)}${rest}`;
}

export function platformPath(rest = ''): string {
  return `${PLATFORM_ROOT}${rest}`;
}

export function allPath(rest = ''): string {
  return `${ALL_ROOT}${rest}`;
}

export function scopePath(scope: AdminScope, rest = ''): string {
  if (scope.kind === 'platform') return platformPath(rest);
  return scope.kind === 'all' ? allPath(rest) : orgPath(scope.orgId, rest);
}

export interface ParsedAdminPath {
  /** Undefined outside a scope: /admin, /admin/account, legacy paths. */
  scope?: AdminScope;
  /** The path inside the scope ('' for its overview), or the whole path when unscoped. */
  rest: string;
}

export function parseAdminPath(pathname: string): ParsedAdminPath {
  const path = trim(pathname);
  if (path === PLATFORM_ROOT || path.startsWith(`${PLATFORM_ROOT}/`)) {
    return { scope: PLATFORM, rest: path.slice(PLATFORM_ROOT.length) };
  }
  if (path === ALL_ROOT || path.startsWith(`${ALL_ROOT}/`)) {
    return { scope: ALL, rest: path.slice(ALL_ROOT.length) };
  }
  const match = ORG_PATH.exec(path);
  if (!match?.[1]) return { rest: path };
  try {
    return { scope: { kind: 'org', orgId: decodeURIComponent(match[1]) }, rest: match[2] ?? '' };
  } catch {
    return { rest: path };
  }
}

/** Storage form: 'platform', 'all' or 'org:<id>'. */
export function scopeKey(scope: AdminScope): string {
  if (scope.kind === 'platform') return 'platform';
  return scope.kind === 'all' ? 'all' : `org:${scope.orgId}`;
}

export function parseScopeKey(raw: string | null | undefined): AdminScope | undefined {
  if (raw === 'platform') return PLATFORM;
  if (raw === 'all') return ALL;
  const orgId = raw?.startsWith('org:') ? raw.slice(4) : undefined;
  return orgId && orgId.length <= 100 ? { kind: 'org', orgId } : undefined;
}

/** The top-level section of a scoped path: '/passes/p1' → '/passes', '' → ''. */
export function sectionOf(rest: string): string {
  return /^\/[^/]+/.exec(rest)?.[0] ?? '';
}

const CREATE = /^\/[a-z-]+\/(new|upload)$/;

/** Sections both scopes have, mapped to their counterpart (Members ↔ Users). */
const COUNTERPART: Record<string, string> = {
  '': '',
  '/audit': '/audit',
  '/retention': '/retention',
  '/api-keys': '/api-keys',
  '/settings': '/settings',
  '/wallet-accounts': '/wallet-accounts',
  '/members': '/users',
  '/users': '/members',
};

/**
 * Where switching to `target` lands: the same section when the target has it and allows it
 * (details and filters drop to the list), else its overview, else the first page it allows.
 */
export function switchTarget(
  pathname: string,
  target: AdminScope,
  allowed: (path: string) => boolean,
  fallback?: string,
): string {
  // The All scope has one page; leaving it for an organization keeps Passes.
  if (target.kind === 'all') return scopePath(target, '/passes');
  const { scope, rest } = parseAdminPath(pathname);
  const section = sectionOf(rest);
  const kept =
    scope?.kind === 'all'
      ? target.kind === 'org'
        ? '/passes'
        : ''
      : scope?.kind === target.kind
        ? section
        : section in COUNTERPART
          ? COUNTERPART[section]
          : undefined;
  // Creation pages (the pass wizard choosing its organization) stay put; details do not.
  const creating = scope?.kind === target.kind && CREATE.test(rest) ? rest : undefined;
  const candidates = [creating, kept, ''].filter((s): s is string => s !== undefined);
  for (const candidate of candidates) {
    const path = scopePath(target, candidate);
    if (allowed(path)) return path;
  }
  return fallback ?? scopePath(target);
}

/** The same page under another organization (a resource's actual owner). */
export function withOrg(pathname: string, orgId: string): string | undefined {
  const { scope, rest } = parseAdminPath(pathname);
  return scope?.kind === 'org' ? orgPath(orgId, rest) : undefined;
}
