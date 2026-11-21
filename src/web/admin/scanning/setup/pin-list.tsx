import { Copy, Lock } from 'lucide-react';
import { copyText } from '@/web/lib/clipboard.ts';
import { Badge, Button } from '@/web/ui/index.ts';

export interface PinRow {
  id: string;
  name: string;
  role: string;
  pin: string;
}

const ROLE = { door: 'Door', desk: 'Desk', manager: 'Manager' } as Record<string, string>;
export const roleLabel = (role: string): string => ROLE[role] ?? role;
/** "482 913": two groups, easy to read aloud. */
const spaced = (pin: string) => `${pin.slice(0, 3)} ${pin.slice(3)}`;

/** Each PIN in clear, once. Copy all puts every name and PIN on the clipboard. */
export function PinList({ rows }: { rows: readonly PinRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="PINs" className="rounded-lg border border-border bg-surface-raised">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-fg-strong">PINs</h3>
        <Badge tone="warning">
          <Lock aria-hidden />
          Shown once
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          iconStart={<Copy aria-hidden />}
          onClick={() =>
            void copyText(
              rows.map((r) => `${r.name} (${roleLabel(r.role)}): ${r.pin}`).join('\n'),
              'PINs',
            )
          }
        >
          Copy all
        </Button>
      </div>
      <ul>
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0"
          >
            <span
              aria-hidden
              className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-subtle text-xs font-semibold text-accent-fg"
            >
              {r.name.trim().slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg-strong">{r.name}</p>
              <p className="text-xs text-fg-muted">{roleLabel(r.role)}</p>
            </div>
            <code className="font-mono text-lg tracking-[0.18em] text-fg-strong tabular-nums">
              {spaced(r.pin)}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}
