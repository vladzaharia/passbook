import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button, toast } from '@/web/ui/index.ts';
import { EXPORT_MAX, exportAudit } from './export.ts';

/** Saves the entries the page's filters match as CSV, up to 1,000. */
export function ExportButton({
  path,
  query,
  orgName,
}: {
  path: string;
  query: Record<string, string | number | undefined>;
  orgName: (id: string | null) => string | undefined;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      loading={busy}
      iconStart={<Download aria-hidden />}
      title={`Saves the entries these filters match, up to ${EXPORT_MAX.toLocaleString('en')}, as CSV.`}
      onClick={() => {
        setBusy(true);
        exportAudit(path, query, orgName)
          .then((n) => toast.success(`Exported ${n} ${n === 1 ? 'entry' : 'entries'}.`))
          .catch((cause: unknown) => toast.error(cause, 'Could not export'))
          .finally(() => setBusy(false));
      }}
    >
      Export
    </Button>
  );
}
