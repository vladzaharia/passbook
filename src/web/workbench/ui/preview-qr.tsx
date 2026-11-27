import { ExternalLink } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { Button } from '../../ui/button.tsx';
import { CopyButton } from '../../ui/copy-button.tsx';
import { QrTile } from './qr-tile.tsx';

/** A pass's own link, absolute: the QR must open on another device. */
export const absoluteUrl = (url: string): string =>
  url.startsWith('/') ? `${location.origin}${url}` : url;

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
