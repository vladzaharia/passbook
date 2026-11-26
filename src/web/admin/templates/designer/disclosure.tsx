import { ChevronRight } from 'lucide-react';
import { type CSSProperties, type ReactNode, useId } from 'react';
import { useChangeCount } from '../../../lib/motion.ts';
import { Badge } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { type Section, sectionLabel } from './model.ts';

/** The count pops when it changes, not when the page opens. */
function Count({ n }: { n: number }) {
  const changes = useChangeCount(n);
  return (
    <Badge key={changes} className={changes > 0 ? 'dz-count' : undefined}>
      {n}
    </Badge>
  );
}

/** One section of an inspector: a heading that opens its panel; one is open at a time. */
export function Disclosure({
  section,
  count,
  value,
  label,
  index,
  children,
}: {
  section: Section;
  count?: number | undefined;
  /** Right-aligned text beside the count: the current choice (Loyalty, 1 of 3). */
  value?: string | undefined;
  /** Overrides the section's name (a per-wallet title). */
  label?: string | undefined;
  index: number;
  children: ReactNode;
}) {
  const { state, select } = useDesigner();
  const open = state.select.section === section;
  const id = useId();
  const name = label ?? sectionLabel(section);
  return (
    <li
      className="dz-section"
      data-open={open || undefined}
      style={{ '--i': index } as CSSProperties}
    >
      <h2>
        <button
          type="button"
          className="dz-head"
          data-target={section}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => select(open ? { section: 'none' } : { section })}
        >
          <ChevronRight aria-hidden className="dz-chevron size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{name}</span>
          {value ? <span className="text-xs font-normal text-fg-muted">{value}</span> : null}
          {count !== undefined ? <Count n={count} /> : null}
        </button>
      </h2>
      {open ? (
        <section id={id} aria-label={name} className="dz-panel">
          {children}
        </section>
      ) : null}
    </li>
  );
}
