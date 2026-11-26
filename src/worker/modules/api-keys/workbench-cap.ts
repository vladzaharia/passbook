import { WORKBENCH_KEY_MAX_MS, WORKBENCH_KEY_SCOPES } from '../../../shared/contracts/workbench.ts';
import {
  WORKBENCH_KEY_EXPIRY_COPY,
  WORKBENCH_KEY_SCOPE_COPY,
} from '../../../shared/copy/workbench-errors.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { viaToken } from '../../platform/auth-workbench.ts';
import { workbenchTestOnly } from '../../platform/errors.ts';
import { parseScopes } from './service-dto.ts';

const CAP: ReadonlySet<string> = new Set(WORKBENCH_KEY_SCOPES);

interface KeyInput {
  mode: 'live' | 'test';
  scopes: readonly string[];
  roles: readonly string[];
  expiresAt?: number | null | undefined;
}

/**
 * A key made under a Workbench token: Test (`mode` left out means Test), Test data scopes only, no role
 * presets (they expand past the cap), and an expiry within 30 days. Anything else is 403 WORKBENCH_TEST_ONLY.
 * The key must not outlive what a leaked token could do: it is short-lived and reaches no shared state.
 */
export function keyUnderToken<T extends KeyInput>(
  auth: AuthContext | undefined,
  input: T,
  modeSent: boolean,
  now: number,
): T {
  if (!viaToken(auth)) return input;
  const mode = modeSent ? input.mode : 'test';
  if (mode !== 'test') throw workbenchTestOnly();
  if (input.roles.length > 0 || input.scopes.some((s) => !CAP.has(s)))
    throw workbenchTestOnly(WORKBENCH_KEY_SCOPE_COPY);
  if (input.expiresAt == null || input.expiresAt > now + WORKBENCH_KEY_MAX_MS)
    throw workbenchTestOnly(WORKBENCH_KEY_EXPIRY_COPY);
  return { ...input, mode };
}

/** A key a token may rotate: Test, inside the scope cap, and ending within 30 days. Else it is not found. */
export function rotatableUnderToken(
  row: { mode: string; scopes: string; expires_at: number | null; roles?: string | null } | null,
  now: number,
): boolean {
  if (row?.mode !== 'test') return false;
  if (row.roles && row.roles !== '[]') return false;
  if (row.expires_at === null || row.expires_at > now + WORKBENCH_KEY_MAX_MS) return false;
  return parseScopes(row.scopes).every((s) => CAP.has(s));
}
