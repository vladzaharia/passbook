import { Link } from '@tanstack/react-router';
import { Copy, Printer, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { JOIN_COPY } from '@/shared/copy/join.ts';
import { copyText } from '../../../lib/clipboard.ts';
import { Button } from '../../../ui/index.ts';
import { useJoinQr } from './join-qr.ts';

/** The link, its QR and the three things to do with it. Dimmed while the link is off. */
export function JoinShare({
  url,
  open,
  templateId,
  orgId,
  canRotate,
  onRotate,
}: {
  url: string;
  open: boolean;
  templateId: string;
  orgId: string | undefined;
  canRotate: boolean;
  onRotate: () => void;
}) {
  const qr = useJoinQr(url);
  const [copies, setCopies] = useState(0);
  return (
    <div className="jl-share flex flex-col gap-4 sm:flex-row sm:items-center" data-open={open}>
      <span className="jl-qr grid size-28 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-white">
        {qr.src ? (
          <img src={qr.src} alt={`QR code for ${url}`} className="block size-full" />
        ) : qr.failed ? (
          <span className="px-2 text-center text-xs text-danger">{HOLDER_COPY.qrFailed}</span>
        ) : (
          <span role="img" aria-label="QR code" aria-busy="true" className="block size-full" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="truncate font-mono text-xs text-fg-muted" title={url}>
          {url}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            iconStart={<Copy aria-hidden />}
            done={copies}
            onClick={async () => {
              if (await copyText(url, 'link')) setCopies((n) => n + 1);
            }}
          >
            {JOIN_COPY.card.copy}
          </Button>
          <Button variant="outline" iconStart={<Printer aria-hidden />} asChild>
            <Link
              to="/admin/templates/$templateId/join-sign"
              params={{ templateId }}
              search={{ orgId }}
            >
              {JOIN_COPY.card.print}
            </Link>
          </Button>
          <Button
            variant="ghost"
            iconStart={<RefreshCw aria-hidden />}
            disabled={!canRotate}
            onClick={onRotate}
          >
            {JOIN_COPY.card.rotate}
          </Button>
        </div>
        {canRotate ? null : <p className="text-xs text-fg-muted">{JOIN_COPY.card.askAdmin}</p>}
      </div>
    </div>
  );
}
