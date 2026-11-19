import type { z } from 'zod';
import type { BulkChannelsPreviewSchema, ChannelWindow } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Callout } from '../../ui/index.ts';
import { impactLines } from '../templates/channels/impact.ts';
import { windowWarnings } from '../templates/channels/replace-option.tsx';

type Preview = z.infer<typeof BulkChannelsPreviewSchema>;

const count = (n: number, one: string, many: string) =>
  n === 1 ? one : many.replace('{n}', String(n));

/** An open window does not refuse a bulk change: each pass's new code waits for it. */
function waitLine(w: ChannelWindow): string {
  return w.closesAt
    ? CHANNEL_COPY.bulkWaitUntil
        .replace('{name}', w.name)
        .replace('{time}', formatDateTime(w.closesAt))
    : CHANNEL_COPY.bulkWait.replace('{name}', w.name);
}

/** What applying would do, from the same plan and windows a real change uses. */
export function BulkPreview({ preview, replace }: { preview: Preview; replace: boolean }) {
  const lines = impactLines(
    preview.impact.map((i) => ({ ...i, clearedOverrides: 0 })),
    replace,
  );
  const open = preview.windows.filter((w) => w.open && w.scheduled);
  const soon = preview.windows.filter((w) => !(w.open && w.scheduled));
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs text-fg-muted">
      <ul className="flex flex-col gap-1">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {replace && preview.unsupported > 0 ? (
          <li>
            {count(
              preview.unsupported,
              CHANNEL_COPY.bulkUnsupportedOne,
              CHANNEL_COPY.bulkUnsupported,
            )}
          </li>
        ) : null}
        {replace && preview.allOff > 0 ? (
          <li>{count(preview.allOff, CHANNEL_COPY.bulkAllOffOne, CHANNEL_COPY.bulkAllOff)}</li>
        ) : null}
      </ul>
      {replace
        ? open.map((w) => (
            <Callout key={w.id} tone="warning">
              {waitLine(w)}
            </Callout>
          ))
        : null}
      {replace
        ? windowWarnings(soon).map((l) => (
            <Callout key={l} tone="warning">
              {l}
            </Callout>
          ))
        : null}
    </div>
  );
}
