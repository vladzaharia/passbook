import { useEffect, useState } from 'react';
import { getBarcodeEngine, loadBarcodeEngine, type ToSvg } from '../../pass-card/barcode-engine.ts';

const TILE = 'grid size-32 shrink-0 place-items-center rounded-md bg-white p-2';

/**
 * A link as a QR on a white tile, drawn as an image: the CSP allows data: images, not inline styles.
 * Without the encoder the link beside it is the way in. The one QR of the Workbench.
 */
export function QrTile({
  value,
  alt,
  className = TILE,
}: {
  value: string;
  alt: string;
  /** Replaces the tile's own size and surface. */
  className?: string;
}) {
  const [engine, setEngine] = useState<ToSvg | undefined>(getBarcodeEngine);
  useEffect(() => {
    if (engine) return;
    let live = true;
    loadBarcodeEngine().then(
      (e) => live && setEngine(() => e),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [engine]);
  if (!engine) return <span className={className} aria-hidden />;
  const svg = engine({ bcid: 'qrcode', text: value, scale: 4, eclevel: 'M' });
  return (
    <span className={className}>
      <img src={`data:image/svg+xml;base64,${btoa(svg)}`} alt={alt} className="size-full" />
    </span>
  );
}
