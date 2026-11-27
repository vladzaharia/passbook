import { CLI_LOGOUT_ROUTE, CLI_ROUTES, CLI_TOKEN_IDLE_MS } from '../../../shared/contracts/cli.ts';
import { hasConsoleGroup, hasDeveloperAccess } from '../../../shared/spaces.ts';
import type { KeyCaller } from '../../platform/auth.ts';
import type { AppEnv } from '../../platform/env.ts';
import { cliTokenNotAllowed, workbenchTestOnly } from '../../platform/errors.ts';
import { parseJsonArray } from '../../platform/json-column.ts';
import { createLogger } from '../../platform/log.ts';
import type { ResolvedKeyRow } from './repo.ts';
import { endCliToken } from './repo-cli.ts';

const ALLOWED: ReadonlySet<string> = new Set([...CLI_ROUTES, CLI_LOGOUT_ROUTE]);

interface CliState {
  revoked_at: number | null;
  last_roles: string | null;
  sandbox_open: number | null;
}

const roleOf = (raw: string | null): string[] =>
  raw ? parseJsonArray(raw, 'last_roles', (r): r is string => typeof r === 'string') : [];

/**
 * A CLI token's own rules, on every call. Null when it no longer holds (ended, idle, its person lost the developer
 * or console group, its sandbox closed); a Live request or a route outside the allowlist is refused, deny by
 * default. A guard that passes no caller (the legacy key guards) never takes one.
 */
export async function admitCliToken(
  env: AppEnv,
  row: ResolvedKeyRow,
  caller: KeyCaller | undefined,
  now: number,
): Promise<boolean> {
  const end = async (reason: string): Promise<false> => {
    await endCliToken(env.DB, row.id, reason, now);
    createLogger().info('cli_token.ended', { code: 'CLI_TOKEN_ENDED', keyId: row.id, reason });
    return false;
  };
  const state = row.cli ? (JSON.parse(row.cli) as CliState) : null;
  if (!state || state.revoked_at !== null) return false;
  if ((row.last_used_at ?? row.created_at) + CLI_TOKEN_IDLE_MS <= now) return end('idle');
  // The person's groups as the last sign-in recorded them, so a removal in Polaris ID ends the token.
  const roles = roleOf(state.last_roles);
  if (row.org_kind === 'developer') {
    if (state.sandbox_open !== 1) return end('sandbox_closed');
    if (!hasDeveloperAccess(roles)) return end('developer_group_removed');
  } else if (env.OIDC_CONSOLE_GROUP_REQUIRED === 'true' && !hasConsoleGroup(roles)) {
    return end('console_group_removed');
  }
  if (caller?.mode === 'live') throw workbenchTestOnly();
  if (!caller?.routes?.length || !caller.routes.every((route) => ALLOWED.has(route)))
    throw cliTokenNotAllowed();
  return true;
}
