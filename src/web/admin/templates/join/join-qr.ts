import { useEffect, useState } from 'react';
import {
  getBarcodeEngine,
  loadBarcodeEngine,
  type ToSvg,
} from '../../../pass-card/barcode-engine.ts';
import { qrDataUri } from '../../../portal/holder-qr.tsx';

/** The link's QR as a data: image; null until the encoder loads, `failed` when it cannot. */
export function useJoinQr(value: string | null): { src: string | null; failed: boolean } {
  const [engine, setEngine] = useState<ToSvg | undefined>(getBarcodeEngine);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (engine || !value) return;
    let live = true;
    loadBarcodeEngine().then(
      (e) => live && setEngine(() => e),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [engine, value]);
  return { src: engine && value ? qrDataUri(engine, value) : null, failed };
}
