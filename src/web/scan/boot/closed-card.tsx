import { useEffect, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCAN_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { whenIn } from '../../../shared/session-window.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { isApiError } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { toFail } from '../api/to-fail.ts';
import type { PinNote } from '../machine/types.ts';
import { ApprovalSheet } from '../result/approval-sheet.tsx';
import { BootCard } from '../ui/boot-card.tsx';

/** The session is active but outside its hours: when it opens, and Open now for a Manager. */
export function ClosedCard({
  session,
  api,
  refetch,
}: {
  session: ScanSession;
  api: ScanApi;
  refetch: () => Promise<void>;
}) {
  const workspace = session.workspace?.session;
  const opensAt = workspace?.window?.opensAt ?? null;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<PinNote>();
  const [error, setError] = useState('');
  // A signed-in Manager (or an admin) opens straight away; anyone else gives a manager's code.
  const manager = session.principal === 'admin' || session.staff?.role === 'manager';
  const managers = (session.staffList ?? []).filter((m) => m.role === 'manager');
  async function open(approval?: { staffId?: string; pin: string }) {
    setBusy(true);
    setError('');
    setNote(undefined);
    try {
      await api.openNow(approval ? { approval } : {});
      await refetch();
    } catch (cause) {
      // Someone opened it first: say so, and reload so the scanner shows.
      if (isApiError(cause) && cause.code === 'SCANNING_SESSION_OPEN') {
        setError(SCAN_COPY.closed.alreadyOpen);
        await refetch();
        return;
      }
      const fail = toFail(cause);
      if (fail.error === 'pin_invalid') setNote({ triesLeft: fail.triesLeft ?? 0 });
      else if (fail.error === 'pin_locked')
        setNote({
          locked: true,
          ...(fail.retryAfterMs ? { retryAfterMs: fail.retryAfterMs } : {}),
        });
      else
        setError(
          fail.error === 'forbidden' ? SCAN_COPY.closed.managerOnly : SCAN_COPY.closed.failed,
        );
    } finally {
      setBusy(false);
    }
  }
  const line = opensAt
    ? scanLine(SCAN_COPY.closed.opens, {
        when: whenIn(opensAt, workspace?.timeZone ?? DEFAULT_TIME_ZONE, Date.now()),
      })
    : SCAN_COPY.closed.noOpening;
  // A live region fills after it mounts, so a screen reader hears the change.
  const [said, setSaid] = useState('');
  useEffect(() => setSaid(`${SCAN_COPY.closed.headline}. ${line}`), [line]);
  return (
    <BootCard title={SCAN_COPY.closed.headline} line={line} mood="flat" still testId="scan-closed">
      <p role="status" aria-live="polite" className="scan-sr">
        {said}
      </p>
      {asking ? (
        <ApprovalSheet
          managers={managers}
          code={session.staffList === null}
          action={SCAN_COPY.closed.openNowTitle}
          note={note}
          onApprove={(staffId, pin) => void open({ ...(staffId ? { staffId } : {}), pin })}
          onCancel={() => {
            setAsking(false);
            setNote(undefined);
          }}
        />
      ) : (
        <>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Button loading={busy} onClick={() => (manager ? void open() : setAsking(true))}>
            {SCAN_COPY.closed.openNow}
          </Button>
          <Button variant="outline" onClick={() => void refetch()}>
            {SCAN_COPY.closed.check}
          </Button>
        </>
      )}
    </BootCard>
  );
}
