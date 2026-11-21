/**
 * The issuer name a pass prints for an org. A personal org holds one person's passes for other places,
 * so its passes keep the template's own `organizationName`; the org name is the fallback when the template
 * has none. Every other org prints its own name, so a tenant cannot present as someone else. `personal`
 * comes from the org row (`PassOrg.personal`), never from a template or a request.
 */
export function issuerName(
  orgName: string,
  personal: boolean,
  template: { organizationName?: unknown },
): string {
  if (!personal) return orgName;
  const own = typeof template.organizationName === 'string' ? template.organizationName.trim() : '';
  return own || orgName;
}
