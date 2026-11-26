import type { SetupCtx } from '../../workers/polaris-binding/src/setup-types.ts';
import type { BindingEnv } from '../../workers/polaris-binding/src/types.ts';
import { CIMD, installSetup } from './fake-setup.ts';
import type { Layout } from './fixtures.ts';
import { setup, userCtx } from './harness.ts';

/** GROUPS by exact name only: no ids anywhere, the protected roles as lists (design 4.1). */
export const namesJson = (o: { support?: boolean } = {}) =>
  JSON.stringify({
    console: { name: 'passbook_console' },
    developer: { name: 'passbook_developers' },
    ...(o.support ? { support: { name: 'passbook_support' } } : {}),
    platform_admin: [
      { name: 'wallet_admins', protected: true },
      { name: 'passbook_platform_admins', protected: true },
    ],
    users: [{ name: 'passbook_users', protected: true }],
  });

/** The binding over a fake Polaris ID that serves the CIMD client and its SCIM connection. */
export function setupCimd(
  layout: Layout = 'v2',
  o: { names?: boolean; patch?: Partial<BindingEnv> } = {},
) {
  const h = setup(layout, {
    PASSBOOK_CLIENT_ID: CIMD,
    ...(o.names ? { GROUPS: namesJson() } : {}),
    ...o.patch,
  });
  const fake = installSetup(h.pocket, layout, h.clock);
  return { ...h, fake };
}

/** Every request that is not a GET, as `METHOD path`. */
export const writes = (h: { pocket: { writes(): { method: string; path: string }[] } }) =>
  h.pocket.writes().map((w) => `${w.method} ${w.path}`);

/** A setup call's context: the binding refuses one without an explicit boolean `dryRun`. */
export const setupCtx = (over: Partial<SetupCtx> = {}): SetupCtx => ({
  ...userCtx({ reason: 'setup', ...over }),
  dryRun: false,
  ...over,
});
