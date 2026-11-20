import { Download } from 'lucide-react';
import { useState } from 'react';
import { buildUrl, type QueryValue } from '@/web/lib/api.ts';
import { modeHeaders } from '@/web/lib/mode.ts';
import { saveFromApi } from '@/web/lib/save-file.ts';
import { Button, toast } from '@/web/ui/index.ts';

/** Saves every entry the page's filters match as CSV; the server streams it. */
export function ExportButton({ path, query }: { path: string; query: Record<string, QueryValue> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      loading={busy}
      iconStart={<Download aria-hidden />}
      title="Saves every entry these filters match as CSV."
      onClick={() => {
        setBusy(true);
        saveFromApi(
          buildUrl(path, query),
          'audit-log.csv',
          modeHeaders(),
          'Could not export the audit log.',
        )
          .catch((cause: unknown) => toast.error(cause, 'Could not export'))
          .finally(() => setBusy(false));
      }}
    >
      Export
    </Button>
  );
}
