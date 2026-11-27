import { UnavailableError } from '../../platform/errors.ts';
import { keyRingProblems } from '../../platform/mac-key-config.ts';
import { macRootAgrees, secretVersions } from '../../platform/mac-roots.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { retireProblems } from '../keys/retire.ts';
import { CURSOR, type Cursor, DONE, type Done } from '../keys/rewrap.ts';
import { stampOf } from '../keys/rewrap-tables.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { readSystemValue } from '../settings/repo.ts';
import type { Draft } from './checks.ts';
import { keysetInitialized } from './repo.ts';

/**
 * The key ring as a whole: root 1 and the pinned roots are available, every `MAC_ROOT_V<n>` matches its
 * KEK, retained evidence still verifies, and how far the envelope rewrap is (and which KEKs may be deleted,
 * docs/operations.md, KEK rotation). Reports versions and counts, never key material.
 */
export async function checkKeys(ctx: ServiceContext): Promise<Draft> {
  const base = { id: 'keys', kind: 'build', label: 'Key rotation' } as const;
  try {
    const env = ctx.env as { MAC_KEY_VERSION?: string; MAC_KEY_VERSION_PREVIOUS?: string };
    const kek = secretVersions(env, 'KEK');
    const macRoot = secretVersions(env, 'MAC_ROOT');
    const settings = { pin: env.MAC_KEY_VERSION, previous: env.MAC_KEY_VERSION_PREVIOUS };
    const problems = keyRingProblems({ kek, macRoot, ...settings });
    const verified = new Set<number>();
    for (const version of macRoot) {
      const agrees = await macRootAgrees(env, version);
      if (agrees) verified.add(version);
      else if (agrees === false) {
        ctx.log.error('status.mac_root', { code: 'MAC_ROOT_MISMATCH', version });
        problems.push(`MAC_ROOT_V${version} does not match KEK_V${version}.`);
      }
    }
    const keysetReady = kek.length > 0 && (await keysetInitialized(ctx.env.DB));
    if (keysetReady) {
      try {
        await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
      } catch (error) {
        if (!(error instanceof UnavailableError)) throw error;
        problems.push('Retained evidence does not match this key ring.');
      }
    }
    const now = ctx.clock.now();
    const done = (await readSystemValue(ctx.env.DB, DONE)) as Partial<Done> | null;
    const cursor = (await readSystemValue(ctx.env.DB, CURSOR)) as Partial<Cursor> | null;
    const stamp = kek.length > 1 ? stampOf(kek) : null;
    const finished = stamp !== null && done?.stamp === stamp;
    const state = stamp === null ? 'idle' : finished ? 'done' : 'running';
    const current = Math.max(0, ...kek);
    const retirable = kek.filter(
      (n) =>
        n < current &&
        retireProblems({
          n,
          kek,
          macRoot,
          ...settings,
          done: finished ? done : null,
          rootVerified: verified.has(n),
          now,
        }).length === 0,
    );
    const unreadable = finished ? Number(done?.unreadable ?? 0) : 0;
    const data = {
      current,
      kekVersions: kek.join(','),
      macRoots: macRoot.join(','),
      keysetReady,
      rewrapState: state,
      rewrapStamp: stamp,
      rewrapSweep: cursor?.stamp === stamp ? (cursor?.sweep ?? null) : null,
      rewrapMoved: cursor?.stamp === stamp ? (cursor?.moved ?? null) : null,
      rewrapUnreadable: finished ? unreadable : null,
      rewrapStartedAt: cursor?.stamp === stamp ? (cursor?.startedAt ?? null) : null,
      retirable: retirable.join(','),
    };
    if (problems.length > 0) {
      ctx.log.error('status.keys', { code: 'KEY_RING_INVALID' });
      return { ...base, state: 'failing', detail: problems.join(' '), data };
    }
    if (unreadable > 0)
      return {
        ...base,
        state: 'degraded',
        detail: `${unreadable} rows could not be moved to the newest KEK.`,
        data,
      };
    return { ...base, state: 'verified', detail: null, data };
  } catch (error) {
    ctx.log.error('status.keys_unavailable', { code: 'KEYS_UNAVAILABLE', error });
    return { ...base, state: 'failing', detail: 'Key check failed.' };
  }
}
