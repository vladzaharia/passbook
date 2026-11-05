import { Loader2, RotateCw, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { Mode } from '@/shared/contracts/common.ts';
import type { ScannerPairingSchema } from '@/shared/contracts/scanners.ts';
import { Scan } from '@/web/portal/add/scan.tsx';
import { Buddy, Button, CopyButton, toast } from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import './pairing.css';
import { PAIRING_POLL_MS, useNewPairing, usePairHere, usePairingState } from './scanner-api.ts';
import { formatCode, formatCountdown, pairingUrl } from './scanners/labels.ts';

export type Pairing = z.infer<typeof ScannerPairingSchema>;

export interface PairingFaceProps {
  scanner: { id: string; name: string; mode: Mode };
  /** The code to show first; "New code" replaces it. */
  pairing: Pairing;
  onClose: () => void;
  pollMs?: number;
}

/** Seconds-grained clock for the countdown only; nothing else re-renders on it. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * The pairing face, shared by New scanner, Pair and Pair again: the code as a QR on the buddy's
 * sign and typed, a countdown, and a poll for the scanner. Paired, the buddy waves once; spent,
 * it droops and the QR dims.
 */
export function PairingFace({
  scanner,
  pairing: first,
  onClose,
  pollMs = PAIRING_POLL_MS,
}: PairingFaceProps) {
  const [pairing, setPairing] = useState(first);
  const newCode = useNewPairing(scanner.id);
  const pairHere = usePairHere(scanner.id);
  const [paired, setPaired] = useState<{ label: string; at: number }>();
  const [spent, setSpent] = useState(false);
  const now = useClock(!paired && !spent);
  const left = pairing.expiresAt - now;
  const state = usePairingState(scanner.id, !paired && !spent, pollMs);

  useEffect(() => {
    const s = state.data;
    if (s?.state === 'paired') setPaired(s.device ?? { label: 'A device', at: Date.now() });
    if (s?.state === 'expired') setSpent(true);
  }, [state.data]);
  useEffect(() => {
    if (!paired && left <= 0) setSpent(true);
  }, [left, paired]);

  const fresh = async () => {
    try {
      setPairing(await newCode.mutateAsync());
      setSpent(false);
    } catch (cause) {
      toast.error(cause, 'Could not make a code');
    }
  };
  const here = () =>
    pairHere
      .mutateAsync()
      .then(() => {
        window.open(`${window.location.origin}/scan`, '_blank', 'noopener');
      })
      .catch((cause: unknown) => toast.error(cause, 'Could not pair this browser'));

  if (paired) {
    return (
      <div className="flex flex-col gap-4" data-phase="paired">
        <Scan
          url={pairingUrl(pairing.code)}
          label={`Pairing code for ${scanner.name}`}
          dim
          buddy={(p) => <Buddy {...p} mood="happy" scene="wave" />}
          lead={
            <div className="wl-way">
              <p className="wl-way-label">
                <Smartphone aria-hidden />
                {scanner.name} is paired
              </p>
              <p className="text-sm text-fg-muted">{paired.label} · Paired just now</p>
            </div>
          }
        />
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  const host = window.location.host;
  return (
    <div className="flex flex-col gap-4" data-phase={spent ? 'expired' : 'waiting'}>
      <Scan
        url={pairingUrl(pairing.code)}
        label={`Pairing code for ${scanner.name}`}
        dim={spent}
        buddy={(p) =>
          spent ? <Buddy {...p} mood="sad" state="expired" scene="beat" /> : <Buddy {...p} />
        }
        lead={
          <div className="wl-way">
            <p className="wl-way-label">
              <Smartphone aria-hidden />
              On the scanner
            </p>
            <p className="text-sm text-fg-muted">
              Open {host}/scan and scan this code, or type it.
            </p>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <code className="font-mono text-base tracking-[0.12em] text-fg-strong">
              {formatCode(pairing.code)}
            </code>
            <CopyButton value={formatCode(pairing.code)} label="Copy code" />
          </div>
          {spent ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-fg-muted">Code expired.</p>
              <Button
                variant="outline"
                size="sm"
                loading={newCode.isPending}
                iconStart={<RotateCw aria-hidden />}
                onClick={() => void fresh()}
              >
                New code
              </Button>
            </div>
          ) : (
            <p className="text-sm text-fg-muted tabular-nums">Expires in {formatCountdown(left)}</p>
          )}
          <p className="text-xs text-fg-muted">Using the Home Screen app? Pair inside it.</p>
        </div>
      </Scan>
      <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
        {spent ? null : (
          <>
            <Loader2 aria-hidden className="size-4 wl-spin wl-essential" />
            Waiting for the scanner…
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2 max-sm:flex-col-reverse max-sm:items-stretch">
        <ModePill mode={scanner.mode} />
        <div className="flex gap-2 max-sm:flex-col-reverse">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button variant="outline" loading={pairHere.isPending} onClick={() => void here()}>
            Pair this browser
          </Button>
        </div>
      </div>
    </div>
  );
}
