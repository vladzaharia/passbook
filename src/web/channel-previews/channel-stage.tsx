import { Link } from '@tanstack/react-router';
import { Eye } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import type { EffectiveChannels } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import { PREVIEW_COPY } from '@/shared/copy/previews.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { PaperPreview } from '../admin/templates/designer/paper-preview.tsx';
import { Button, Dialog, DialogContent, Skeleton } from '../ui/index.ts';
import { ChannelPreviews } from './channel-previews.tsx';
import type { OffLevel } from './locked-preview.tsx';
import type { PreviewSource } from './types.ts';

/** The tallest the page draws in a stage: the whole page shows, scaled to fit. */
const PAPER_FIT_H = 520;

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
      timeZone={source.timeZone}
      testBand={source.testBand}
      fitHeight={PAPER_FIT_H}
    />
  );
}

/**
 * The way back on from an off pane: the channels tab of the level this page edits, or, on a pass
 * page, the template's when the template turns it off. On a pass page `own` is `pass`.
 */
export function lockedAction({
  orgId,
  channelsTab,
  own = 'template',
  templateId,
  onNavigate,
}: {
  orgId?: string | undefined;
  channelsTab?: string | undefined;
  own?: OffLevel | undefined;
  templateId?: string | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  return ({ level }: { level: OffLevel }): ReactNode => {
    if (level === own && channelsTab)
      return (
        <Button variant="outline" size="sm" asChild>
          <Link to="." search={(prev) => ({ ...prev, tab: channelsTab })} onClick={onNavigate}>
            {own === 'template' ? TEMPLATE_BRAND_COPY.tab : CHANNEL_COPY.card}
          </Link>
        </Button>
      );
    if (level === 'template' && own === 'pass' && orgId && templateId)
      return (
        <Button variant="outline" size="sm" asChild>
          <Link
            to="/admin/o/$orgId/templates/$templateId"
            params={{ orgId, templateId }}
            search={{ tab: 'channels' }}
            onClick={onNavigate}
          >
            {TEMPLATE_BRAND_COPY.tab}
          </Link>
        </Button>
      );
    return null;
  };
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
  channelsTab,
  own,
  lockTab,
}: {
  size: 'column' | 'card' | 'sheet';
  source: PreviewSource | null;
  apple: ReactNode;
  title: string;
  templateId?: string | undefined;
  orgId?: string | undefined;
  channels?: EffectiveChannels | undefined;
  /** The page's tab that changes channels: the empty state links to it. */
  channelsTab?: string | undefined;
  /** The level this page edits: `pass` on a pass page. */
  own?: 'template' | 'pass' | undefined;
  /** The tab that edits that level, when it is not `channelsTab`. */
  lockTab?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const all = (
    <ChannelPreviews
      source={source}
      apple={apple}
      channels={channels}
      lockedAction={lockedAction({
        orgId,
        channelsTab: lockTab ?? channelsTab,
        own,
        templateId,
        onNavigate: () => setOpen(false),
      })}
      emptyAction={
        channelsTab ? (
          <Button variant="outline" size="sm" asChild>
            <Link
              to="."
              search={(prev) => ({ ...prev, tab: channelsTab })}
              onClick={() => setOpen(false)}
            >
              {CHANNEL_COPY.card}
            </Link>
          </Button>
        ) : undefined
      }
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
