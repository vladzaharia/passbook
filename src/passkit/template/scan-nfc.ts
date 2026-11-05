import type { PassJson, TemplateManifest, ValidationIssue } from '../types.ts';
import { BINDING_STYLE_GROUPS } from './pointer.ts';
import { isRecord } from './scan-actions.ts';

const NFC_STYLES = new Set(['storeCard', 'eventTicket']);

/** Static checks for `manifest.nfc` and the template's own `pass.json`. */
export function nfcIssues(
  manifest: TemplateManifest,
  passJson?: PassJson,
  options: { identity?: { name: string; nfc: boolean } } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (
    severity: ValidationIssue['severity'],
    code: string,
    message: string,
    path: string,
  ) => issues.push({ severity, code, message, path });
  if (passJson && (passJson as { nfc?: unknown }).nfc !== undefined)
    push(
      'error',
      'NFC_IN_PASS_JSON',
      'pass.json must not have nfc. The platform adds it.',
      'pass.json',
    );
  const nfc = (manifest as { nfc?: unknown }).nfc;
  if (nfc === undefined) return issues;
  const valid =
    isRecord(nfc) &&
    typeof nfc.enabled === 'boolean' &&
    (nfc.requiresAuthentication === undefined || typeof nfc.requiresAuthentication === 'boolean') &&
    Object.keys(nfc).every((k) => k === 'enabled' || k === 'requiresAuthentication');
  if (!valid || !isRecord(nfc)) {
    push('error', 'NFC_SHAPE', 'nfc needs enabled, and may have requiresAuthentication.', 'nfc');
    return issues;
  }
  if (nfc.enabled !== true) return issues;
  if (passJson) {
    const styles = BINDING_STYLE_GROUPS.styles.filter((s) => isRecord(passJson[s]));
    if (styles.length > 0 && !styles.some((s) => NFC_STYLES.has(s)))
      push('warning', 'NFC_STYLE', 'NFC works on store card and event ticket passes.', 'nfc');
  }
  if (options.identity && !options.identity.nfc)
    push(
      'info',
      'NFC_IDENTITY',
      `NFC is off for passes signed by ${options.identity.name}.`,
      'nfc',
    );
  return issues;
}
