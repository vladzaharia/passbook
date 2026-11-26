// The e2e provider release (docs/design/wallet-providers/e2e-release.md): its build switch, and the scan
// that proves a Worker bundle does not carry it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Literal strings of src/worker/modules/wallet-providers/e2e-release.ts. They survive minification, and
 * `__WALLET_E2E_RELEASE__` contains the first, so an unreplaced define is caught as well.
 */
export const E2E_RELEASE_MARKERS = ['WALLET_E2E_RELEASE', 'Wallet Test WWDR'] as const;

/**
 * The database side of the release (migration 0229): its issuance guards refuse every provider instance, activation,
 * offer and Samsung reference of a provider and mode whose `wallet_provider_releases` row is not `released`.
 * Only tools/e2e-server.ts writes these rows outside a migration, in its throwaway local database, for a release
 * run; the guards then run with their real bodies. Every deployed database changes them only by a flip migration.
 */
export const E2E_RELEASE_SQL =
  "UPDATE wallet_provider_releases SET state = 'released', changed_at = 0;";

/** On only for a tools/e2e-server.ts run (WALLET_E2E) that asked for the release; vite.config.ts uses it. */
export function e2eReleaseOn(env: Record<string, string | undefined>): boolean {
  return env.WALLET_E2E === '1' && env.WALLET_E2E_RELEASE === '1';
}

/**
 * Why a reused e2e server is the wrong one for this run, or null. The wallets run needs Google and Samsung open;
 * every other run needs them dark, as in production. Anything else (an unread setting) is a mismatch.
 */
export function e2eReleaseMismatch(
  released: { google?: unknown; samsung?: unknown } | undefined,
  wantOpen: boolean,
): string | null {
  const open = released?.google === true && released.samsung === true;
  const dark = released?.google === false && released.samsung === false;
  if (wantOpen ? open : dark) return null;
  return wantOpen
    ? 'Google and Samsung are dark on this server. Run the wallet specs with npm run test:e2e:wallets (WALLET_E2E_RELEASE=1).'
    : 'Google and Samsung are open on this server: an e2e release server is still running on the port. Stop it, then run again.';
}

/** Vite `define` for the Worker: a literal the minifier folds, so a `false` build drops the path. */
export function e2eReleaseDefine(env: Record<string, string | undefined>): {
  __WALLET_E2E_RELEASE__: string;
} {
  return { __WALLET_E2E_RELEASE__: JSON.stringify(e2eReleaseOn(env)) };
}

function* bundleFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* bundleFiles(path);
    else if (/\.(m?js|json)$/.test(name)) yield path;
  }
}

/**
 * Problems with a built Worker (dist/wallet): each script or config file that carries an e2e release
 * marker, or no script at all (a scan of nothing proves nothing).
 */
export function e2eReleaseProblems(dir: string): string[] {
  if (!existsSync(dir)) return [`${dir} does not exist`];
  const files = [...bundleFiles(dir)];
  if (!files.some((file) => /\.m?js$/.test(file))) return [`${dir} has no Worker script`];
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return E2E_RELEASE_MARKERS.filter((marker) => text.includes(marker)).map(
      (marker) => `${relative(dir, file)} contains ${marker} (the e2e provider release)`,
    );
  });
}
