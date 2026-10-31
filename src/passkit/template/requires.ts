import type { Json, PassIdentity, PassJson, TemplateManifest, ValidationIssue } from '../types.ts';
import { PASS_STYLES } from '../types.ts';

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Static check of `requires`: well-formed, and the pass.json draws the required styles. */
export function validateRequires(
  manifest: TemplateManifest,
  passJson?: PassJson,
): ValidationIssue[] {
  const requires = (manifest as { requires?: unknown }).requires;
  if (requires === undefined) return [];
  const issues: ValidationIssue[] = [];
  const error = (message: string, path: string) =>
    issues.push({ severity: 'error', code: 'REQUIRES', message, path });
  if (!isRecord(requires)) {
    error('requires must be an object.', 'requires');
    return issues;
  }
  for (const key of Object.keys(requires))
    if (key !== 'styles' && key !== 'nfc')
      error(`Unknown requires key "${key}".`, `requires/${key}`);
  if (requires.nfc !== undefined && typeof requires.nfc !== 'boolean')
    error('requires.nfc must be a boolean.', 'requires/nfc');
  if (requires.styles !== undefined) {
    const styles = requires.styles;
    if (
      !Array.isArray(styles) ||
      styles.some((s) => !(PASS_STYLES as readonly unknown[]).includes(s))
    )
      error(`requires.styles must list styles from ${PASS_STYLES.join(', ')}.`, 'requires/styles');
    else if (passJson)
      for (const style of styles)
        if (!isRecord((passJson as Record<string, unknown>)[String(style)]))
          error(`pass.json has no ${String(style)} dictionary.`, 'requires/styles');
  }
  return issues;
}

/** Why `identity` cannot issue from this template; empty when it can. */
export function unmetRequirements(
  manifest: Pick<TemplateManifest, 'requires'>,
  identity: Pick<PassIdentity, 'nfcEnabled'>,
): string[] {
  const out: string[] = [];
  if (manifest.requires?.nfc && !identity.nfcEnabled)
    out.push('The template needs NFC; the signing identity is not NFC-enabled.');
  return out;
}
