import { Eye } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { BELOW_XL, PHONE, useMediaQuery } from '../../lib/media.ts';
import { Button, Card, Dialog, DialogContent } from '../../ui/index.ts';

export interface PreviewLayoutProps {
  /** The full stage panel (PassPreviewPanel): the 20rem column, the summary card, the sheet. */
  stage: (size: 'column' | 'card' | 'sheet') => ReactNode;
  /** A small still of the pass for the phone row. */
  still: ReactNode;
  title: string;
  /** Status, holder, version and quick actions beside the card at 640 to 1279. */
  summary: ReactNode;
  children: ReactNode;
}

/**
 * At 1280 and up the stage sits in a 20rem column beside the tabs; from 640 a horizontal summary
 * card (pass at 220 px) sits above them; below 640 a compact row opens the stage in a sheet, so
 * the tabs start in the first screen.
 */
export function PreviewLayout({ stage, still, title, summary, children }: PreviewLayoutProps) {
  const narrow = useMediaQuery(BELOW_XL);
  const phone = useMediaQuery(PHONE);
  const [open, setOpen] = useState(false);
  if (!narrow) {
    return (
      <div className="grid min-w-0 grid-cols-[20rem_minmax(0,1fr)] items-start gap-8">
        <aside
          aria-label="Pass preview"
          className="sticky top-[calc(5rem+env(safe-area-inset-top))]"
        >
          {stage('column')}
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    );
  }
  if (phone) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
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
      <Card className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-6 p-5">
        <div className="w-[220px]">{stage('card')}</div>
        <div className="flex min-w-0 flex-col gap-4">{summary}</div>
      </Card>
      {children}
    </div>
  );
}
