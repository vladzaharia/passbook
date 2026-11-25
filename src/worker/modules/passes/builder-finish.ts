import { withTimedKeys } from '../../../passkit/behaviors/upcoming-events/timed.ts';
import { contentHashOf } from '../../../passkit/build-hash.ts';
import type { PreviewPass } from '../../../passkit/index.ts';
import { evaluate } from '../../../passkit/template/expr.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson, Personalization } from '../../../passkit/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { PREVIEW_CONTENT_TYPE, PREVIEW_OBJECT_SUFFIX } from '../developer/fence.ts';
import { brandingWarnings, type TenantBranding, tenantPassJson } from './branding.ts';
import type { Artifact, BuildRequest } from './builder.ts';
import { applyChangeMessages, stripChangeMessages } from './change-messages.ts';
import { withBackContacts } from './contacts.ts';
import { issuerName } from './issuer.ts';
import { applyRemoval } from './remove-build.ts';
import type { AssetRow } from './repo-history-assets.ts';
import { barcodeHashOf, lookupHashOf, lookupValueOf } from './scan-code.ts';

export function displayOf(
  template: ResolvedTemplate,
  input: Personalization,
): { title: string | null; subtitle: string | null } {
  const scope = { input, lookups: template.manifest.lookups ?? {} };
  const text = (expr: Parameters<typeof evaluate>[0] | undefined): string | null => {
    if (expr === undefined) return null;
    const value = evaluate(expr, scope);
    return value === undefined || value === null || value === ''
      ? null
      : String(value).slice(0, 200);
  };
  return {
    title: text(template.manifest.display.title),
    subtitle: text(template.manifest.display.subtitle),
  };
}

/** The template's pass.json as this org issues it, and the issuer name the pass prints. */
export function tenantOf(
  req: BuildRequest,
  resolved: ResolvedTemplate,
  branding: TenantBranding,
  contacts: Parameters<typeof withBackContacts>[1],
) {
  const base = tenantPassJson(resolved.passJson, req.orgName, branding, req.personal);
  return {
    passJson: withBackContacts(base, contacts),
    issuer: issuerName(req.orgName, req.personal, resolved.passJson),
  };
}

/**
 * The edits a save, a void or a removal make to the built pass.json. `resign`: the pass must be signed
 * again; `planned`: the pass.json as built, before them (what `contentHash` covers).
 */
export function editPass(
  req: BuildRequest,
  passJson: PassJson,
): { resign: boolean; planned: PassJson } {
  const planned = structuredClone(passJson);
  let resign = false;
  if (req.status === 'voided' && passJson.voided !== true) {
    passJson.voided = true;
    resign = true;
  }
  if (req.changeMessages) {
    const { previous, notify, text } = req.changeMessages;
    resign = applyChangeMessages(passJson, previous, notify, text) || resign;
  }
  if (req.silent) resign = stripChangeMessages(passJson) || resign;
  if (req.removal) {
    applyRemoval(passJson, req.removal);
    resign = true;
  }
  return { resign, planned };
}

/** The artifact of a build, signed (a package) or previewed (the pass JSON). */
export async function artifactOf(input: {
  bytes: Uint8Array;
  previewOnly: boolean;
  built: PreviewPass;
  planned: PassJson;
  req: BuildRequest;
  resolved: ResolvedTemplate;
  template: ResolvedTemplate;
  branding: TenantBranding;
  passOverrides: AssetRow[];
  artHashes: Parameters<typeof brandingWarnings>[3];
}): Promise<Artifact> {
  const { built, req, resolved, template, branding, passOverrides, artHashes } = input;
  const display = displayOf(template, req.personalization);
  const lookupInput = resolved.manifest.scan?.lookup?.input;
  const lookupValue = lookupInput ? lookupValueOf(req.personalization, lookupInput) : null;
  // The signed bytes carry the device token; the copy kept in the database never does.
  const { authenticationToken: _token, ...storedPassJson } = built.passJson;
  return {
    bytes: input.bytes,
    previewOnly: input.previewOnly,
    sha256: await sha256Hex(input.bytes),
    passJson: storedPassJson,
    template: resolved,
    title: display.title,
    subtitle: display.subtitle,
    contentHash: built.contentHash,
    contentHashWith: (keys) => contentHashOf(withTimedKeys(input.planned, keys), built.assetSha1),
    barcodeHash: await barcodeHashOf(built.passJson),
    lookupHash: lookupValue === null ? null : await lookupHashOf(lookupValue),
    warnings: [
      ...built.report.issues.filter((i) => i.severity !== 'error'),
      ...brandingWarnings(
        resolved,
        branding,
        passOverrides.map((a) => a.name),
        artHashes,
      ),
    ],
  };
}

/** Where and as what a built artifact is stored: a signed package, or a developer org's preview JSON. */
export const objectFileOf = (artifact: Pick<Artifact, 'previewOnly'>) =>
  artifact.previewOnly
    ? { ext: PREVIEW_OBJECT_SUFFIX, contentType: PREVIEW_CONTENT_TYPE }
    : { ext: '.pkpass', contentType: 'application/vnd.apple.pkpass' };
