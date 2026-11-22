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
  CopyButton,
  Sheet,
  SheetContent,
  Skeleton,
  Spinner,
} from '../../../ui/index.ts';
import { useTemplate } from '../api.ts';
import { nextAction } from './next-action.ts';
import { type TryPhase, useOnPhone, useTryFlow } from './try-flow.ts';

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

function Step({
  state,
  children,
  aside,
}: {
  state: 'now' | 'done';
  children: string;
  aside?: string | undefined;
}) {
  return (
    <li className="flex items-center gap-3 text-sm">
      <span
        aria-hidden
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full',
          state === 'done' && 'wl-step-done bg-accent text-accent-on',
        )}
      >
        {state === 'done' ? <Check className="size-3" /> : <Spinner label="" className="size-4" />}
      </span>
      <span className="flex-1 text-fg-strong">
        {children}
        <span className="sr-only">{state === 'done' ? ': done' : ': in progress'}</span>
      </span>
      {aside ? <span className="truncate text-xs text-fg-muted">{aside}</span> : null}
    </li>
  );
}

type Watch = ReturnType<typeof useOnPhone>;

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
          <p className="text-sm text-fg-muted">Not on your phone yet.</p>
          <Button size="sm" variant="outline" onClick={watch.again}>
            Check again
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <span
            aria-hidden
            className="wl-essential size-2 rounded-full bg-warning"
            style={{ animation: 'wl-pulse 1.2s ease-in-out infinite alternate' }}
          />
          Waiting for your phone
        </p>
      )}
    </div>
  );
}

function Stage({ phase, watch, onRetry }: { phase: TryPhase; watch: Watch; onRetry: () => void }) {
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
      <div aria-busy className="py-6">
        <Skeleton className="mx-auto size-24 rounded-lg" />
      </div>
    );
  if (watch.on)
    return (
      <div className="wl-rise flex flex-col items-center gap-3 py-4">
        <span className="wl-step-done relative grid size-14 place-items-center rounded-full bg-success text-white">
          <Check aria-hidden className="size-7" />
          <Celebrate when radius={30} delay={150} />
        </span>
        <p className="text-sm font-semibold text-fg-strong">On your phone</p>
      </div>
    );
  return (
    <Waiting publicUrl={phase.pass.publicUrl} downloadUrl={phase.pass.downloadUrl} watch={watch} />
  );
}

/**
 * Try on my phone: a drawer (a bottom sheet on a phone) that releases the version to Test, makes a
 * Test pass from the sample, shows the QR (or Add to Apple Wallet) and waits for the phone to
 * register. Release sits in the footer; it is never blocked, it only leads once the phone is on.
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
  const user = useSession().authed?.user;
  const phone = useMediaQuery(PHONE);
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        title="Try on my phone"
        side={phone ? 'bottom' : 'right'}
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
            email={user?.primaryEmail ?? null}
            holder={user?.name ?? user?.primaryEmail ?? undefined}
            onClose={onClose}
            onRelease={onRelease}
          />
        ) : (
          <div aria-busy className="p-4">
            <Skeleton className="h-32" />
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
  holder: string | undefined;
  onClose: () => void;
  onRelease: (version: string) => void;
}) {
  const input = useMemo(
    () => ({ templateId, orgId, version, sample, email }),
    [templateId, orgId, version, sample, email],
  );
  const { phase, retry, attempt } = useTryFlow(input);
  const watch = useOnPhone(phase.step === 'waiting' ? phase.pass.id : undefined);
  const made = phase.step === 'waiting';
  const released = phase.step === 'making' || made;
  const release = made ? nextAction(phase.result.state.next, label) : null;
  // One live region for the whole sheet: it exists before its text changes, so it is announced.
  const said =
    phase.step === 'releasing'
      ? `Releasing ${label} to Test`
      : phase.step === 'making'
        ? 'Making your pass'
        : phase.step === 'failed'
          ? phase.message
          : watch.on
            ? 'On your phone'
            : watch.gaveUp
              ? 'Not on your phone yet'
              : 'Waiting for your phone';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p role="status" className="sr-only">
        {said}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          <Step state={released ? 'done' : 'now'}>{`Release ${label} to Test`}</Step>
          {released ? (
            <Step state={made ? 'done' : 'now'} aside={made ? holder : undefined}>
              Make your pass
            </Step>
          ) : null}
        </ol>
        <div className="relative mt-16">
          <div aria-hidden>
            <Buddy
              key={watch.on ? 'on' : phase.step === 'failed' ? 'failed' : 'wait'}
              mood={watch.on ? 'happy' : phase.step === 'failed' ? 'sad' : 'curious'}
              scene={watch.on ? 'cheer' : phase.step === 'failed' ? 'plug' : 'tuck'}
              replay={attempt}
              size="sm"
            />
          </div>
          <div className="rounded-lg border border-border bg-surface-raised px-4 pt-8 pb-4">
            <Stage phase={phase} watch={watch} onRetry={retry} />
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-4">
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
        {release ? (
          <Button
            variant={watch.on ? 'primary' : 'outline'}
            iconStart={<Send aria-hidden />}
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
