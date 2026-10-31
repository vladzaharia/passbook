import { useNavigate } from '@tanstack/react-router';
import { Ban, ExternalLink, KeyRound, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { Button, ConfirmDialog, CopyButton, toast } from '../../../ui/index.ts';
import { usePassActions } from '../api.ts';
import { absoluteUrl } from '../format.ts';
import { TypedConfirmDialog } from '../typed-confirm.tsx';

type Pass = z.infer<typeof PassDetailSchema>;

export function PassHeaderActions({ pass }: { pass: Pass }) {
  const actions = usePassActions(pass.id);
  const navigate = useNavigate();
  const [rotate, setRotate] = useState(false);
  const [del, setDel] = useState(false);
  const voided = pass.status === 'voided';

  async function run(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast.success(done);
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        iconStart={<RefreshCw aria-hidden />}
        loading={actions.refreshFromSource.isPending}
        onClick={() => run(() => actions.refreshFromSource.mutateAsync(), 'Refresh requested')}
      >
        Refresh
      </Button>
      <Button
        variant="outline"
        iconStart={voided ? <RotateCcw aria-hidden /> : <Ban aria-hidden />}
        loading={actions.setVoided.isPending}
        onClick={() =>
          run(
            () => actions.setVoided.mutateAsync(!voided),
            voided ? 'Pass unvoided' : 'Pass voided',
          )
        }
      >
        {voided ? 'Unvoid' : 'Void'}
      </Button>
      <Button
        variant="outline"
        iconStart={<KeyRound aria-hidden />}
        onClick={() => setRotate(true)}
      >
        Rotate link
      </Button>
      <span className="inline-flex items-center gap-1 text-sm text-fg-muted">
        <CopyButton value={absoluteUrl(pass.publicUrl)} label="Copy public link" />
      </span>
      <Button asChild variant="outline" iconStart={<ExternalLink aria-hidden />}>
        <a href={pass.publicUrl} target="_blank" rel="noopener noreferrer">
          Open public page
        </a>
      </Button>
      <Button variant="danger" iconStart={<Trash2 aria-hidden />} onClick={() => setDel(true)}>
        Delete
      </Button>

      <ConfirmDialog
        open={rotate}
        onOpenChange={setRotate}
        title="Rotate public link?"
        description="The current link and download URL stop working."
        confirmLabel="Rotate"
        destructive
        onConfirm={async () => {
          await actions.rotateLink.mutateAsync();
          toast.success('Link rotated');
        }}
      />
      <TypedConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Delete pass?"
        description="Removes the pass, its versions and images. Installed copies stop updating."
        word={pass.serial}
        confirmLabel="Delete pass"
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success('Pass deleted');
          void navigate({ to: '/admin/passes' });
        }}
      />
    </>
  );
}
