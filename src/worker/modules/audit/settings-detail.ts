const plain = (v: unknown) => v === null || typeof v === 'number' || typeof v === 'boolean';

/**
 * A settings entry as a tenant reads it. Setting keys are not tenant detail keys, so the generic read
 * redaction would blank the whole list. Only changes whose old and new values are numbers, booleans or
 * unset pass, as `{ label: key, from, to }`; a text setting (an address, a name, a URL) never does.
 */
export function tenantSettingsDetail(detail: unknown): unknown {
  if (typeof detail !== 'object' || detail === null) return detail;
  const changes = (detail as { changes?: unknown }).changes;
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return detail;
  const kept = Object.entries(changes).flatMap(([label, v]) => {
    const pair = v as { from?: unknown; to?: unknown } | null;
    return pair && plain(pair.from) && plain(pair.to)
      ? [{ label, from: pair.from ?? null, to: pair.to ?? null }]
      : [];
  });
  return { changes: kept };
}
