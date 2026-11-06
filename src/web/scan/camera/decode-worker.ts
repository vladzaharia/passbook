import { prepareZXingModule, type ReadInputBarcodeFormat, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { CodeFormat } from '../input/types.ts';
import type { CameraReply, CameraRequest } from './protocol.ts';

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
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CameraRequest>) => void) | null;
  postMessage(message: CameraReply): void;
};
worker.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      await prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? wasmUrl : prefix + path,
        },
        fireImmediately: true,
      });
      worker.postMessage({ type: 'ready' });
      return;
    }
    const [found] = await readBarcodes(data.image, {
      formats: data.formats.map((f) => formats[f]),
      maxNumberOfSymbols: 1,
      tryHarder: true,
      tryRotate: true,
      tryDownscale: true,
      textMode: 'Plain',
    });
    worker.postMessage({
      type: 'frame',
      id: data.id,
      hit: found
        ? { code: found.text, linear: !['QRCode', 'PDF417', 'Aztec'].includes(found.symbology) }
        : null,
    });
  } catch {
    // A classified error releases the camera and offers Retry; never log barcode content.
    worker.postMessage({ type: 'error' });
  }
};
