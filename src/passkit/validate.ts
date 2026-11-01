import { isObject, type ValidationContext } from './schema/util.ts';
import { validateBarcodes } from './schema/validate-barcodes.ts';
import {
  validateFeaturedActions,
  validateNfc,
  validateSharing,
} from './schema/validate-features.ts';
import { validateStyleDict } from './schema/validate-fields.ts';
import { validateHig } from './schema/validate-hig.ts';
import { type ValidatableAsset, validateImages } from './schema/validate-images.ts';
import type { PackageContents } from './schema/validate-package.ts';
import { validateLocalization, validatePersonalization } from './schema/validate-package.ts';
import {
  validateBeacons,
  validateLocations,
  validateRelevantDates,
} from './schema/validate-relevance.ts';
import { validateRequiredSemantics, validateSemantics } from './schema/validate-semantics.ts';
import { resolveStyles, validateTopLevel } from './schema/validate-top.ts';
import { validateUpcoming } from './schema/validate-upcoming.ts';
import type {
  PassIdentity,
  PassJson,
  PassStyle,
  ValidationIssue,
  ValidationReport,
} from './types.ts';
import { PASS_STYLES } from './types.ts';

export type { ValidatableAsset } from './schema/validate-images.ts';

export interface ValidatePassOptions extends PackageContents {
  /** Treat warnings as errors. */
  strict?: boolean;
}

/**
 * Checks a built pass.json and its package contents before signing. Errors block signing;
 * warnings are surfaced to admins. `assets` lists every file of the package with image pixel
 * sizes when known; `options.strings` and `options.personalization` carry file contents.
 */
export function validatePass(
  pass: PassJson,
  assets: ValidatableAsset[],
  identity: PassIdentity,
  options: ValidatePassOptions = {},
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, path?: string) =>
    issues.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code: string, message: string, path?: string) =>
    issues.push({
      severity: options.strict ? 'error' : 'warning',
      code,
      message,
      ...(path ? { path } : {}),
    });

  const info = (code: string, message: string, path?: string) =>
    issues.push({ severity: 'info', code, message, ...(path ? { path } : {}) });
  const ctx: ValidationContext = {
    pass,
    identity,
    error,
    warn,
    info,
    styles: resolveStyles(pass, error, warn),
  };
  validateTopLevel(ctx);
  for (const style of PASS_STYLES as readonly PassStyle[])
    if (isObject(pass[style])) validateStyleDict(ctx, style);
  validateBarcodes(ctx);
  validateLocations(ctx);
  validateBeacons(ctx);
  validateRelevantDates(ctx);
  validateFeaturedActions(ctx);
  validateNfc(ctx);
  validateSharing(ctx);
  validateSemantics(ctx, pass.semantics, 'semantics');
  validateRequiredSemantics(ctx);
  validateUpcoming(ctx);

  const images = validateImages(ctx, assets);
  validateHig(ctx, assets);
  validateLocalization(ctx, assets, options);
  validatePersonalization(ctx, assets, images, options);

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}
