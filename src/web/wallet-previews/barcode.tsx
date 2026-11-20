import { useEffect, useMemo, useState } from 'react';
import { drawBarcode } from '../pass-card/barcode.tsx';
import { getBarcodeEngine, loadBarcodeEngine, type ToSvg } from '../pass-card/barcode-engine.ts';

/** A code as a wallet draws it: dark on a white tile. For looks only, never for scanning. */
export function WalletCode({
  bcid,
  message,
  label,
}: {
  bcid: string;
  message: string;
  /** The name read aloud, e.g. "Google Wallet barcode". */
  label: string;
}) {
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
  const drawn = useMemo(
    () => (engine ? drawBarcode(engine, { bcid, message }) : undefined),
    [engine, bcid, message],
  );
  const square = bcid === 'qrcode' || bcid === 'azteccode';
  if (!drawn) {
    return failed || engine ? (
      <p className="wp-code-missing" role="img" aria-label={`${label} unavailable`}>
        Code unavailable
      </p>
    ) : (
      <div className="wp-code-pending" aria-busy="true" />
    );
  }
  return (
    <svg
      className="wp-code"
      data-square={square || undefined}
      viewBox={drawn.viewBox}
      role="img"
      aria-label={`${label}, approximate`}
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="crispEdges"
    >
      {drawn.paths.map((p) => (
        <path
          key={p.d}
          d={p.d}
          {...(p.strokeWidth
            ? { fill: 'none', stroke: 'currentColor', strokeWidth: p.strokeWidth }
            : { fill: 'currentColor', ...(p.fillRule ? { fillRule: 'evenodd' as const } : {}) })}
        />
      ))}
    </svg>
  );
}
