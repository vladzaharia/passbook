import {
  type ScanDisplayDoc,
  ScanDisplayDocSchema,
} from '@/passkit/template/scan-display/schema.ts';
import { parseParts } from '@/passkit/template/scan-display/text.ts';
import { scanDisplayIssues } from '@/passkit/template/scan-display/validate.ts';
import { sourcesOf, walkDoc } from '@/passkit/template/scan-display/walk.ts';
import type { TemplateManifest, ValidationIssue } from '@/passkit/types.ts';
import { type DesignDoc, isRecord } from '../model.ts';
import { previewPassFields, safePreviewText } from './scan-preview-policy.ts';

/** Keep in-progress text even when it temporarily fails schema validation. */
export function scanDisplayOf(doc: DesignDoc): ScanDisplayDoc | null {
  const scan = isRecord(doc.manifest.scan) ? doc.manifest.scan : null;
  const display = scan?.display;
  if (!isRecord(display) || display.v !== 1 || !isRecord(display.header)) return null;
  return display as unknown as ScanDisplayDoc;
}

/** Fast local validation complements the server dry run and gates saving while typing. */
export function scanIssues(doc: DesignDoc): ValidationIssue[] {
  const issues = scanDisplayIssues(doc.manifest as unknown as TemplateManifest, {
    passJson: previewPassFields(doc),
    assetNames: doc.assets.map((asset) => asset.name),
  });
  const scan = isRecord(doc.manifest.scan) ? doc.manifest.scan : null;
  const parsed = ScanDisplayDocSchema.safeParse(scan?.display);
  if (!parsed.success) return issues;
  const slots = walkDoc(parsed.data);
  const unsafe = (source: string) => {
    const parts = parseParts(source).parts;
    return (
      parts?.some((part) => part.literal !== undefined && !safePreviewText(part.literal)) ?? false
    );
  };
  const paths = new Set<string>();
  for (const slot of slots.texts) if (sourcesOf(slot.text).some(unsafe)) paths.add(slot.path);
  for (const slot of slots.exprs) if (unsafe(slot.expr)) paths.add(slot.path);
  for (const [index, variant] of (parsed.data.variants ?? []).entries())
    if (!safePreviewText(variant.name)) paths.add(`variants.${index}.name`);
  for (const path of paths)
    issues.push({
      severity: 'error',
      code: 'SCAN_DISPLAY_PRIVATE_TEXT',
      path: `scan.display.${path}`,
      message: 'Remove contact information or other private text from the scan screen.',
    });
  return issues;
}
