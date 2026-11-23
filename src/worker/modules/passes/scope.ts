import type { Mode } from '../../../shared/contracts/common.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';

/**
 * Who is asking, for by-id access to passes and bundles. API keys are bound to their mode: a key
 * never sees or changes the other mode. Sessions may read either mode by id but only change the
 * mode they are in.
 */
export interface PassScope {
  orgId: string | null;
  mode: Mode;
  principal: 'api_key' | 'session';
}

/** A bare org id (or null) is a system caller: no mode rule. */
export type ScopeArg = string | null | PassScope;

export function scopeOrg(scope: ScopeArg): string | null {
  return typeof scope === 'object' && scope !== null ? scope.orgId : scope;
}

/** The mode a read must match in SQL; null when any mode may be read. */
export function readMode(scope: ScopeArg): Mode | null {
  return typeof scope === 'object' && scope !== null && scope.principal === 'api_key'
    ? scope.mode
    : null;
}

/**
 * `AND <alias>.org_id = ? AND <alias>.mode = ?` for the filters the scope carries, or nothing for a
 * platform-wide system caller. Append to a WHERE that already has a condition.
 */
export function scopeAnd(scope: ScopeArg, alias = ''): { sql: string; params: string[] } {
  const col = alias ? `${alias}.` : '';
  const org = scopeOrg(scope);
  const mode = readMode(scope);
  const parts: string[] = [];
  const params: string[] = [];
  if (org !== null) {
    parts.push(` AND ${col}org_id = ?`);
    params.push(org);
  }
  if (mode !== null) {
    parts.push(` AND ${col}mode = ?`);
    params.push(mode);
  }
  return { sql: parts.join(''), params };
}

const NOUNS = {
  pass: ['Pass not found.', 'PASS_NOT_FOUND'],
  bundle: ['Bundle not found.', 'BUNDLE_NOT_FOUND'],
  broadcast: ['Message not found.', 'BROADCAST_NOT_FOUND'],
} as const;

/** Throws when a write reaches across modes: 404 for API keys, 409 MODE_MISMATCH for sessions. */
export function assertWritableMode(
  scope: ScopeArg,
  resourceMode: Mode,
  noun: keyof typeof NOUNS = 'pass',
): void {
  if (typeof scope !== 'object' || scope === null || scope.mode === resourceMode) return;
  if (scope.principal === 'api_key') throw new NotFoundError(...NOUNS[noun]);
  throw new ConflictError(
    `This ${noun} is ${resourceMode}. Switch to ${resourceMode === 'live' ? 'Live' : 'Test'} mode to change it.`,
    'MODE_MISMATCH',
  );
}
