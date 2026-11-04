import type { DesignDoc } from './model.ts';

/** A small generic template: one input bound to a primary field, a barcode on the input. */
export function sampleDoc(): DesignDoc {
  return {
    passJson: {
      formatVersion: 1,
      organizationName: 'Org',
      description: 'Card',
      backgroundColor: 'rgb(20,30,60)',
      foregroundColor: 'rgb(255,255,255)',
      labelColor: 'rgb(200,210,255)',
      logoText: 'Org',
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'M-1', messageEncoding: 'iso-8859-1' }],
      generic: {
        primaryFields: [{ key: 'name', label: 'Member', value: 'Alex' }],
        secondaryFields: [
          { key: 'tier', label: 'Tier', value: 'Gold' },
          { key: 'since', label: 'Since', value: '2024' },
        ],
        backFields: [{ key: 'terms', label: 'Terms', value: 'None' }],
      },
    },
    manifest: {
      schema: 1,
      name: 'Card',
      inputs: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', 'x-label': 'Name', 'x-order': 10, maxLength: 200 } },
      },
      sample: { name: 'Alex' },
      bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
      display: { title: '{{name}}' },
    },
    assets: [{ name: 'icon@3x.png', slot: 'icon', scale: 3, size: 100, sha1: 'a'.repeat(40) }],
  };
}
