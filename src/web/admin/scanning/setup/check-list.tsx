import { Link } from '@tanstack/react-router';
import { Check, Info, OctagonX, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ScanSetupCheck } from '@/shared/contracts/scan-setup-intent.ts';
import { cn } from '@/web/lib/cn.ts';
import { prefersReducedMotion } from '@/web/lib/motion.ts';
import { Button } from '@/web/ui/index.ts';
import { checkText, fixLabel } from './copy.ts';
import './setup.css';

const keyOf = (c: ScanSetupCheck) =>
  `${c.code}|${c.door ?? ''}|${c.subject?.ref ?? ''}|${JSON.stringify(c.params ?? {})}`;

const TONE = {
  error: { icon: OctagonX, box: 'border-danger-border bg-danger-subtle', text: 'text-danger' },
  warn: {
    icon: TriangleAlert,
    box: 'border-warning-border bg-warning-subtle',
    text: 'text-warning',
  },
  info: { icon: Info, box: 'border-info-border bg-info-subtle', text: 'text-info' },
} as const;

/** Resolved rows stay a moment with a check, then collapse. */
const HOLD_MS = 1200;

function Row({
  check,
  resolved,
  names,
  onFix,
}: {
  check: ScanSetupCheck;
  resolved: boolean;
  names: { device?: string; person?: string };
  onFix: (c: ScanSetupCheck) => void;
}) {
  const tone = TONE[check.level];
  const Icon = tone.icon;
  const fix = check.fix;
  return (
    <li className="wl-check-row" data-gone={resolved || undefined} data-level={check.level}>
      <div>
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm text-fg-strong',
            resolved ? 'border-success-border bg-success-subtle' : tone.box,
          )}
        >
          {resolved ? (
            <span className="wl-check-done grid size-5 shrink-0 place-items-center rounded-full bg-success text-success-on">
              <Check aria-hidden className="size-3.5" />
            </span>
          ) : (
            <Icon aria-hidden className={cn('size-5 shrink-0', tone.text)} />
          )}
          <span className="min-w-0 flex-1 basis-48">{checkText(check)}</span>
          {fix && !resolved ? (
            fix.kind === 'open_template' ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  to="/admin/templates/$templateId/design"
                  params={{ templateId: fix.templateId }}
                >
                  {fixLabel(fix, names)}
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onFix(check)}>
                {fixLabel(fix, names)}
              </Button>
            )
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * The plan's checks, each with its one-tap fix. A fixed check turns to a check mark, holds, then
 * collapses; a check that comes back appears again.
 */
export function CheckList({
  checks,
  namesFor,
  onFix,
}: {
  checks: readonly ScanSetupCheck[];
  namesFor: (c: ScanSetupCheck) => { device?: string; person?: string };
  onFix: (c: ScanSetupCheck) => void;
}) {
  const [held, setHeld] = useState<ScanSetupCheck[]>([]);
  const prev = useRef(checks);
  useEffect(() => {
    const now = new Set(checks.map(keyOf));
    const fixed = prev.current.filter((c) => !now.has(keyOf(c)));
    prev.current = checks;
    if (fixed.length === 0) return;
    setHeld((h) => [...h, ...fixed]);
    const timer = setTimeout(
      () => setHeld((h) => h.filter((c) => !fixed.includes(c))),
      prefersReducedMotion() ? 0 : HOLD_MS,
    );
    return () => clearTimeout(timer);
  }, [checks]);
  const shown = [...checks, ...held.filter((c) => !checks.some((x) => keyOf(x) === keyOf(c)))];
  if (shown.length === 0)
    return (
      <p className="flex items-center gap-2 text-sm text-fg-muted">
        <Check aria-hidden className="size-4 text-success" />
        All good
      </p>
    );
  return (
    <ul aria-label="Checks" className="grid gap-2">
      {shown.map((c) => (
        <Row
          key={keyOf(c)}
          check={c}
          resolved={!checks.some((x) => keyOf(x) === keyOf(c))}
          names={namesFor(c)}
          onFix={onFix}
        />
      ))}
    </ul>
  );
}
