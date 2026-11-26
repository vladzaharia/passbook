import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, IconButton, toast, useNow } from '../ui/index.ts';
import { isTerminal, useOperation } from '../ui/operation/index.ts';
import { myPassesKey, requestRefresh } from './api.ts';
import { useHolderOperations } from './holder-operations.tsx';
import { type RefreshFields, type RefreshPhase, refreshPhase } from './refresh.ts';

/**
 * State of a pass's refresh. The server answers a click with an operation; while it runs the foil
 * rail runs under the card, and when it ends "Pass updated" says so (the activity tray) and the
 * button's `done` changes. A failure opens the sheet with Retry. Without an operation (an earlier
 * refresh covers the click, or an admin asked) the pass's own fields say whether one is pending.
 */
export function useRefresh(passId: string, pass: RefreshFields) {
  const client = useQueryClient();
  const { follow } = useHolderOperations();
  const [localRequestedAt, setLocal] = useState<number | null>(null);
  const [cooldownMs, setCooldownMs] = useState<number | undefined>(undefined);
  const [opId, setOpId] = useState<string | null>(null);
  const { operation } = useOperation(opId);
  const running = operation !== undefined && !isTerminal(operation.status);
  const [active, setActive] = useState(false);
  const [updated, setUpdated] = useState(0);
  const ticking = useNow(1000, active);
  const now = active ? ticking : Date.now();
  // Once the operation has ended, the fields may not have caught up yet: its end is the answer.
  const fields =
    operation && !running
      ? { ...pass, lastRefreshedAt: Math.max(pass.lastRefreshedAt ?? 0, localRequestedAt ?? 0) }
      : pass;
  const served = refreshPhase(fields, now, localRequestedAt, cooldownMs);
  const phase: RefreshPhase = running ? 'pending' : served.phase;
  const secondsLeft = served.secondsLeft;

  const mutation = useMutation({
    mutationFn: async () => ({ clickedAt: Date.now(), res: await requestRefresh(passId) }),
    onSuccess: ({ clickedAt, res }) => {
      // The server coalesces clicks inside its cooldown and echoes the earlier request.
      if (res.requestedAt < clickedAt - 5000) toast.info('Refresh already requested.');
      setLocal(res.requestedAt);
      setCooldownMs(res.cooldownSeconds * 1000);
      setActive(true);
      if (res.operationId) {
        setOpId(res.operationId);
        follow(res.operationId, { restart: () => mutation.mutate(), open: false });
      }
      void client.invalidateQueries({ queryKey: myPassesKey });
    },
    onError: (error) => toast.error(error, 'Could not refresh'),
  });

  const succeeded = operation?.status === 'succeeded';
  useEffect(() => {
    if (succeeded) setUpdated((n) => n + 1);
  }, [succeeded]);
  useEffect(() => {
    // Keep ticking only while there is something to count down.
    setActive(phase !== 'idle');
  }, [phase]);

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
