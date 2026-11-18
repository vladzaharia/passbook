import { makeTemplate, type TestTemplate } from '../../../../test/helpers/index.ts';
import { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';

/** A join-ready test template (primary barcode is the scan code), or one whose barcode reads `memberName`. */
export function joinTemplate(id: string, barcode = '{{pass.scanCode}}'): TestTemplate {
  const { resolved } = makeTemplate({ id });
  const registry = new InMemoryTemplateRegistry();
  const added = registry.add({
    id,
    orgId: null,
    version: 'v1',
    manifest: {
      ...resolved.manifest,
      bindings: [
        ...(resolved.manifest.bindings ?? []),
        { to: { barcode: '*', prop: 'message' }, value: barcode },
      ],
    },
    passJson: {
      ...resolved.passJson,
      barcodes: [{ format: 'PKBarcodeFormatQR', message: '', messageEncoding: 'iso-8859-1' }],
    },
    assets: { 'icon.png': TINY_PNG },
  });
  return { resolved: added, registry };
}
