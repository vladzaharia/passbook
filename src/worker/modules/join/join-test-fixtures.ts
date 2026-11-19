import { makeTemplate, type TestTemplate } from '../../../../test/helpers/index.ts';
import { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';

/**
 * A join-ready test template (primary barcode is the scan code), or one whose barcode reads `memberName`.
 * With `lookup`, a required `cardNumber` input is the desk lookup, so a join generates its value.
 */
export function joinTemplate(
  id: string,
  barcode = '{{pass.scanCode}}',
  lookup = false,
): TestTemplate {
  const { resolved } = makeTemplate({ id });
  const registry = new InMemoryTemplateRegistry();
  const added = registry.add({
    id,
    orgId: null,
    version: 'v1',
    manifest: {
      ...resolved.manifest,
      ...(lookup
        ? {
            inputs: {
              type: 'object',
              required: ['memberName', 'cardNumber'],
              properties: {
                memberName: { type: 'string', minLength: 1 },
                cardNumber: { type: 'string', minLength: 1 },
              },
            },
            sample: { memberName: 'Alex Morgan', cardNumber: '0000000001' },
            scan: { actions: [], lookup: { input: 'cardNumber' } },
          }
        : {}),
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
