import { Eye } from 'lucide-react';
import { useState } from 'react';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { ChannelPreviews } from '@/web/channel-previews/channel-previews.tsx';
import type { PreviewSource } from '@/web/channel-previews/types.ts';
import { Button, Dialog, DialogContent } from '@/web/ui/index.ts';

/** The page a holder opens on their phone, for the sample pass in the org's draft brand. */
export function HolderPreview({ source, title }: { source: PreviewSource; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" iconStart={<Eye aria-hidden />} onClick={() => setOpen(true)}>
        {PASS_SETUP_COPY.page.previewHolder}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={title} size="md">
          {open ? (
            <ChannelPreviews value="mobile" source={source} apple={null} paper={null} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
