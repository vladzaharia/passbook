import { AtSign, Calendar, Hash, Link, List, ToggleLeft, Type } from 'lucide-react';
import type { FieldKind } from './datasets.ts';
import { kindOf, showValue } from './datasets.ts';

const GLYPH = {
  text: Type,
  number: Hash,
  date: Calendar,
  email: AtSign,
  link: Link,
  toggle: ToggleLeft,
  list: List,
} satisfies Record<FieldKind, typeof Type>;

/** The first record's fields: a type glyph, the pointer, and the value as the title. */
export function FieldChips({
  sample,
}: {
  sample: readonly { pointer: string; preview: string }[];
}) {
  return (
    <ul aria-label="Fields in the first record" className="flex flex-wrap gap-1.5">
      {sample.map((f) => {
        const Glyph = GLYPH[kindOf(f.preview)];
        return (
          <li
            key={f.pointer}
            title={showValue(f.preview)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs text-fg"
          >
            <Glyph aria-hidden className="size-3 shrink-0 text-fg-muted" />
            {f.pointer}
          </li>
        );
      })}
    </ul>
  );
}
