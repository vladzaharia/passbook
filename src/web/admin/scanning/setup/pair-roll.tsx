import { RotateCw, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { Scan } from '@/web/portal/add/scan.tsx';
import { Buddy, Button, CopyButton, toast, useNow } from '@/web/ui/index.ts';
import type { Pairing } from '../pairing-face.tsx';
import { PAIRING_POLL_MS, useNewPairing, usePairingState } from '../scanner-api.ts';
import { formatCode, formatCountdown, pairingUrl } from '../scanners/labels.ts';
import './setup.css';

export interface PairDevice {
  id: string;
  name: string;
  pairing: Pairing | null;
}

/** One device's code: counts down, polls for the device, and asks for a new code when spent. */
export function PairSlot({
  device,
  onPaired,
  pollMs,
}: {
  device: PairDevice;
  onPaired: (id: string) => void;
  pollMs: number;
}) {
  const [pairing, setPairing] = useState(device.pairing);
  const [spent, setSpent] = useState(false);
  const newCode = useNewPairing(device.id);
  const now = useNow(1000, !spent);
  const state = usePairingState(device.id, !spent, pollMs);
  const left = pairing ? pairing.expiresAt - now : 0;
  useEffect(() => {
    if (state.data?.state === 'paired') onPaired(device.id);
    if (state.data?.state === 'expired') setSpent(true);
  }, [state.data, device.id, onPaired]);
  useEffect(() => {
    if (pairing && left <= 0) setSpent(true);
  }, [left, pairing]);
  if (!pairing) return null;
  const fresh = async () => {
    try {
      setPairing(await newCode.mutateAsync());
      setSpent(false);
    } catch (cause) {
      toast.error(cause, 'Could not make a code');
    }
  };
  return (
    <div className="wl-qr-turn" data-device={device.id}>
      <Scan
        url={pairingUrl(pairing.code)}
        label={`Pairing code for ${device.name}`}
        dim={spent}
        buddy={(p) =>
          spent ? (
            <Buddy {...p} mood="sad" state="expired" scene="beat" />
          ) : (
            <Buddy {...p} mood="happy" scene="cheer" />
          )
        }
        lead={
          <div className="wl-way">
            <p className="text-sm font-medium text-fg-strong">{device.name}</p>
            <p className="text-sm text-fg-muted">
              Open {window.location.host}/scan on the device and scan this.
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
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              loading={newCode.isPending}
              iconStart={<RotateCw aria-hidden />}
              onClick={() => void fresh()}
            >
              New code
            </Button>
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-fg-muted tabular-nums">
              <Timer aria-hidden className="size-4" />
              New code in {formatCountdown(left)}
            </p>
          )}
        </div>
      </Scan>
    </div>
  );
}

/**
 * One QR at a time. When a device pairs, the next device's code takes its place (a flip and a
 * sheen) and the count ticks. Segment pips show how many are done.
 */
export function PairRoll({
  devices,
  paired,
  onPaired,
  pollMs = PAIRING_POLL_MS,
}: {
  devices: readonly PairDevice[];
  paired: ReadonlySet<string>;
  onPaired: (id: string) => void;
  pollMs?: number;
}) {
  const next = devices.find((d) => !paired.has(d.id) && d.pairing);
  const all = devices.length > 0 && devices.every((d) => paired.has(d.id));
  return (
    <section aria-label="Pair devices" className="grid gap-4">
      {next ? <PairSlot key={next.id} device={next} onPaired={onPaired} pollMs={pollMs} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="text-sm font-semibold text-fg-strong tabular-nums">
          <span key={paired.size} className="wl-digit inline-block">
            {paired.size}
          </span>{' '}
          of {devices.length} paired
        </p>
        <span aria-hidden className="flex gap-1">
          {devices.map((d) => (
            <span
              key={`${d.id}-${paired.has(d.id)}`}
              className={cn(
                'h-1.5 w-6 origin-left rounded-full',
                paired.has(d.id) ? 'wl-pip-pop bg-success' : 'bg-border-strong',
              )}
            />
          ))}
        </span>
        {all ? <span className="text-sm text-success">All paired</span> : null}
      </div>
    </section>
  );
}
