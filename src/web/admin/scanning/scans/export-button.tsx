import { Download } from 'lucide-react';
import { useState } from 'react';
import { useOrgTimeZone } from '@/web/admin/settings/use-org-time-zone.ts';
import { problemToError } from '@/web/lib/errors.ts';
import { modeHeaders } from '@/web/lib/mode.ts';
import { Button, toast } from '@/web/ui/index.ts';
import type { ScanningSearch } from '../search.ts';

/** The export route's query: the list's current filters, the window up to now, and the org's zone. */
export function exportQuery(
  orgId: string,
  from: number,
  to: number,
  search: ScanningSearch,
  timeZone: string,
): URLSearchParams {
  const query = new URLSearchParams({ orgId, from: String(from), to: String(to), timeZone });
  for (const key of [
    'q',
    'scannerId',
    'staffId',
    'eventId',
    'templateId',
    'outcome',
    'reason',
  ] as const) {
    const value = search[key];
    if (value) query.set(key, value);
  }
  return query;
}

async function download(query: URLSearchParams): Promise<void> {
  const res = await fetch(`/api/v1/scans/export?${query}`, {
    headers: { accept: 'text/csv', ...modeHeaders() },
    credentials: 'same-origin',
  });
  if (!res.ok) throw problemToError(res.status, await res.json().catch(() => undefined));
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'scans.csv';
  link.click();
  URL.revokeObjectURL(url);
}

export function ExportButton({
  orgId,
  from,
  search,
}: {
  orgId: string;
  from: number;
  search: ScanningSearch;
}) {
  const [busy, setBusy] = useState(false);
  const timeZone = useOrgTimeZone(orgId);
  return (
    <Button
      variant="secondary"
      iconStart={<Download aria-hidden />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await download(exportQuery(orgId, from, Date.now(), search, timeZone));
        } catch (error) {
          toast.error(error, 'Could not export');
        } finally {
          setBusy(false);
        }
      }}
    >
      Export CSV
    </Button>
  );
}
