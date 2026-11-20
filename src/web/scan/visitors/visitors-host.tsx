import { LogOut } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Visitor } from '../../../shared/contracts/visitors.ts';
import { VISITOR_COPY } from '../../../shared/copy/visitors.ts';
import { errorMessage } from '../../lib/errors.ts';
import { localDay, statusLine, whenLine } from '../../lib/visitors.ts';
import { Button } from '../../ui/button.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { Toaster, toast } from '../../ui/toaster.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { scanId } from '../platform/id.ts';
import './visitors.css';

/**
 * Today's visitors for the Desk: who is expected and who is in, with Check out. A check-in is the
 * ordinary scan of the pass; this sheet only reads the list and signs people out.
 */
export default function VisitorsHost({
  api,
  open,
  online,
  onClose,
}: {
  api: ScanApi;
  open: boolean;
  online: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Visitor[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.visitors(localDay())).items);
      setFailed(null);
    } catch (error) {
      setFailed(errorMessage(error));
    }
  }, [api]);
  useEffect(() => {
    if (open && online) void load();
  }, [open, online, load]);

  async function checkOut(v: Visitor) {
    setBusy(v.id);
    try {
      await api.signOutPerson({ idempotencyKey: scanId(), passId: v.passId, tag: 'none' });
      toast.success(`${VISITOR_COPY.desk.checkedOut}: ${v.name}`);
      await load();
    } catch (error) {
      toast.error(error, 'Could not check out');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Toaster />
      <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
        <SheetContent title={VISITOR_COPY.title} className="scan-detail-sheet">
          <div className="scan-visitors">
            {failed ? <p className="scan-visitors-note">{failed}</p> : null}
            {!online ? <p className="scan-visitors-note">Needs a connection.</p> : null}
            {items?.length === 0 ? (
              <p className="scan-visitors-note">{VISITOR_COPY.empty.today}</p>
            ) : null}
            <ul className="scan-visitors-list">
              {(items ?? []).map((v) => (
                <li key={v.id} className="scan-visitor" data-status={v.status}>
                  <div className="scan-visitor-main">
                    <span className="scan-visitor-name">{v.name}</span>
                    <span className="scan-visitor-meta">
                      {VISITOR_COPY.desk.host} {v.hostName} ·{' '}
                      {whenLine(v.windowFrom, v.windowUntil)}
                    </span>
                    {v.note ? <span className="scan-visitor-meta">{v.note}</span> : null}
                    <span className="scan-visitor-status">{statusLine(v)}</span>
                  </div>
                  {v.status === 'in' ? (
                    <span className="scan-visitor-act">
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busy === v.id}
                        iconStart={<LogOut aria-hidden />}
                        onClick={() => void checkOut(v)}
                      >
                        {VISITOR_COPY.desk.checkOut}
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
