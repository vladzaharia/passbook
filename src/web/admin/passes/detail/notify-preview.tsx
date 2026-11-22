import { Bell } from 'lucide-react';
import type { FieldChange } from '@/shared/contracts/issuing.ts';

export interface Notice {
  changes: FieldChange[];
  /** The daily notification limit is used up: the save updates the pass silently. */
  silent: boolean;
}

interface Field {
  label?: unknown;
  changeMessage?: unknown;
}

/** The pass's fields that carry a lock-screen message, by label. */
function messages(passJson: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const f = node as Field;
    if (typeof f.label === 'string' && typeof f.changeMessage === 'string')
      out.set(f.label.trim(), f.changeMessage);
    Object.values(node).forEach(walk);
  };
  walk(passJson);
  return out;
}

/** What Wallet shows for a change: the template's message, else "<Label> is now <value>". */
export function noticeLines(changes: readonly FieldChange[], passJson: unknown): string[] {
  const own = messages(passJson);
  return changes.map((c) => {
    const to = c.to ?? 'empty';
    const text = own.get(c.label.trim());
    return text ? text.replace('%@', to).replace(/%%/g, '%') : `${c.label} is now ${to}`;
  });
}

/** The name Wallet shows on the banner: the pass's organization. */
export function orgLine(passJson: unknown): string | null {
  const name = (passJson as { organizationName?: unknown } | null)?.organizationName;
  return typeof name === 'string' && name ? name : null;
}

/** The lock-screen banner a save with Notify sends, under the card. */
export function NotifyPreview({
  notice,
  passJson,
  title,
}: {
  notice: Notice;
  passJson: unknown;
  title: string;
}) {
  if (notice.silent)
    return (
      <p className="flex items-center gap-2 text-xs text-fg-muted">
        <Bell aria-hidden className="size-3.5" />
        No notification: the daily limit is used.
      </p>
    );
  const lines = noticeLines(notice.changes, passJson);
  return (
    <section
      aria-label="Notification preview"
      className="wl-deal mx-auto w-full max-w-72 rounded-3xl bg-neutral-900/90 p-2 text-white shadow-elevation-2"
    >
      <div className="rounded-2xl bg-white/12 px-3 py-2.5 backdrop-blur">
        <div className="flex items-center justify-between text-xs text-white/70">
          <span className="font-medium">Wallet</span>
          <span>now</span>
        </div>
        <p className="mt-1 truncate text-sm font-semibold">{title}</p>
        <ul className="text-sm text-white/90">
          {lines.slice(0, 3).map((l) => (
            <li key={l} className="break-words">
              {l}
            </li>
          ))}
        </ul>
        {lines.length > 3 ? (
          <p className="mt-1 text-xs text-white/60">+{lines.length - 3} more</p>
        ) : null}
      </div>
    </section>
  );
}
