import { ChevronDown } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { PATHS } from '../../../shared/developers.ts';
import { subscribe } from '../console/budget.ts';
import { budgetMeter } from '../console/budget-meter.ts';

/** What the chip shows of a running operation on the sandbox: OP-2's `Operation`, structurally. */
export interface SandboxActivity {
  title: string;
  /** The current line: "Removing Test passes · 4 of 12". */
  text: string;
}

export type ChipState =
  | { kind: 'none' | 'closed' }
  | { kind: 'ready'; slug: string; activity?: SandboxActivity };

const C = BENCH_COPY.chip;
const ITEMS: readonly [string, string][] = [
  [C.items.home, PATHS.workbench],
  [C.items.quickstart, `${PATHS.quickstart}#sandbox`],
  [C.items.startOver, `${PATHS.quickstart}#start-over`],
  [C.items.delete, `${PATHS.quickstart}#delete-sandbox`],
];

/** The Run budget's bar and count (console/budget-meter.ts), kept live while it is on the page. */
export function BudgetMeter() {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const meter = budgetMeter();
    host.current?.replaceChildren(meter.node);
    return subscribe(meter.paint);
  }, []);
  return <span className="sbx-budget" ref={host} />;
}

function step(list: HTMLElement[], from: number, by: number | 'first' | 'last') {
  const i = by === 'first' ? 0 : by === 'last' ? list.length - 1 : from + by;
  list[(i + list.length) % list.length]?.focus();
}

/**
 * The sandbox you run against, with its menu: the Workbench home, the quickstart, Start over and
 * Delete. One component in two places: the top bar on docs pages (`bar`: the Run budget beside it) and
 * the Workbench's context strip (`strip`: the sandbox's name). A running operation on the sandbox
 * rings the mark and leads the menu. Without a sandbox it is the way to make one.
 */
export function SandboxChip({ variant, state }: { variant: 'bar' | 'strip'; state: ChipState }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  // biome-ignore lint/correctness/useExhaustiveDependencies: `items` reads the live menu; only `open` changes it.
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  if (state.kind !== 'ready')
    return (
      <a className={`btn outline sm sbx-make sbx-${variant}`} href={`${PATHS.quickstart}#sandbox`}>
        {state.kind === 'closed' ? BENCH_COPY.strip.closed : BENCH_COPY.strip.create}
      </a>
    );

  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = {
      ArrowDown: 1,
      ArrowUp: -1,
      Home: 'first',
      End: 'last',
    } as const;
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      close(true);
    } else if (e.key in move) {
      e.preventDefault();
      if (!open) setOpen(true);
      else step(list, at, move[e.key as keyof typeof move]);
    } else if (e.key === 'Tab') setOpen(false);
  };
  const { slug, activity } = state;
  return (
    <div ref={root} className={`sbx sbx-${variant}`} data-busy={activity ? '' : undefined}>
      <button
        ref={button}
        type="button"
        className="sbx-face"
        title={C.title(slug)}
        aria-label={activity ? `${C.menu}: ${C.busy(activity.title)}` : C.menu}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onKeyDown={onKey}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sbx-dot" aria-hidden="true">
          {(slug[0] ?? 's').toUpperCase()}
        </span>
        <span className="sbx-name">{variant === 'strip' ? slug : C.name}</span>
        <ChevronDown className="sbx-chev" aria-hidden="true" />
      </button>
      {variant === 'bar' ? <BudgetMeter /> : null}
      <div
        className="sbx-menu"
        id={menuId}
        role="menu"
        aria-label={C.menu}
        hidden={!open}
        onKeyDown={onKey}
      >
        {activity ? (
          <p className="sbx-op" role="presentation">
            <span className="sbx-op-t">{activity.title}</span>
            <span className="sbx-op-x">{activity.text}</span>
          </p>
        ) : null}
        {ITEMS.map(([label, href]) => (
          <a
            key={href}
            role="menuitem"
            tabIndex={-1}
            className="sbx-item"
            href={href}
            // A hash-only link (on the quickstart) leaves the page in place: the menu closes on a choice.
            onClick={() => close(false)}
          >
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}
