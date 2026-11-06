import { prepareZXingModule, type ReadInputBarcodeFormat, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { CodeFormat, RawRead } from '../input/types.ts';

const formats: Record<CodeFormat, ReadInputBarcodeFormat> = {
  qr: 'QRCode',
  pdf417: 'PDF417',
  aztec: 'Aztec',
  code128: 'Code128',
  code39: 'Code39',
  codabar: 'Codabar',
  ean13: 'EAN13',
  itf: 'ITF',
};
prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ image: ImageData; formats: CodeFormat[] }>) => void) | null;
  postMessage(message: { read?: RawRead; error?: boolean }): void;
};
worker.onmessage = async ({ data }) => {
  try {
    const results = await readBarcodes(data.image, {
      formats: data.formats.map((f) => formats[f]),
      maxNumberOfSymbols: 1,
      tryHarder: true,
    });
    const found = results[0];
    worker.postMessage(found ? { read: { method: 'camera', code: found.text } } : {});
  } catch {
    // The main thread stops the camera and offers keyboard/lookup when the decoder fails.
    worker.postMessage({ error: true });
  }
};
