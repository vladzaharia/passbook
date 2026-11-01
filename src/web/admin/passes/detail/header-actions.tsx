import { useNavigate } from '@tanstack/react-router';
import {
  Ban,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { PassDetailSchema } from '@/shared/contracts/passes.ts';
import {
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  MoreMenu,
  toast,
} from '../../../ui/index.ts';
import { confirmWord, TypedConfirmDialog } from '../../../ui/typed-confirm-dialog.tsx';
import { usePassActions } from '../api.ts';
import { absoluteUrl } from '../format.ts';

type Pass = z.infer<typeof PassDetailSchema>;

export function PassHeaderActions({ pass }: { pass: Pass }) {
  const actions = usePassActions(pass.id);
  const navigate = useNavigate();
  const [rotate, setRotate] = useState(false);
  const [del, setDel] = useState(false);
  const [voidAsk, setVoidAsk] = useState(false);
  const voided = pass.status === 'voided';

  async function run(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast.success(done);
    } catch (error) {
      toast.error(error);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(absoluteUrl(pass.publicUrl));
      toast.success('Link copied');
    } catch {
      toast.error(new Error('Could not copy. Copy the link from the public page.'));
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
        <span className="max-sm:sr-only">Refresh</span>
      </Button>
      <Button
        variant="outline"
        iconStart={voided ? <RotateCcw aria-hidden /> : <Ban aria-hidden />}
        loading={actions.setVoided.isPending}
        onClick={() =>
          voided
            ? run(() => actions.setVoided.mutateAsync(false), 'Pass unvoided')
            : setVoidAsk(true)
        }
      >
        {voided ? 'Unvoid' : 'Void'}
      </Button>
      <Button asChild variant="outline" iconStart={<ExternalLink aria-hidden />}>
        <a
          href={pass.publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open public page"
        >
          <span>
            Open<span className="max-sm:sr-only"> public page</span>
          </span>
        </a>
      </Button>
      <MoreMenu>
        <DropdownMenuItem onSelect={() => void copyLink()}>
          <Copy aria-hidden />
          Copy public link
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={pass.downloadUrl} download>
            <Download aria-hidden />
            Download .pkpass
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setRotate(true)}>
          <KeyRound aria-hidden />
          Rotate link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => setDel(true)}>
          <Trash2 aria-hidden />
          Delete
        </DropdownMenuItem>
      </MoreMenu>

      <ConfirmDialog
        open={voidAsk}
        onOpenChange={setVoidAsk}
        title="Void pass?"
        description="Wallet marks it void on the holder's device."
        confirmLabel="Void"
        destructive
        onConfirm={async () => {
          await actions.setVoided.mutateAsync(true);
          toast.success('Pass voided');
        }}
      />
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
        word={confirmWord({ title: pass.title, slug: pass.serial })}
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
