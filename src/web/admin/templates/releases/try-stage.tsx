import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import { getBarcodeEngine, loadBarcodeEngine } from '../../../pass-card/barcode-engine.ts';
import { qrDataUri } from '../../../portal/holder-qr.tsx';
import { AppleWalletBadge, Button, Celebrate, CopyButton, Skeleton } from '../../../ui/index.ts';
import type { TryPhase, useOnPhone } from './try-flow.ts';

/** The iPhone branch: a touch screen of phone width, not just a narrow window. */
const PHONE_TOUCH = `${PHONE} and (pointer: coarse)`;

/** The pass's add link as a QR; empty until the encoder has loaded. */
function useQr(text: string): string | null {
  const [engine, setEngine] = useState(getBarcodeEngine);
  useEffect(() => {
    if (engine) return;
    let live = true;
    void loadBarcodeEngine().then(
      (e) => live && setEngine(() => e),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [engine]);
  return engine ? qrDataUri(engine, text) : null;
}

export type Watch = ReturnType<typeof useOnPhone>;

function Waiting({
  publicUrl,
  downloadUrl,
  watch,
}: {
  publicUrl: string;
  downloadUrl: string;
  watch: Watch;
}) {
  const phone = useMediaQuery(PHONE_TOUCH);
  const qr = useQr(publicUrl);
  return (
    <div className="flex flex-col items-center gap-3">
      {phone ? (
        <>
          <p className="text-sm font-medium text-fg-strong">Add it to your iPhone.</p>
          <AppleWalletBadge href={downloadUrl} />
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-fg-strong">Scan with your iPhone camera.</p>
          <span className="grid size-48 place-items-center rounded-lg border border-border bg-white p-2">
            {qr ? (
              <img src={qr} alt="QR code to add the pass" className="size-full" />
            ) : (
              <Skeleton className="size-full" />
            )}
          </span>
          <span className="flex items-center gap-1 text-xs text-fg-muted">
            Or send yourself the link
            <CopyButton value={publicUrl} label="Copy link" />
          </span>
        </>
      )}
      {watch.gaveUp ? (
        <div className="flex flex-col items-center gap-2">
          <Button size="sm" variant="outline" onClick={watch.again}>
            Check again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function Stage({ phase, watch }: { phase: TryPhase; watch: Watch }) {
  if (phase.step !== 'waiting')
    return (
      <div aria-busy className="py-6">
        <Skeleton className="mx-auto size-24 rounded-lg" />
      </div>
    );
  if (watch.on)
    return (
      <div className="wl-rise flex flex-col items-center gap-3 py-4">
        <span className="wl-step-done relative grid size-14 place-items-center rounded-full bg-success text-white">
          <Check aria-hidden className="size-7" />
          <Celebrate when radius={30} delay={150} size="lg" />
        </span>
      </div>
    );
  return (
    <Waiting publicUrl={phase.pass.publicUrl} downloadUrl={phase.pass.downloadUrl} watch={watch} />
  );
}
