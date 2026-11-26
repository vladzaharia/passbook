import type { z } from 'zod';
import type { ConnectionFileSchema } from '@/shared/contracts/connection-files.ts';
import { cn } from '../../../lib/cn.ts';
import { formatCount } from '../../../lib/format.ts';

type Preview = z.infer<typeof ConnectionFileSchema>;

/** The file's first rows as the parser read them: a sticky header, the ID column marked, x-scroll. */
export function FilePreviewTable({
  file,
  idColumn,
}: {
  file: Pick<Preview, 'preview' | 'columns' | 'rows'>;
  idColumn: string;
}) {
  const idAt = file.columns.findIndex((c) => c.pointer === idColumn);
  const shown = file.preview.rows.length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus to scroll by keyboard
        tabIndex={0}
        aria-label="First rows of the file"
        className="max-h-72 overflow-auto rounded-lg border border-border bg-surface-raised"
      >
        <table className="w-full border-separate border-spacing-0 text-left text-xs">
          <thead>
            <tr>
              {file.preview.header.map((h, i) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: headers are unique per file but may repeat after trimming
                  key={i}
                  scope="col"
                  className={cn(
                    'sticky top-0 z-10 max-w-56 truncate border-b border-border bg-surface-sunken px-3 py-2 font-medium whitespace-nowrap text-fg-muted',
                    i === idAt && 'text-accent-fg',
                  )}
                >
                  {h}
                  {i === idAt ? <span className="ml-1.5 font-semibold">ID</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {file.preview.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no id
              <tr key={r}>
                {row.map((cell, i) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the header's order
                    key={i}
                    title={cell}
                    className={cn(
                      'max-w-56 truncate border-b border-border/60 px-3 py-1.5 whitespace-nowrap text-fg',
                      i === idAt && 'bg-accent-subtle font-mono',
                    )}
                  >
                    {cell === '' ? <span className="text-fg-subtle">—</span> : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {file.rows > shown ? (
        <p className="text-xs text-fg-muted">
          First {formatCount(shown)} of {formatCount(file.rows)} rows.
        </p>
      ) : null}
    </div>
  );
}
