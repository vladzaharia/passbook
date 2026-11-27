import { useNavigate } from '@tanstack/react-router';
import { QrCode, Ticket } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { wbPath } from '@/shared/workbench.ts';
import { useDesigner } from '../../admin/templates/designer/context.tsx';
import { useDesignerHost } from '../../admin/templates/designer/host.tsx';
import { Button } from '../../ui/button.tsx';
import { CopyButton } from '../../ui/copy-button.tsx';
import { Dialog, DialogContent } from '../../ui/dialog.tsx';
import { IconButton } from '../../ui/icon-button.tsx';
import { toast } from '../../ui/toaster.tsx';
import { useOptionalToolHost } from '../host/tool-host.tsx';
import { QrTile } from '../ui/qr-tile.tsx';
import { takeIssueFocus } from './issue-focus.ts';
import { sampleOf } from './sample.ts';
import { useOpenTemplate } from './template-context.tsx';

type Issued = { id: string; downloadUrl: string };

/** Issues a Test pass from the template's Test release with the sample on screen. */
export function useIssue() {
  const { issueTest } = useDesignerHost();
  const { doc } = useDesigner();
  const { id } = useOpenTemplate();
  const [busy, setBusy] = useState(false);
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);
  async function issue(): Promise<Issued | null> {
    if (!issueTest || busy) return null;
    setBusy(true);
    try {
      const pass = await issueTest({ templateId: id, input: sampleOf(doc) });
      return { id: pass.id, downloadUrl: pass.downloadUrl };
    } catch (cause) {
      toast.error(cause, WB_DESIGN.phone.failed);
      return null;
    } finally {
      if (!gone.current) setBusy(false);
    }
  }
  return { issue, busy, can: Boolean(issueTest) };
}

const absolute = (url: string) => (url.startsWith('/') ? `${location.origin}${url}` : url);

/**
 * Try on my phone (design §3.4). In an org's Test it issues a test pass and shows its own Add to
 * Wallet link as a QR. In a sandbox the device-pass install is not built yet (S4), so the dialog
 * says so and names the pass it made; nothing pretends to install.
 */
export function TryOnPhone({ icon = false }: { icon?: boolean }) {
  const { issue, busy, can } = useIssue();
  const host = useOptionalToolHost();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [open, setOpen] = useState(false);
  if (!can) return null;
  const run = async () => {
    const made = await issue();
    if (!made) return;
    setIssued(made);
    setOpen(true);
  };
  const sandbox = host?.context.kind === 'sandbox';
  return (
    <>
      {icon ? (
        <IconButton
          label={WB_DESIGN.phone.action}
          icon={<QrCode aria-hidden />}
          variant="outline"
          disabled={busy}
          onClick={() => void run()}
        />
      ) : (
        <Button
          variant="outline"
          iconStart={<QrCode aria-hidden />}
          loading={busy}
          onClick={() => void run()}
        >
          {WB_DESIGN.phone.action}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={WB_DESIGN.phone.title}
          size="sm"
          footer={
            <>
              <Button variant="outline" loading={busy} onClick={() => void run()}>
                {WB_DESIGN.phone.again}
              </Button>
              <Button onClick={() => setOpen(false)}>{WB_DESIGN.phone.done}</Button>
            </>
          }
        >
          {issued ? (
            <div className="grid justify-items-center gap-3 text-center">
              {sandbox ? (
                <p className="text-sm text-fg-muted">{WB_DESIGN.phone.sandbox}</p>
              ) : (
                <>
                  <QrTile
                    value={absolute(issued.downloadUrl)}
                    alt="QR code of the Add to Wallet link"
                    className="grid size-44 place-items-center rounded-lg bg-white p-2"
                  />
                  <p className="text-sm text-fg-muted">{WB_DESIGN.phone.scan}</p>
                  <CopyButton value={absolute(issued.downloadUrl)} label={WB_DESIGN.phone.link} />
                </>
              )}
              <p className="font-mono text-xs text-fg-muted">{issued.id}</p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Issue test pass: a pass of the template's Test release with this sample, named in a toast with its way to Passes. */
export function IssueTestPass() {
  const { issue, busy, can } = useIssue();
  const host = useOptionalToolHost();
  const navigate = useNavigate();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (can && takeIssueFocus()) button.current?.focus();
  }, [can]);
  if (!can) return null;
  const run = async () => {
    const made = await issue();
    if (!made) return;
    const message = `${WB_DESIGN.phone.issued} ${made.id}`;
    if (host)
      toast.action(message, {
        label: 'Passes',
        onClick: () => void navigate({ to: wbPath(host.context.orgId, 'passes') }),
      });
    else toast.success(message);
  };
  return (
    <Button
      ref={button}
      variant="outline"
      iconStart={<Ticket aria-hidden />}
      loading={busy}
      onClick={() => void run()}
    >
      {WB_DESIGN.phone.issue}
    </Button>
  );
}
