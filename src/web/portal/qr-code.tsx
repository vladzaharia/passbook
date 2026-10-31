import { useEffect, useState } from 'react';

/** QR as a data: image (allowed by the CSP; inline SVG styles are not). */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setSrc(undefined);
    setFailed(false);
    import('bwip-js/generic')
      .then((mod) => {
        const bwip = (mod.default ?? mod) as unknown as { toSVG(opts: object): string };
        const svg = bwip.toSVG({ bcid: 'qrcode', text: value, scale: 4, eclevel: 'M' });
        if (live) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [value]);

  if (failed) return <p className="text-sm text-danger">Could not draw the QR code.</p>;
  if (!src)
    return <div aria-hidden className="size-48 animate-pulse rounded-md bg-surface-sunken" />;
  return <img src={src} alt={label} className="size-48 rounded-md bg-white p-2" />;
}
