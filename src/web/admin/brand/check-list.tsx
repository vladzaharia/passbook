import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { SetupCheck } from '@/shared/contracts/pass-setup.ts';
import { fixLabel } from '@/shared/copy/pass-setup.ts';
import { prefersReducedMotion } from '@/web/lib/motion.ts';
import { Button, Callout } from '@/web/ui/index.ts';
import './brand.css';

export const keyOf = (c: SetupCheck) =>
  `${c.code}:${c.fix.target ?? ''}:${c.templateIds?.join(',') ?? ''}`;
const TONE = { error: 'danger', warn: 'warning', info: 'info' } as const;
/** A resolved check holds for 900 ms with its tick, then folds away over 240 ms. */
const HOLD_MS = 1200;

/** Checks that left the list since the last render, kept briefly so they can draw their tick. */
export function useResolved(checks: readonly SetupCheck[]): SetupCheck[] {
  const prev = useRef<SetupCheck[]>([]);
  const [gone, setGone] = useState<SetupCheck[]>([]);
  useEffect(() => {
    const now = new Set(checks.map(keyOf));
    const left = prev.current.filter((c) => !now.has(keyOf(c)));
    prev.current = [...checks];
    if (left.length === 0 || prefersReducedMotion()) return;
    setGone((g) => [...g, ...left]);
    const t = setTimeout(
      () => setGone((g) => g.filter((c) => !left.some((l) => keyOf(l) === keyOf(c)))),
      HOLD_MS,
    );
    return () => clearTimeout(t);
  }, [checks]);
  return gone.filter((c) => !checks.some((k) => keyOf(k) === keyOf(c)));
}

/**
 * The rows: one callout per check with its one fix; a row that leaves the list draws its tick,
 * holds, and folds away. The page's card and the pass screens' rows are this one list.
 */
export function CheckList({
  checks,
  onFix,
  canFix,
  doneText,
  empty,
  inline,
  fixText,
}: {
  checks: readonly SetupCheck[];
  onFix: (check: SetupCheck) => void;
  canFix: boolean;
  /** The words of a row that just resolved; absent: the check's own message. */
  doneText?: (check: SetupCheck) => string;
  /** Shown once nothing is left and the last tick has folded away. */
  empty?: ReactNode;
  /** The fix sits beside the sentence from sm up (a wide column), not under it. */
  inline?: boolean;
  /** Replaces a fix button's label. */
  fixText?: (check: SetupCheck) => string | undefined;
}) {
  const gone = useResolved(checks);
  if (checks.length === 0 && gone.length === 0) return empty ?? null;
  return (
    <ul className="wl-stagger m-0 flex list-none flex-col p-0">
      {gone.map((c) => (
        <li key={keyOf(c)} className="bc-check" data-done="">
          <div>
            <Callout tone="success">{doneText ? doneText(c) : c.message}</Callout>
          </div>
        </li>
      ))}
      {checks.map((c, i) => (
        <li key={keyOf(c)} className="bc-check" style={{ '--i': i } as never}>
          <div>
            <Callout
              tone={TONE[c.level]}
              actionsAside={inline}
              actions={
                canFix ? (
                  <Button variant="outline" size="sm" onClick={() => onFix(c)}>
                    {fixText?.(c) ?? fixLabel(c.fix.action, c.fix.target)}
                  </Button>
                ) : undefined
              }
            >
              {c.message}
            </Callout>
          </div>
        </li>
      ))}
    </ul>
  );
}
