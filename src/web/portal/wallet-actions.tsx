import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  ExternalLink,
  Mail,
  MoreHorizontal,
  QrCode as QrIcon,
  RefreshCw,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { addLine, showsAddQr } from '@/shared/device.ts';
import { copyText } from '../lib/clipboard.ts';
import { cn } from '../lib/cn.ts';
import { lostPhoneConfirm } from '../lib/confirms.ts';
import { isApiError } from '../lib/errors.ts';
import { sessionQuery } from '../lib/session.ts';
import {
  Buddy,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  toast,
} from '../ui/index.ts';
import { Scan } from './add/scan.tsx';
import {
  lostPhone,
  myPassesKey,
  removePass,
  resendPass,
  sendLostPhoneConfirmation,
} from './api.ts';
import { browserDevice } from './device.ts';
import { useHolderOperations } from './holder-operations.tsx';
import type { Refresh } from './refresh-button.tsx';

/** `/p/:token/pass.pkpass` -> `/p/:token`. The list contract has no public URL field. */
export function publicUrlOf(
  downloadUrl: string | null,
  origin = window.location.origin,
): string | null {
  const m = downloadUrl
    ? /^(.*\/p\/[^/?#]+?)(?:\/pass\.pkpass)?(?:[?#].*)?$/.exec(downloadUrl)
    : null;
  if (!m?.[1]) return null;
  return new URL(m[1], origin).toString();
}

/** Apple's rule for pages with the badge: say how to add where this browser cannot. */
export function AddLine({ className }: { className?: string }) {
  const line = addLine(browserDevice());
  return line ? <p className={cn('text-sm text-fg-muted', className)}>{line}</p> : null;
}

/**
 * The pass page's scan in a dialog: the buddy on the QR's tile, the scan line beside it, stacked
 * in the bottom sheet. The page's buddy steps aside while it is open (art-wallet.css).
 */
export function QrDialog({
  passTitle,
  url,
  open,
  setOpen,
}: {
  passTitle: string;
  url: string;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={HOLDER_COPY.addTitle} description={passTitle}>
        <Scan url={url} label={HOLDER_COPY.qrAlt(passTitle)} buddy={(p) => <Buddy {...p} />} />
      </DialogContent>
    </Dialog>
  );
}

/** "Show QR" beside the badge on a tile, where this is not the phone (shared/device.ts). */
export function ShowQrButton({ passTitle, url }: { passTitle: string; url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="badge"
        iconStart={<QrIcon aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Show QR
      </Button>
      <QrDialog passTitle={passTitle} url={url} open={open} setOpen={setOpen} />
    </>
  );
}

/** A second tap while the first runs shows that one; anything else is an error. */
function useShowRunning() {
  const { follow } = useHolderOperations();
  return (error: unknown, title: string) => {
    if (isApiError(error) && error.code === 'OPERATION_RUNNING' && error.operationId)
      follow(error.operationId);
    else toast.error(error, title);
  };
}

function useRemovePass(passId: string, onRemoved?: () => void) {
  const client = useQueryClient();
  const { follow } = useHolderOperations();
  const showRunning = useShowRunning();
  const currentUser = () => {
    const state = client.getQueryState(sessionQuery.queryKey);
    return state?.status === 'success' && state.data?.authenticated
      ? state.data.user.id
      : undefined;
  };
  const mutation = useMutation({
    mutationFn: () => removePass(passId),
    onMutate: () => currentUser(),
    onSuccess: async (result, _variables, userId) => {
      if (!userId || currentUser() !== userId) return;
      await client.invalidateQueries({ queryKey: myPassesKey, exact: true });
      if (currentUser() !== userId) return;
      if (result.state === 'pending') {
        // Its steps and the wait for the wallets are the operation's: the sheet shows them.
        if (result.operationId) follow(result.operationId);
        else toast.info(HOLDER_COPY.removalStarted);
      } else {
        toast.success('Removed from your passes');
      }
      onRemoved?.();
    },
    onError: (error) => showRunning(error, 'Could not remove'),
  });
  return mutation;
}

/** Send it again, and I lost my phone: both act on the signed-in holder's own pass. */
function useHolderHelp(passId: string) {
  const client = useQueryClient();
  const { follow } = useHolderOperations();
  const showRunning = useShowRunning();
  const resend = useMutation({
    mutationFn: () => resendPass(passId),
    onSuccess: (res) => {
      if (res.operationId) follow(res.operationId);
      else toast.success(HOLDER_COPY.sendAgainSent);
    },
    onError: (error) => showRunning(error, 'Could not send'),
  });
  const lost = useMutation({
    mutationFn: async () => {
      try {
        return await lostPhone(passId);
      } catch (error) {
        // Not a fresh email session: the owner confirms by a link, and the action runs from that session.
        if (!(isApiError(error) && error.code === 'EMAIL_CONFIRMATION_REQUIRED')) throw error;
        await sendLostPhoneConfirmation(passId);
        return null;
      }
    },
    onSuccess: async (res) => {
      if (!res) {
        toast.info(HOLDER_COPY.lostPhoneConfirm);
        return;
      }
      await client.invalidateQueries({ queryKey: myPassesKey });
      if (res.operationId) follow(res.operationId);
      else toast.success(HOLDER_COPY.lostPhoneDone);
    },
  });
  return { resend, lost };
}

export interface PassMenuProps {
  passId: string;
  passTitle: string;
  /** The public page: Show QR on a tile; on the detail page Copy link and Open public page. */
  publicUrl: string | null;
  /** Detail page: a labelled "More" with the link items (its QR is on the page). Tiles: an icon. */
  page?: boolean;
  /** An Apple device registered the pass; current installation is unknown. */
  inWallet?: boolean;
  onRemoved?: () => void;
  /** The pass is live: Send it again and I lost my phone. */
  help?: boolean;
  /** Tiles: Refresh is also here, the only one when the tile is too narrow for its icon. */
  refresh?: Refresh;
  /** Tiles: false where Show QR is already the tile's lead. */
  showQr?: boolean;
}

/**
 * More: on a tile an icon beside the badge (Show QR, Remove); in the pass page's header the kit's
 * More (Copy link, Open public page, Remove), its word gone on phones.
 */
export function PassMoreMenu({
  passId,
  passTitle,
  publicUrl,
  page = false,
  inWallet = false,
  onRemoved,
  help = false,
  refresh,
  showQr = true,
}: PassMenuProps) {
  const [qrOpen, setQrOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  // The confirmation link lands here with the pass named: open the question again, now from a fresh session.
  useEffect(() => {
    if (!help) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('lostPhone') !== passId) return;
    url.searchParams.delete('lostPhone');
    window.history.replaceState(window.history.state, '', url);
    setLostOpen(true);
  }, [help, passId]);
  const mutation = useRemovePass(passId, onRemoved);
  const { resend, lost } = useHolderHelp(passId);
  const qr = showQr && !page && publicUrl && showsAddQr(browserDevice().device);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {page ? (
            <Button variant="outline" iconStart={<MoreHorizontal aria-hidden />}>
              <span className="max-sm:sr-only">More</span>
            </Button>
          ) : (
            <IconButton
              label="More actions"
              variant="outline"
              size="badge"
              icon={<MoreHorizontal aria-hidden />}
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {refresh ? (
            <DropdownMenuItem
              disabled={refresh.pending || refresh.phase === 'cooldown'}
              onSelect={refresh.request}
            >
              <RefreshCw aria-hidden /> {refresh.label}
            </DropdownMenuItem>
          ) : null}
          {qr ? (
            <DropdownMenuItem onSelect={() => setQrOpen(true)}>
              <QrIcon aria-hidden /> Show QR
            </DropdownMenuItem>
          ) : null}
          {page && publicUrl ? (
            <>
              <DropdownMenuItem onSelect={() => void copyText(publicUrl, 'link')}>
                <Copy aria-hidden /> Copy link
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden /> Open public page
                </a>
              </DropdownMenuItem>
            </>
          ) : null}
          {help ? (
            <>
              <DropdownMenuItem onSelect={() => resend.mutate()}>
                <Mail aria-hidden /> {HOLDER_COPY.sendAgain}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLostOpen(true)}>
                <Smartphone aria-hidden /> {HOLDER_COPY.lostPhone}
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem destructive onSelect={() => setRemoveOpen(true)}>
            <Trash2 aria-hidden /> Remove from My passes
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {qr ? (
        <QrDialog passTitle={passTitle} url={publicUrl} open={qrOpen} setOpen={setQrOpen} />
      ) : null}
      <ConfirmDialog
        open={lostOpen}
        onOpenChange={setLostOpen}
        {...lostPhoneConfirm(passTitle)}
        onConfirm={async () => {
          await lost.mutateAsync();
        }}
      />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove from my passes?"
        description={`${passTitle} will not come back unless an admin reassigns it.${
          inWallet ? ' An Apple Wallet copy may remain; delete it there if needed.' : ''
        }`}
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          await mutation.mutateAsync();
        }}
      />
    </>
  );
}
