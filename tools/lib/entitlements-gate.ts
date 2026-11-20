// The MT2 gate: a deploy refuses while any org has no org_entitlements row. Such an org is refused every key and
// guarded session call (fail closed), so promoting would lock it out.

export interface OrgWithoutEntitlements {
  id: string;
}

/**
 * The rows of the `entitlements-gate` query from `wrangler d1 execute --json` output. Throws on any other
 * output: unreadable is never "every org has a row".
 */
export function orgsWithoutEntitlements(output: string): OrgWithoutEntitlements[] {
  const parsed: unknown = JSON.parse(output);
  const rows: unknown = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (
    !Array.isArray(rows) ||
    !rows.every((r) => r && typeof r === 'object' && typeof r.id === 'string')
  )
    throw new Error('Unexpected wrangler output; cannot tell whether every org has entitlements.');
  return rows as OrgWithoutEntitlements[];
}

export function entitlementsRefusal(rows: readonly OrgWithoutEntitlements[]): string | null {
  return rows.length === 0
    ? null
    : `Not deploying: ${rows.length} org(s) have no entitlements row:\n${rows
        .map((r) => `- ${r.id}`)
        .join('\n')}\nRepair them (docs/operations.md, Entitlements gate).`;
}
