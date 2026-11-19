import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, toast, useNow } from '../ui/index.ts';
import { myPassesKey, requestRefresh } from './api.ts';
import { type RefreshFields, refreshPhase } from './refresh.ts';

/**
 * State of a pass's refresh. While pending the foil
 * rail runs under the card; when the pass lands the card mints, "Pass updated" toasts and the
 * button's `done` changes.
 */
export function useRefresh(passId: string, pass: RefreshFields) {
  const client = useQueryClient();
  const [localRequestedAt, setLocal] = useState<number | null>(null);
  const [cooldownMs, setCooldownMs] = useState<number | undefined>(undefined);
  const [active, setActive] = useState(false);
  const [updated, setUpdated] = useState(0);
  const ticking = useNow(1000, active);
  const now = active ? ticking : Date.now();
  const { phase, secondsLeft } = refreshPhase(pass, now, localRequestedAt, cooldownMs);
  const prev = useRef(phase);

  const mutation = useMutation({
    mutationFn: async () => ({ clickedAt: Date.now(), res: await requestRefresh(passId) }),
    onSuccess: ({ clickedAt, res }) => {
      // The server coalesces clicks inside its cooldown and echoes the earlier request.
      if (res.requestedAt < clickedAt - 5000) toast.info('Refresh already requested.');
      setLocal(res.requestedAt);
      setCooldownMs(res.cooldownSeconds * 1000);
      setActive(true);
      void client.invalidateQueries({ queryKey: myPassesKey });
    },
    onError: (error) => toast.error(error, 'Could not refresh'),
  });

  useEffect(() => {
    // Keep ticking only while there is something to count down.
    setActive(phase !== 'idle');
    const requested = Math.max(pass.refreshRequestedAt ?? 0, localRequestedAt ?? 0);
    const done = (pass.lastRefreshedAt ?? 0) >= requested;
    if (prev.current === 'pending' && phase !== 'pending' && done) {
      toast.success('Pass updated');
      setUpdated((n) => n + 1);
    }
    prev.current = phase;
  }, [phase, pass.lastRefreshedAt, pass.refreshRequestedAt, localRequestedAt]);

  const label =
    phase === 'pending'
      ? 'Refreshing'
      : phase === 'cooldown'
        ? `Refresh in ${secondsLeft}s`
        : 'Refresh';

  const pending = phase === 'pending' || mutation.isPending;
  return { phase, label, pending, updated, request: () => mutation.mutate() };
}

export type Refresh = ReturnType<typeof useRefresh>;

/** The icon button beside a tile's badge: the label (and countdown) is its name and tooltip. */
export function RefreshIconButton({
  refresh,
  className,
}: {
  refresh: Refresh;
  className?: string;
}) {
  const { phase, label, pending } = refresh;
  return (
    <IconButton
      label={label}
      variant="outline"
      size="badge"
      {...(className ? { className } : {})}
      aria-busy={pending || undefined}
      disabled={pending || phase === 'cooldown'}
      icon={<RefreshCw aria-hidden className={pending ? 'wl-spin wl-essential' : undefined} />}
      onClick={refresh.request}
    />
  );
}

/** Refresh in the pass page's header (the tile's is RefreshIconButton). */
export function RefreshButton({ passId, pass }: { passId: string; pass: RefreshFields }) {
  const { phase, label, pending, updated, request } = useRefresh(passId, pass);
  return (
    <Button
      variant="outline"
      iconStart={<RefreshCw aria-hidden />}
      loading={pending}
      busy="spin"
      done={updated || undefined}
      disabled={phase === 'cooldown'}
      onClick={request}
      title={phase === 'pending' ? 'Wallet may take a minute to update' : undefined}
    >
      {/* Pending keeps the word, so the button holds its width; the spin and aria-busy say it. */}
      {phase === 'pending' ? 'Refresh' : label}
    </Button>
  );
}
