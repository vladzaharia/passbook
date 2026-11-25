/** Relations of a Link header (RFC 8288) with their targets; the first target of a relation wins. */
export function linkRels(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/,\s*(?=<)/)) {
    const m = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (!m) continue;
    const rels = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(m[2] ?? '')?.[1]?.split(/\s+/) ?? [];
    for (const rel of rels) out[rel.toLowerCase()] ??= m[1] ?? '';
  }
  return out;
}

/** The `rel="next"` target of a Link header, or null. */
export const nextFromLinkHeader = (header: string | null): string | null =>
  linkRels(header).next ?? null;
