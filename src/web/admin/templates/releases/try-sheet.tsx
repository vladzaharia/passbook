import { Check, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../../lib/cn.ts';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import { useSession } from '../../../lib/session.ts';
import { getBarcodeEngine, loadBarcodeEngine } from '../../../pass-card/barcode-engine.ts';
import { qrDataUri } from '../../../portal/holder-qr.tsx';
import {
  AppleWalletBadge,
  Badge,
  Buddy,
  Button,
  Callout,
  Celebrate,
  Sheet,
  SheetContent,
  Skeleton,
} from '../../../ui/index.ts';
import { useTemplate } from '../api.ts';
import { nextAction } from './next-action.ts';
import { type TryPhase, useOnPhone, useTryFlow } from './try-flow.ts';

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

type StepState = 'now' | 'done';
function Step({ state, children, aside }: { state: StepState; children: string; aside?: string }) {
  return (
    <li className="flex items-center gap-3 text-sm">
      <span
        aria-hidden
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full',
          state === 'done' ? 'bg-accent text-accent-on' : 'text-fg-muted',
        )}
      >
        {state === 'done' ? (
          <Check className="size-3" />
        ) : (
          <span className="size-4 rounded-full border-2 border-accent" />
        )}
      </span>
      <span className="flex-1 text-fg-strong">{children}</span>
      {aside ? <span className="truncate text-xs text-fg-muted">{aside}</span> : null}
    </li>
  );
}

function Waiting({
  publicUrl,
  downloadUrl,
  gaveUp,
}: {
  publicUrl: string;
  downloadUrl: string;
  gaveUp: boolean;
}) {
  const phone = useMediaQuery(PHONE);
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
        </>
      )}
      <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
        <span aria-hidden className="size-2 rounded-full bg-warning" />
        {gaveUp ? 'Still not on your phone. Scan again.' : 'Waiting for your phone'}
      </p>
    </div>
  );
}

function Stage({ phase, onRetry }: { phase: TryPhase; onRetry: () => void }) {
  const watch = useOnPhone(phase.step === 'waiting' ? phase.pass.id : undefined);
  if (phase.step === 'failed')
    return (
      <Callout
        tone="danger"
        actions={
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {phase.message}
      </Callout>
    );
  if (phase.step !== 'waiting')
    return (
      <div role="status" aria-busy className="py-6">
        <Skeleton className="mx-auto size-24 rounded-lg" />
        <span className="sr-only">Making your pass</span>
      </div>
    );
  if (watch.on)
    return (
      <div className="relative flex flex-col items-center gap-3 py-4">
        <span className="relative grid size-14 place-items-center rounded-full bg-success text-white">
          <Check aria-hidden className="size-7" />
          <Celebrate when />
        </span>
        <p role="status" className="text-sm font-semibold text-fg-strong">
          On your phone
        </p>
      </div>
    );
  return (
    <Waiting
      publicUrl={phase.pass.publicUrl}
      downloadUrl={phase.pass.downloadUrl}
      gaveUp={watch.gaveUp}
    />
  );
}

/**
 * Try on my phone: a drawer that releases the version to Test, makes a Test pass from the sample,
 * shows the QR (or Add to Apple Wallet on a phone) and waits for the phone to register. Release
 * sits in the footer once it has.
 */
export default function TrySheet({
  templateId,
  orgId,
  version,
  name,
  onClose,
  onRelease,
}: {
  templateId: string;
  orgId: string;
  version: string;
  name: (hash: string | null) => string;
  onClose: () => void;
  onRelease: (version: string) => void;
}) {
  const detail = useTemplate(templateId, orgId);
  const email = useSession().authed?.user.primaryEmail ?? null;
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        title="Try on my phone"
        header={
          <span className="flex items-center gap-2">
            <span className="text-base font-semibold text-fg-strong">Try on my phone</span>
            <Badge tone="warning">Test</Badge>
          </span>
        }
        className="sm:w-[26rem]"
      >
        {detail.data ? (
          <Body
            templateId={templateId}
            orgId={orgId}
            version={version}
            label={name(version)}
            sample={detail.data.sample}
            email={email}
            holder={detail.data.name}
            onClose={onClose}
            onRelease={onRelease}
          />
        ) : (
          <div role="status" aria-busy className="p-4">
            <Skeleton className="h-32" />
            <span className="sr-only">Loading template</span>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Body({
  templateId,
  orgId,
  version,
  label,
  sample,
  email,
  holder,
  onClose,
  onRelease,
}: {
  templateId: string;
  orgId: string;
  version: string;
  label: string;
  sample: Record<string, unknown>;
  email: string | null;
  holder: string;
  onClose: () => void;
  onRelease: (version: string) => void;
}) {
  const input = useMemo(
    () => ({ templateId, orgId, version, sample, email }),
    [templateId, orgId, version, sample, email],
  );
  const { phase, retry } = useTryFlow(input);
  const watch = useOnPhone(phase.step === 'waiting' ? phase.pass.id : undefined);
  const made = phase.step === 'waiting';
  const released = phase.step === 'making' || made;
  const release = made ? nextAction(phase.result.state.next, label) : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          <Step state={released ? 'done' : 'now'}>{`Release ${label} to Test`}</Step>
          {released ? (
            <Step state={made ? 'done' : 'now'} {...(made ? { aside: holder } : {})}>
              Make your pass
            </Step>
          ) : null}
        </ol>
        <div className="relative mt-16">
          <div aria-hidden>
            <Buddy
              key={watch.on ? 'on' : 'wait'}
              mood={watch.on ? 'happy' : 'curious'}
              scene={watch.on ? 'cheer' : 'peek'}
              size="sm"
            />
          </div>
          <div className="rounded-lg border border-border bg-surface-raised px-4 pt-8 pb-4">
            <Stage phase={phase} onRetry={retry} />
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-4">
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
        {release ? (
          <Button
            iconStart={<Send aria-hidden />}
            disabled={!watch.on}
            onClick={() => {
              onClose();
              onRelease(version);
            }}
          >
            {release.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
