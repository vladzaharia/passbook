import { Download } from 'lucide-react';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Button, toast } from '../../../ui/index.ts';
import { downloadSampleCsv } from './api-run.ts';

/** The template's own sample: its field labels and one valid row, so it imports with no errors. */
export function SampleCsv({ templateId, orgId }: { templateId: string; orgId: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconStart={<Download aria-hidden />}
      onClick={() =>
        downloadSampleCsv(templateId, orgId).catch((e: unknown) =>
          toast.error(e, C.results.couldNotDownload),
        )
      }
    >
      {C.sample}
    </Button>
  );
}
