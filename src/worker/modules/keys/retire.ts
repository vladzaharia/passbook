import { EVIDENCE_ROOT, parseKekVersion } from '../../platform/mac-key-config.ts';
import { stampOf } from './rewrap-tables.ts';

const DAY = 86_400_000;

/** What a retire check reads: the ring, the rotation settings and the rewrap's done marker. */
export interface RetireInput {
  /** The version to retire. */
  n: number;
  /** Versions of `KEK_V<n>` and `MAC_ROOT_V<n>` that are set. */
  kek: readonly number[];
  macRoot: readonly number[];
  pin?: unknown;
  previous?: unknown;
  done: {
    stamp?: unknown;
    unreadable?: unknown;
    startedAt?: unknown;
    remaining?: unknown;
  } | null;
  /** `MAC_ROOT_V<n>` derives the same keys as `KEK_V<n>` (Status computes it; the tool reads `keys.macRoots`). */
  rootVerified: boolean;
  now: number;
}

/** The MAC root versions in use: `EVIDENCE_ROOT` (retained evidence), `MAC_KEY_VERSION` and the previous one. */
export function rootsInUse(input: Pick<RetireInput, 'pin' | 'previous'>): number[] {
  const used = new Set<number>([EVIDENCE_ROOT, parseKekVersion(input.pin) ?? EVIDENCE_ROOT]);
  const previous = parseKekVersion(input.previous);
  if (previous !== null) used.add(previous);
  return [...used];
}

/**
 * Why `KEK_V<n>` cannot be deleted yet; empty when nothing stands in the way. Shared by Status (which lists
 * the versions with no problem) and `npm run keys:retire`, which adds exact row counts and the secret list.
 * docs/operations.md, KEK rotation.
 */
export function retireProblems(input: RetireInput): string[] {
  const { n, kek, macRoot, done, now } = input;
  const current = Math.max(...kek);
  if (!kek.includes(n) || n >= current)
    return [`KEK_V${n} is not an older KEK in the ring (KEK_V${current} is current).`];
  const problems: string[] = [];
  if (done?.stamp !== stampOf(kek))
    problems.push(`The rewrap of ${stampOf(kek)} has not finished.`);
  else {
    if (done.unreadable !== 0)
      problems.push(`The rewrap left ${String(done.unreadable)} rows it could not open.`);
    const left =
      done.remaining && typeof done.remaining === 'object'
        ? Number((done.remaining as Record<string, unknown>)[String(n)] ?? 0)
        : null;
    if (left === null) problems.push('The sweep recorded no row counts.');
    else if (left > 0) problems.push(`${left} rows still used KEK_V${n} when the sweep ended.`);
    const startedAt = typeof done.startedAt === 'number' ? done.startedAt : now;
    if (now - startedAt < DAY)
      problems.push('Wait 24 hours from the first rewrap run: console cursors live that long.');
  }
  if (parseKekVersion(input.previous) === n)
    problems.push(`MAC_KEY_VERSION_PREVIOUS is ${n}: finish the MAC key rotation first.`);
  if (rootsInUse(input).includes(n)) {
    if (!macRoot.includes(n))
      problems.push(`MAC_ROOT_V${n} is not set: V${n} is a MAC root in use.`);
    else if (!input.rootVerified)
      problems.push(`MAC_ROOT_V${n} is not verified against KEK_V${n}.`);
  }
  return problems;
}
