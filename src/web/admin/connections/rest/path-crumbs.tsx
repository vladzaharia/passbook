import { unescapeToken } from '@/shared/records/fields.ts';
import { pointerToJsonPath, recordsJsonPath } from '@/shared/rest/json-path.ts';
import { CopyButton } from '../../../ui/index.ts';
import { relativeTo } from './rest-values.ts';

/** `data › [*] › email`: where a node sits, with the item index of the records as a wildcard. */
export function crumbsOf(pointer: string, records: string): string[] {
  if (pointer === '') return ['$'];
  const rel = relativeTo(records, pointer);
  const own = rel === null ? pointer : records;
  const tokens = (p: string) => p.split('/').slice(1).map(unescapeToken);
  const out = tokens(own);
  if (rel !== null) out.push('[*]', ...tokens(rel));
  return out;
}

/** The JSONPath of a node: `$.data[*].email` inside the records, a plain path elsewhere. */
export function jsonPathOf(pointer: string, records: string): string {
  const rel = relativeTo(records, pointer);
  return rel === null ? pointerToJsonPath(pointer) : recordsJsonPath(records, rel);
}

export function PathCrumbs({ pointer, records }: { pointer: string; records: string }) {
  const path = jsonPathOf(pointer, records);
  const crumbs = crumbsOf(pointer, records);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <ol
        aria-label="Path"
        className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm text-fg-muted"
      >
        {crumbs.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a path repeats names
          <li key={i} className="flex items-center gap-1">
            {i > 0 ? <span aria-hidden>›</span> : null}
            <span className={i === crumbs.length - 1 ? 'font-medium text-fg' : undefined}>{c}</span>
          </li>
        ))}
      </ol>
      <div className="flex min-w-0 items-center gap-1">
        <code className="min-w-0 break-all rounded-md bg-surface-sunken px-2 py-1 font-mono text-xs text-fg">
          {path}
        </code>
        <CopyButton value={path} label="Copy JSONPath" />
      </div>
    </div>
  );
}
