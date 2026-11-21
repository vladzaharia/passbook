import { Eye } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import type { EffectiveChannels } from '@/shared/contracts/channels.ts';
import { PREVIEW_COPY } from '@/shared/copy/previews.ts';
import { PaperPreview } from '../admin/templates/designer/paper-preview.tsx';
import { Button, Dialog, DialogContent, Skeleton } from '../ui/index.ts';
import { ChannelPreviews } from './channel-previews.tsx';
import type { PreviewSource } from './types.ts';

/** The Paper pane for a saved template or a pass: read only, from the template's `paper` block. */
export function PaperChannel({
  source,
  templateId,
  orgId,
}: {
  source: PreviewSource | null;
  templateId?: string | undefined;
  orgId?: string | undefined;
}) {
  // A pass prints its own values: the sample the paper content reads is the pass's input.
  const manifest = useMemo(
    () => (source ? { ...source.manifest, sample: source.input } : null),
    [source],
  );
  if (!source || !manifest)
    return <Skeleton className="mx-auto aspect-[210/297] w-full max-w-sm rounded-xl" />;
  return (
    <PaperPreview
      passJson={source.passJson}
      manifest={manifest}
      templateId={templateId}
      orgId={orgId}
      testBand={source.testBand}
    />
  );
}

/**
 * The stage of a page that has a pass preview column (template, blueprint, pass). The column and
 * the phone sheet get the whole switcher; the 180 px summary card keeps its card and opens the
 * switcher in a dialog.
 */
export function ChannelStage({
  size,
  source,
  apple,
  title,
  templateId,
  orgId,
  channels,
}: {
  size: 'column' | 'card' | 'sheet';
  source: PreviewSource | null;
  apple: ReactNode;
  title: string;
  templateId?: string | undefined;
  orgId?: string | undefined;
  channels?: EffectiveChannels | undefined;
}) {
  const [open, setOpen] = useState(false);
  const all = (
    <ChannelPreviews
      source={source}
      apple={apple}
      channels={channels}
      paper={<PaperChannel source={source} templateId={templateId} orgId={orgId} />}
    />
  );
  if (size !== 'card') return all;
  return (
    <div className="flex flex-col items-center gap-3">
      {apple}
      <Button
        variant="outline"
        size="sm"
        iconStart={<Eye aria-hidden />}
        onClick={() => setOpen(true)}
      >
        {PREVIEW_COPY.allPreviews}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={title} size="md">
          {open ? all : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
