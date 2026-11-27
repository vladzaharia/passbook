import { Save } from 'lucide-react';
import type { ReactNode } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import type { DesignerExtras } from '../../../admin/templates/designer/host.tsx';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import { useBottomBar } from '../../../ui/bottom-bar.ts';
import { Button } from '../../../ui/button.tsx';
import { Select } from '../../../ui/select.tsx';
import { Sheet, SheetContent, SheetTrigger } from '../../../ui/sheet.tsx';
import { BenchSlot } from '../../bench/slots.tsx';
import { CodeTab } from '../code-tab.tsx';
import { WalletPeek } from '../peek.tsx';
import { useAnon } from './anon-context.tsx';
import { AnonData, ShareButton } from './anon-data.tsx';

function SaveButton({ className }: { className?: string }) {
  const { save } = useAnon();
  return (
    <Button className={className} iconStart={<Save aria-hidden />} onClick={save}>
      {WB_DESIGN.anon.save}
    </Button>
  );
}

export function AnonCode() {
  const { values } = useAnon();
  return <CodeTab sample={values} />;
}

/** The head: the blueprint picker where a template's name would be, then Share and Save. */
function AnonHead({ actions, modes }: { name: string; actions: ReactNode; modes?: ReactNode }) {
  const { blueprint, options, pick } = useAnon();
  const phone = useMediaQuery(PHONE);
  return (
    <div className="mb-2 flex items-center gap-2 sm:mb-3 sm:flex-wrap">
      {phone ? (
        <BenchSlot name="action">
          <ShareButton iconOnly />
        </BenchSlot>
      ) : null}
      <Select
        className="min-w-0 flex-1 sm:w-64 sm:flex-none"
        aria-label={WB_DESIGN.anon.pick}
        tall
        value={blueprint.preview.id}
        options={options}
        onValueChange={pick}
      />
      {modes}
      <div className="flex shrink-0 items-center gap-2 empty:hidden sm:ml-auto sm:flex-wrap">
        {actions}
        {phone ? null : (
          <>
            <ShareButton />
            <SaveButton />
          </>
        )}
      </div>
    </div>
  );
}

function AnonPhone({ preview }: { preview: ReactNode; issues: ReactNode }) {
  return (
    <div className="grid gap-4">
      {preview}
      <AnonData />
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline">{WB_DESIGN.codeSheet}</Button>
        </SheetTrigger>
        <SheetContent side="bottom" title={WB_DESIGN.codeSheet}>
          <div className="overflow-auto p-4">
            <AnonCode />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AnonBar() {
  const ref = useBottomBar<HTMLDivElement>();
  return (
    <>
      <div aria-hidden className="h-[calc(var(--wl-bottom-bar,4.5rem)+0.5rem)]" />
      <div
        ref={ref}
        data-save-bar=""
        className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-border bg-surface-overlay px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-elevation-3"
      >
        <SaveButton className="flex-1" />
      </div>
    </>
  );
}

/** What the signed-out page adds around the read-only core. Built once: hosts re-render on a new object. */
export const ANON_EXTRAS: DesignerExtras = {
  Panel: AnonData,
  Code: AnonCode,
  Head: AnonHead,
  Phone: AnonPhone,
  PhoneBar: AnonBar,
  Peek: WalletPeek,
};
