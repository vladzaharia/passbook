import { useState } from 'react';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Label,
  Select,
  TypedConfirmDialog,
  toast,
} from '@/web/ui/index.ts';
import type { Keyset } from './api.ts';
import { fill, tagCount } from './words.ts';

/** Cut off one version. Tags on it stop working until written with a newer version's keys. */
export function RevokeDialog({
  keyset,
  version,
  revoke,
  onClose,
}: {
  keyset: Keyset;
  version: number;
  revoke: () => Promise<unknown>;
  onClose: () => void;
}) {
  const C = KEYSET_COPY.revoke;
  const tags = keyset.versions.find((v) => v.version === version)?.tags ?? 0;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={fill(C.title, { v: version })}
      description={fill(C.body, { tags: tags ? fill(C.tags, { n: tags }) : C.none })}
      confirmLabel={C.confirm}
      destructive
      onConfirm={async () => {
        await revoke();
        toast.success(`Version ${version} revoked`);
      }}
    />
  );
}

/** Disable for good: typed, since every tag on the keyset goes with it. */
export function DisableDialog({
  keyset,
  disable,
  onClose,
}: {
  keyset: Keyset;
  disable: () => Promise<unknown>;
  onClose: () => void;
}) {
  return (
    <TypedConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={fill(KEYSET_COPY.disable.title, { name: keyset.name })}
      description={KEYSET_COPY.disable.body}
      word={keyset.name.length <= 24 ? keyset.name : 'disable'}
      confirmLabel={KEYSET_COPY.disable.confirm}
      onConfirm={disable}
    />
  );
}

/** After a leak: move the tags of this keyset to another live one. Passes and holders stay. */
export function ReenrolDialog({
  keyset,
  targets,
  reenrol,
  onClose,
}: {
  keyset: Keyset;
  targets: readonly Keyset[];
  reenrol: (toKeysetId: string) => Promise<{ moved: number; ownKey: number }>;
  onClose: () => void;
}) {
  const C = KEYSET_COPY.reenrol;
  const [to, setTo] = useState(targets[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function move() {
    if (!to) return;
    setBusy(true);
    setError('');
    try {
      const out = await reenrol(to);
      toast.success(
        `${fill(C.done, { n: out.moved })}${out.ownKey ? `. ${fill(C.own, { n: out.ownKey })}` : ''}`,
      );
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        title={`${C.title}: ${keyset.name}`}
        description={C.body}
        closeButton={!busy}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!to || tagCount(keyset) === 0}
              onClick={() => void move()}
            >
              {C.confirm}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {targets.length === 0 ? (
            <p className="text-sm text-fg-muted">{C.none}</p>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="reenrol-to">{C.pick}</Label>
              <Select
                id="reenrol-to"
                value={to}
                onValueChange={setTo}
                options={targets.map((t) => ({ value: t.id, label: t.name }))}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
