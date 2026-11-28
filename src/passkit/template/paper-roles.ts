/** Reading a pass for paper: roles, address and ID flags. */
import type { PassJson, Personalization, TemplateManifest } from '../types.ts';
import { resolveRoles } from '../wallets/roles.ts';
import type { buildFields, styleOf } from '../wallets/view-fields.ts';
import type { relevanceOf } from '../wallets/view-parts.ts';

/** The pass's roles for paper. */
export function paperRoles(
  input: {
    style: ReturnType<typeof styleOf>;
    org: string;
    fields: ReturnType<typeof buildFields>;
    passJson: PassJson;
    relevance: ReturnType<typeof relevanceOf>;
  },
  overrides: Parameters<typeof resolveRoles>[1],
  evalExpr: Parameters<typeof resolveRoles>[2],
) {
  return resolveRoles(
    {
      style: input.style,
      org: input.org,
      fields: input.fields,
      ...(input.passJson.semantics ? { semantics: input.passJson.semantics } : {}),
      barcodes: [],
      locations: input.relevance.locations,
    },
    overrides,
    evalExpr,
  ).roles;
}

/** An address that starts with the venue name drops the repeat; one that equals it vanishes. */
export function dedupeAddress(venue: string | undefined, address: string | undefined) {
  if (!address) return undefined;
  if (!venue) return address;
  let rest = address;
  while (rest.toLowerCase().startsWith(venue.toLowerCase()))
    rest = rest
      .slice(venue.length)
      .replace(/^[\s,·–-]+/, '')
      .trim();
  return rest || undefined;
}

/** `scan.flags` names an `idRequired` input and this pass has it on. */
export function idFlagged(
  manifest: Pick<TemplateManifest, 'scan'>,
  personalization: Personalization,
) {
  const flags = (manifest.scan as { flags?: { input?: string }[] } | undefined)?.flags ?? [];
  return flags.some((f) => {
    const v = f.input === 'idRequired' ? personalization.idRequired : undefined;
    return v === true || (typeof v === 'string' && /^(true|yes|y|1)$/i.test(v));
  });
}
