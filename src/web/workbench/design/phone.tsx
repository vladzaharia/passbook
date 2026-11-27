import { Save } from 'lucide-react';
import type { ReactNode } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { useBottomBar } from '../../ui/bottom-bar.ts';
import { Button } from '../../ui/button.tsx';
import { Sheet, SheetContent, SheetTrigger } from '../../ui/sheet.tsx';
import { CodeTab } from './code-tab.tsx';
import { DataPanel } from './data-panel.tsx';
import { TryOnPhone } from './issue.tsx';
import { useOpenTemplate } from './template-context.tsx';

/** The template and what the core and the Workbench offer for it; Try on my phone moves to the bar at 390. */
export function DesignHead({ name, actions }: { name: string; actions: ReactNode }) {
  const phone = useMediaQuery(PHONE);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <p className="min-w-0 truncate text-base font-semibold text-fg-strong">{name}</p>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {actions}
        {phone ? null : <TryOnPhone />}
      </div>
    </div>
  );
}

/**
 * At 390 (design §5.1): the card starts the page, then Data and Code in a sheet. The section editor
 * is a notice: it needs more room.
 */
export function DesignPhone({ preview }: { preview: ReactNode; issues: ReactNode }) {
  useOpenTemplate();
  return (
    <div className="grid gap-4">
      {preview}
      <DataPanel structure={<p className="text-sm text-fg-muted">{WB_DESIGN.phoneEdit}</p>} />
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline">{WB_DESIGN.codeSheet}</Button>
        </SheetTrigger>
        <SheetContent side="bottom" title={WB_DESIGN.codeSheet}>
          <div className="overflow-auto p-4">
            <CodeTab />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The bar under the page at 390: Save version, and Try on my phone as an icon. */
export function DesignBar({
  dirty,
  saving,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const ref = useBottomBar<HTMLDivElement>();
  return (
    <>
      <div aria-hidden className="h-[calc(var(--wl-bottom-bar,4.5rem)+0.5rem)]" />
      <div
        ref={ref}
        data-save-bar=""
        className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-border bg-surface-overlay px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-elevation-3"
      >
        <Button
          className="flex-1"
          iconStart={<Save aria-hidden />}
          loading={saving}
          disabled={!dirty}
          onClick={onSave}
        >
          {WB_DESIGN.bar.save}
        </Button>
        <TryOnPhone icon />
      </div>
    </>
  );
}
