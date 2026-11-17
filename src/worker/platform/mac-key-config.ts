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
    const version = typeof raw === 'string' && /^[1-9]\d*$/.test(raw.trim()) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(version)) {
      problems.push(`${name} must be a KEK version number (1, 2, ...).`);
      continue;
    }
    if (kekVersions && !kekVersions.includes(version))
      problems.push(`${name}=${version} names a KEK that is not set (KEK_V${version}).`);
    parsed[name] = version;
  }
  if (
    parsed.MAC_KEY_VERSION !== undefined &&
    parsed.MAC_KEY_VERSION === parsed.MAC_KEY_VERSION_PREVIOUS
  )
    problems.push('MAC_KEY_VERSION and MAC_KEY_VERSION_PREVIOUS must differ.');
  return problems;
}
