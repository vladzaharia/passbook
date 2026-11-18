/**
 * The root every retained-evidence MAC derives from, and what `MAC_KEY_VERSION` defaults to: every deployment
 * started at V1. Explicit, not "the oldest": with V1 gone and no `MAC_ROOT_V1` it must fail, not drift to V2.
 */
export const EVIDENCE_ROOT = 1;

/** A KEK version setting: an integer or a digit string, 1 or more; null for anything else. */
export function parseKekVersion(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw.trim())) {
    const version = Number(raw);
    return Number.isSafeInteger(version) ? version : null;
  }
  return null;
}

/**
 * Problems with `MAC_KEY_VERSION` / `MAC_KEY_VERSION_PREVIOUS` (shared by Status and deploy:check). Each
 * must be a KEK version number, name a configured KEK, and differ from the other when both are set.
 * `kekVersions` null skips the existence check (a deploy check that cannot see the secrets).
 */
export function macKeyProblems(
  settings: { pin?: unknown; previous?: unknown },
  kekVersions: readonly number[] | null,
): string[] {
  const problems: string[] = [];
  const parsed: Record<string, number> = {};
  for (const [name, raw] of [
    ['MAC_KEY_VERSION', settings.pin],
    ['MAC_KEY_VERSION_PREVIOUS', settings.previous],
  ] as const) {
    if (raw === undefined || raw === null || raw === '') continue;
    const version = parseKekVersion(raw);
    if (version === null) {
      problems.push(`${name} must be a KEK version number (1, 2, ...).`);
      continue;
    }
    if (kekVersions && !kekVersions.includes(version))
      problems.push(
        `${name}=${version} names a root that is not set (KEK_V${version} or MAC_ROOT_V${version}).`,
      );
    parsed[name] = version;
  }
  if (
    parsed.MAC_KEY_VERSION !== undefined &&
    parsed.MAC_KEY_VERSION === parsed.MAC_KEY_VERSION_PREVIOUS
  )
    problems.push('MAC_KEY_VERSION and MAC_KEY_VERSION_PREVIOUS must differ.');
  return problems;
}

/**
 * Problems with the key ring as a whole (Status and deploy:check). `kek` and `macRoot` are the versions of
 * `KEK_V<n>` and `MAC_ROOT_V<n>` that are set. Root 1 must stay available (as the KEK or its extracted
 * root): every deployment started there, and its retained evidence MACs derive from it. `MAC_KEY_VERSION*`
 * may name either kind of root.
 */
export function keyRingProblems(input: {
  kek: readonly number[];
  macRoot: readonly number[];
  pin?: unknown;
  previous?: unknown;
}): string[] {
  const { kek, macRoot } = input;
  if (kek.length === 0) return ['No KEK is set (KEK_V1, KEK_V2, ...).'];
  const problems: string[] = [];
  if (!kek.includes(EVIDENCE_ROOT) && !macRoot.includes(EVIDENCE_ROOT))
    problems.push(
      `Root ${EVIDENCE_ROOT} is missing: set KEK_V${EVIDENCE_ROOT} or MAC_ROOT_V${EVIDENCE_ROOT}.`,
    );
  const current = Math.max(...kek);
  for (const version of macRoot)
    if (version >= current)
      problems.push(`MAC_ROOT_V${version} must be older than the current KEK (KEK_V${current}).`);
  problems.push(...macKeyProblems(input, [...new Set([...kek, ...macRoot])]));
  return problems;
}
