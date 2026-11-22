import { Eye } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { BELOW_LG, PHONE, useMediaQuery } from '../../lib/media.ts';
import { Button, Card, Dialog, DialogContent } from '../../ui/index.ts';

export interface PreviewLayoutProps {
  /** The full stage panel (PassPreviewPanel): the 20rem column, the summary card, the sheet. */
  stage: (size: 'column' | 'card' | 'sheet') => ReactNode;
  /** A small still of the pass for the phone row. */
  still: ReactNode;
  title: string;
  /** Holder and quick actions beside the card at 640 to 1023 (the header has the rest). */
  summary?: ReactNode;
  /** A phone shows the stage in place of the row: a mint, wave or tear plays where it is seen. */
  inline?: boolean;
  /**
   * What leads the page: from 1024 it sits above the tabs, so the stage starts at the top of the
   * first screen; narrower it sits above the stage.
   */
  lead?: ReactNode;
  children: ReactNode;
}

/**
 * From 1024 the stage sits in a column beside the tabs (16rem, 20rem from 1280); from 640 a
 * horizontal summary card (pass at 180 px) sits above them; below 640 a compact row opens the
 * stage in a sheet. The tabs start in the first screen at every width.
 */
export function PreviewLayout({
  stage,
  still,
  title,
  summary,
  inline = false,
  lead,
  children,
}: PreviewLayoutProps) {
  const narrow = useMediaQuery(BELOW_LG);
  const phone = useMediaQuery(PHONE);
  const [open, setOpen] = useState(false);
  if (!narrow) {
    return (
      <div className="grid min-w-0 grid-cols-[16rem_minmax(0,1fr)] items-start gap-6 xl:grid-cols-[20rem_minmax(0,1fr)] xl:gap-8">
        <aside
          aria-label="Pass preview"
          className="sticky top-[calc(5rem+env(safe-area-inset-top))]"
        >
          {stage('column')}
        </aside>
        <div className="min-w-0">
          {lead ? <div className="mb-6 flex flex-col gap-6">{lead}</div> : null}
          {children}
        </div>
      </div>
    );
  }
  if (phone && inline) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Card className="p-5">
          <div className="mx-auto w-full max-w-xs">{stage('card')}</div>
        </Card>
        {lead}
        {children}
      </div>
    );
  }
  if (phone) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        {lead}
        <Card className="flex items-center gap-4 p-3">
          <div aria-hidden className="w-16 shrink-0" inert>
            {still}
          </div>
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg-strong">{title}</p>
          <Button
            variant="outline"
            size="sm"
            iconStart={<Eye aria-hidden />}
            onClick={() => setOpen(true)}
          >
            Show pass
          </Button>
        </Card>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title={title} size="sm">
            <div className="py-2">{stage('sheet')}</div>
          </DialogContent>
        </Dialog>
        {children}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {lead}
      <Card
        className={summary ? 'grid grid-cols-[180px_minmax(0,1fr)] items-start gap-6 p-5' : 'p-5'}
      >
        <div className="mx-auto w-[180px]">{stage('card')}</div>
        {summary ? <div className="flex min-w-0 flex-col gap-4">{summary}</div> : null}
      </Card>
      {children}
    </div>
  );
}
