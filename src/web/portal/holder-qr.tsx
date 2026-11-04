import { useEffect, useState } from 'react';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { cn } from '../lib/cn.ts';
import { getBarcodeEngine, loadBarcodeEngine, type ToSvg } from '../pass-card/barcode-engine.ts';

/**
 * The add QR as a data: image (the CSP allows it; inline SVG styles it does not). One encoder for
 * the portal and /p: the Worker registers it up front (sync-barcode.ts), the browser loads it on
 * first use (barcode-loader.ts).
 */
export function qrDataUri(toSvg: ToSvg, text: string): string {
  const svg = toSvg({ bcid: 'qrcode', text, scale: 4, eclevel: 'M' });
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** The code on a white tile in the sign's pocket (add.css), its size kept while the encoder loads. */
export function QrTile({ value, label }: { value: string; label: string }) {
  const [engine, setEngine] = useState<ToSvg | undefined>(getBarcodeEngine);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (engine) return;
    let live = true;
    loadBarcodeEngine().then(
      (e) => live && setEngine(() => e),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [engine]);
  return (
    <span
      className={cn(
        'wl-sign-qr grid place-items-center overflow-hidden',
        // White behind the code only: the failure line stays on the theme's surface.
        !failed && 'bg-white',
      )}
    >
      {engine ? (
        <img src={qrDataUri(engine, value)} alt={label} className="block size-full" />
      ) : failed ? (
        <span className="px-1 text-center text-xs text-danger">{HOLDER_COPY.qrFailed}</span>
      ) : (
        <span role="img" aria-label={label} aria-busy="true" className="block size-full" />
      )}
    </span>
  );
}
