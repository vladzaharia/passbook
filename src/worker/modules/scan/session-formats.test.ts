import { describe, expect, it } from 'vitest';
import { setupScanKit } from './test-kit.ts';

describe('camera session formats', () => {
  it('advertises every supported pass format, including iOS 27 linear formats', async () => {
    const kit = await setupScanKit();
    const formats = ['QR', 'PDF417', 'Aztec', 'Code128', 'Code39', 'Codabar', 'EAN13', 'I2of5'];
    const templateId = await kit.scanTemplate(
      'All camera formats',
      { actions: [{ id: 'check_in', kind: 'check_in', label: 'Check in' }] },
      {
        passStyle: {
          barcodes: formats.map((f) => ({
            format: `PKBarcodeFormat${f}`,
            message: '123456789012',
            messageEncoding: 'iso-8859-1',
          })),
        },
      },
    );
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const res = await kit.get(scanner.headers, '/session');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      formats: ['qr', 'pdf417', 'aztec', 'code128', 'code39', 'codabar', 'ean13', 'itf'],
    });
  });
});
