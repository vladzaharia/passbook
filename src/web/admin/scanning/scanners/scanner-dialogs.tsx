import { IdCard } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ScannerDto } from '@/shared/contracts/scanners.ts';
import { goLiveConfirm, pairAgainConfirm, revokeScannerConfirm } from '@/web/lib/confirms.ts';
import { setMode } from '@/web/lib/mode.ts';
import { ConfirmDialog, Dialog, DialogContent, SecretReveal, toast } from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { type Pairing, PairingFace } from '../pairing-face.tsx';
import {
  useNewPairing,
  useReplaceToken,
  useRevokeScanner,
  useScannerMode,
} from '../scanner-api.ts';

interface Props {
  scanner: ScannerDto | undefined;
  onClose: () => void;
}

/** Pair or Pair again: a paired scanner asks first, then the code and its face. */
export function PairDialog({ scanner, onClose }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  // ConfirmDialog closes itself after a confirm; that is not a cancel.
  const said = useRef(false);
  const [pairing, setPairing] = useState<Pairing>();
  const make = useNewPairing(scanner?.id ?? '');
  const ask = scanner?.status === 'paired' && !confirmed;
  useEffect(() => {
    if (!scanner || ask || pairing || make.isPending || make.isError) return;
    make.mutateAsync().then(setPairing, (cause: unknown) => {
      toast.error(cause, 'Could not make a code');
      onClose();
    });
  }, [scanner, ask, pairing, make, onClose]);
  const close = () => {
    said.current = false;
    setConfirmed(false);
    setPairing(undefined);
    make.reset();
    onClose();
  };
  if (!scanner) return null;
  if (ask) {
    return (
      <ConfirmDialog
        open
        onOpenChange={(o) => !o && !said.current && close()}
        {...pairAgainConfirm(scanner.name)}
        onConfirm={() => {
          said.current = true;
          setConfirmed(true);
        }}
      />
    );
  }
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        size="lg"
        closeButton={false}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            Pair {scanner.name}
            <ModePill mode={scanner.mode} />
          </span>
        }
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {pairing ? (
          <PairingFace scanner={scanner} pairing={pairing} onClose={close} />
        ) : (
          <p role="status" className="text-sm text-fg-muted">
            Making a code…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RevokeDialog({ scanner, onClose }: Props) {
  const revoke = useRevokeScanner(scanner?.id ?? '');
  return (
    <ConfirmDialog
      open={scanner !== undefined}
      onOpenChange={(o) => !o && onClose()}
      {...revokeScannerConfirm(scanner?.name ?? 'scanner')}
      destructive
      onConfirm={async () => {
        await revoke.mutateAsync();
        toast.success('Scanner revoked');
      }}
    />
  );
}

/** Test to live (the reverse is Move to Test mode). The device keeps its pairing. */
export function GoLiveDialog({ scanner, onClose }: Props) {
  const live = useScannerMode(scanner?.id ?? '', 'live');
  return (
    <ConfirmDialog
      open={scanner !== undefined}
      onOpenChange={(o) => !o && onClose()}
      {...goLiveConfirm(scanner?.name ?? 'scanner')}
      onConfirm={async () => {
        await live.mutateAsync();
        toast.action(`${scanner?.name ?? 'Scanner'} is live`, {
          label: 'Leave Test mode',
          onClick: () => setMode('live'),
        });
      }}
    />
  );
}

/** A till's token, shown once. Asking again replaces the old one. */
export function TokenDialog({ scanner, onClose }: Props) {
  const issue = useReplaceToken(scanner?.id ?? '');
  const [token, setToken] = useState<string>();
  useEffect(() => {
    if (!scanner || token || issue.isPending || issue.isError) return;
    issue.mutateAsync().then(
      (t) => setToken(t.token),
      (cause: unknown) => {
        toast.error(cause, 'Could not make a token');
        onClose();
      },
    );
  }, [scanner, token, issue, onClose]);
  const close = () => {
    setToken(undefined);
    issue.reset();
    onClose();
  };
  if (!scanner) return null;
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        size="md"
        closeButton={false}
        title={
          <span className="inline-flex items-center gap-2">
            <span data-verb-done="" className="inline-flex text-accent-fg [&>svg]:size-4">
              <IdCard aria-hidden />
            </span>
            {scanner.name} token
          </span>
        }
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {token ? (
          <SecretReveal
            fields={[{ label: 'Token', value: token, copyLabel: 'Copy token' }]}
            savedLabel="I saved the token"
            onDone={close}
          />
        ) : (
          <p role="status" className="text-sm text-fg-muted">
            Making a token…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
