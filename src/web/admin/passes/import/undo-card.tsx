import { useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Button, ConfirmDialog, toast } from '../../../ui/index.ts';
import { emailTheRest } from './api.ts';
import { type UndoResult, undoImport } from './api-run.ts';

const DAY = 24 * 60 * 60_000;
const RING = 2 * Math.PI * 14;

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Now, ticking each second while `on`. */
function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** What an undo did: removed, restored, emails that will not go out, and what stayed. */
export function UndoSummary({ result }: { result: UndoResult }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-sunken p-4 text-sm">
      <p role="status" className="font-medium text-fg-strong">
        {result.state === 'running' ? `${C.undo.undoing}. ` : ''}
        {C.undo.tally(result.removed, result.restored, result.emailsCancelled)}
      </p>
      {result.unrevertable ? (
        <p className="text-fg-muted">{C.undo.unrevertable(result.unrevertable)}</p>
      ) : null}
      {result.keptTotal > 0 ? (
        <p className="text-fg-muted">{C.undo.kept(result.keptTotal)}</p>
      ) : null}
    </div>
  );
}

/**
 * The undo window: a ring counts down to the held emails, with Undo import and Send now. After the
 * emails go, undo stays for 24 hours and recalls nothing.
 */
export function UndoCard({
  imp,
  orgId,
  onUndone,
}: {
  imp: PassImportDto;
  orgId: string;
  onUndone: (r: UndoResult) => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [working, setWorking] = useState(false);
  const [sending, setSending] = useState(false);
  const p = imp.progress;
  const hold = imp.emailHoldUntil ?? null;
  const held = p?.notEmailed ?? 0;
  const now = useTicking(hold !== null);
  const holding = hold !== null && hold > now && held > 0;
  const finished = imp.finishedAt ?? imp.committedAt ?? now;
  const live = (p?.created ?? 0) - (p?.removed ?? 0) + (p?.updated ?? 0) > 0;
  // An expiry that passed while the page was open: read the import again for the emails sent.
  useEffect(() => {
    if (hold !== null && hold <= now && held > 0)
      void qc.invalidateQueries({ queryKey: ['admin', 'pass-imports'] });
  }, [hold, now, held, qc]);
  if (!live || finished + DAY < now) return null;
  const share =
    holding && hold ? Math.max(0, Math.min(1, (hold - now) / Math.max(1, hold - finished))) : 0;

  async function sendNow() {
    setSending(true);
    try {
      const r = await emailTheRest(qc, imp.id, orgId);
      toast.sent(C.results.emailed(r.sent, r.skipped));
    } catch (e) {
      toast.error(e, C.results.couldNotEmail);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border border-border p-4">
      {holding ? (
        <svg viewBox="0 0 32 32" aria-hidden className="size-9 shrink-0 -rotate-90">
          <circle
            cx="16"
            cy="16"
            r="14"
            fill="none"
            strokeWidth="3"
            className="stroke-surface-sunken"
          />
          <circle
            cx="16"
            cy="16"
            r="14"
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - share)}
            className="stroke-accent motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-linear"
          />
        </svg>
      ) : null}
      <p className="min-w-0 flex-1 text-sm text-fg-muted">
        {holding && hold ? (
          <>
            <b className="tabular-nums text-fg-strong">{clock(hold - now)}</b> {C.undo.until(held)}
          </>
        ) : (
          C.undo.window
        )}
        {imp.unrevertable ? ` ${C.undo.unrevertable(imp.unrevertable)}` : ''}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          loading={working}
          iconStart={<Undo2 aria-hidden />}
          onClick={() => setConfirm(true)}
        >
          {C.undo.button}
        </Button>
        {holding ? (
          <Button variant="ghost" loading={sending} onClick={sendNow}>
            {C.undo.sendNow}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={C.undo.title}
        description={C.undo.body(holding)}
        confirmLabel={C.undo.confirm}
        destructive
        onConfirm={async () => {
          setConfirm(false);
          setWorking(true);
          try {
            onUndone(await undoImport(qc, imp.id, orgId));
          } catch (e) {
            toast.error(e, C.results.couldNotRemove);
          } finally {
            setWorking(false);
          }
        }}
      />
    </div>
  );
}
