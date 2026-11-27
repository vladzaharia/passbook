import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { getBarcodeEngine, loadBarcodeEngine, type ToSvg } from '../../pass-card/barcode-engine.ts';
import { Button } from '../../ui/button.tsx';
import { CopyButton } from '../../ui/copy-button.tsx';

/** A pass's own link, absolute: the QR must open on another device. */
export const absoluteUrl = (url: string): string =>
  url.startsWith('/') ? `${location.origin}${url}` : url;

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

/**
 * A pass on a phone (design §3.4 DS1): its real link as a QR, the link itself, Open and Copy. Below
 * 640 px the phone in hand is the phone, so the QR gives way to Open on this phone.
 */
export function PreviewQr({
  url,
  alt,
  open,
  className,
}: {
  url: string;
  alt: string;
  /** What Open says on a phone ("Open on this phone"). */
  open: string;
  className?: string;
}) {
  const link = absoluteUrl(url);
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-4', className)}>
      <span className="max-sm:hidden">
        <QrTile value={link} alt={alt} />
      </span>
      <div className="flex min-w-0 flex-1 basis-40 flex-col items-start gap-2">
        <span className="max-w-full truncate font-mono text-xs text-fg-muted" title={link}>
          {link.replace(/^https?:\/\//, '')}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" iconStart={<ExternalLink aria-hidden />}>
            <a href={link} target="_blank" rel="noreferrer">
              {open}
            </a>
          </Button>
          <CopyButton value={link} label="Copy link" />
        </div>
      </div>
    </div>
  );
}
