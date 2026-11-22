import { useEffect, useRef, useState } from 'react';
import type { SetupCheck } from '@/shared/contracts/pass-setup.ts';
import { fixLabel, PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { todoCount } from '@/shared/org-setup-checks.ts';
import { cn } from '@/web/lib/cn.ts';
import { prefersReducedMotion } from '@/web/lib/motion.ts';
import { BuddyFace } from '@/web/ui/art/face.tsx';
import { Button, Callout, Card, CardBody, CardHeader } from '@/web/ui/index.ts';
import './brand.css';

const keyOf = (c: SetupCheck) =>
  `${c.code}:${c.fix.target ?? ''}:${c.templateIds?.join(',') ?? ''}`;
const TONE = { error: 'danger', warn: 'warning', info: 'info' } as const;
/** A resolved check holds for 900 ms with its tick, then folds away over 240 ms. */
const HOLD_MS = 1200;

/** Checks that left the list since the last render, kept briefly so they can draw their tick. */
function useResolved(checks: readonly SetupCheck[]): SetupCheck[] {
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
 * Setup checks as suggestions or to-dos, never gates. Each row has one fix that works in place;
 * when it lands the row draws a check, holds, and folds away. At zero the buddy cheers.
 */
export function ChecksCard({
  checks,
  onFix,
  canFix,
}: {
  checks: readonly SetupCheck[];
  onFix: (check: SetupCheck) => void;
  canFix: boolean;
}) {
  const todo = todoCount(checks);
  const gone = useResolved(checks);
  const ready = checks.length === 0 && gone.length === 0;
  const pips = Math.min(todo, 5);
  return (
    <Card role="region" aria-label={PASS_SETUP_COPY.title}>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            {todo > 0 ? scanLine(PASS_SETUP_COPY.toDo, { n: todo }) : PASS_SETUP_COPY.ready}
            <span aria-hidden className="inline-flex gap-1">
              {Array.from({ length: Math.max(pips, 1) }, (_, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: pips are positional
                  key={i}
                  className={cn('h-1 w-3 rounded-full', todo > 0 ? 'bg-warning' : 'bg-success')}
                />
              ))}
            </span>
          </span>
        }
        actions={<BuddyFace className="h-6 w-7" />}
      />
      <CardBody>
        {ready ? (
          <div className="flex flex-col items-center gap-2 py-2">
            <BuddyFace scene="cheer" size="md" className="h-16 w-20" />
            <p className="text-sm font-medium text-fg-strong">{PASS_SETUP_COPY.page.allSet}</p>
          </div>
        ) : (
          <ul className="wl-stagger m-0 flex list-none flex-col p-0">
            {gone.map((c) => (
              <li key={keyOf(c)} className="bc-check" data-done="">
                <div>
                  <Callout tone="success">{c.message}</Callout>
                </div>
              </li>
            ))}
            {checks.map((c, i) => (
              <li key={keyOf(c)} className="bc-check" style={{ '--i': i } as never}>
                <div>
                  <Callout
                    tone={TONE[c.level]}
                    actions={
                      canFix ? (
                        <Button variant="outline" size="sm" onClick={() => onFix(c)}>
                          {fixLabel(c.fix.action, c.fix.target)}
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
        )}
      </CardBody>
    </Card>
  );
}
