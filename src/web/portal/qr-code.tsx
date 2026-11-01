import { useEffect, useState } from 'react';
import { loadBarcodeEngine } from '../pass-card/barcode-engine.ts';
import { Skeleton } from '../ui/index.ts';
import './portal.css';

/**
 * QR as a data: image (allowed by the CSP; inline SVG styles are not). A scan line sweeps the code
 * once when it appears (900 ms); the placeholder is the kit skeleton.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setSrc(undefined);
    setFailed(false);
    loadBarcodeEngine()
      .then((toSvg) => {
        const svg = toSvg({ bcid: 'qrcode', text: value, scale: 4, eclevel: 'M' });
        if (live) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [value]);

  if (failed) return <p className="text-sm text-danger">Could not draw the QR code. Reload.</p>;
  if (!src) return <Skeleton className="size-48 rounded-lg" />;
  return (
    <span className="wl-qr relative block size-48 overflow-hidden rounded-lg bg-white p-2">
      <img src={src} alt={label} className="block size-full" />
      <span aria-hidden className="wl-qr-scan" />
    </span>
  );
}
