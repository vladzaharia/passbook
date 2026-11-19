import type { TemplateManifest } from '../types.ts';
import { conditionInputs, exprReferences } from './expr.ts';

/** The only barcode a public card or a New code may carry: the server's scan code. */
export const SCAN_CODE_EXPR = '{{pass.scanCode}}';

/** The manifest's barcode bindings: the first or only barcode, on any message or style. */
export function barcodeBindings(manifest: TemplateManifest) {
  return (manifest.bindings ?? []).filter(
    (b) => 'barcode' in b.to && (b.to.barcode === '*' || b.to.barcode === 0),
  );
}

/** The inputs a barcode binding reads (value, when, remove); a scan-code barcode reads none. */
export function barcodeInputs(b: ReturnType<typeof barcodeBindings>[number]): string[] {
  return [
    ...exprReferences(b.value ?? '').inputs,
    ...[b.when, b.remove].flatMap((c) => (c ? conditionInputs(c) : [])),
  ];
}

/**
 * Whether the barcode message is the scan code and nothing else: one unconditional message binding
 * equal to `{{pass.scanCode}}`, reading no input. Only then can a New code replace what is encoded.
 */
export function barcodeIsScanCode(manifest: TemplateManifest): boolean {
  const bindings = barcodeBindings(manifest);
  if (bindings.some((b) => barcodeInputs(b).length > 0)) return false;
  const messages = bindings.filter((b) => 'prop' in b.to && b.to.prop === 'message');
  const last = messages.at(-1);
  return (
    last !== undefined &&
    messages.every((b) => b.when === undefined && b.remove === undefined) &&
    typeof last.value === 'string' &&
    last.value.trim() === SCAN_CODE_EXPR
  );
}
