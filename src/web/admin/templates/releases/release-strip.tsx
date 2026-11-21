import { ChevronRight, FlaskConical, Pencil, Rocket, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TemplateReleaseState } from '@/shared/contracts/template-release-flow.ts';
import { cn } from '../../../lib/cn.ts';
import { formatDay } from '../../../lib/format.ts';
import { prefersReducedMotion } from '../../../lib/motion.ts';
import { Button } from '../../../ui/index.ts';
import './release-strip.css';

/** A number that rolls up when it changes after mount (never on first paint). */
function Roll({ value }: { value: string }) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <span key={value} className={cn('wl-roll', mounted.current && 'wl-roll-go')}>
      {value}
    </span>
  );
}

function Cell({
  tone,
  icon,
  label,
  value,
  sub,
  children,
}: {
  tone: 'draft' | 'test' | 'live';
  icon: React.ReactNode;
  label: string;
  value: string | null;
  sub: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="wl-strip-cell" data-tone={tone}>
      <p className="wl-strip-label">
        {icon}
        {label}
      </p>
      <p className="wl-strip-value">
        {value ? <Roll value={value} /> : <span className="text-fg-muted">—</span>}
        {children}
      </p>
      <p className="wl-strip-sub">{sub}</p>
    </div>
  );
}

export function ReleaseStrip({
  state,
  name,
  alt,
  onTry,
  onRelease,
}: {
  state: TemplateReleaseState;
  /** "v2" from a version hash. */
  name: (hash: string | null) => string;
  /** The alternative to the header's primary, for the viewer who may act. */
  alt: 'try' | 'release' | null;
  onTry: () => void;
  onRelease: () => void;
}) {
  const { live, test, draft } = state;
  const liveName = live ? name(live.version) : null;
  const flown = useRef(liveName);
  const [flight, setFlight] = useState(0);
  useEffect(() => {
    if (flown.current === liveName) return;
    flown.current = liveName;
    if (!prefersReducedMotion()) setFlight((n) => n + 1);
  }, [liveName]);
  const testSub = !test
    ? 'Not released'
    : test.state === 'ahead'
      ? 'Trying'
      : live
        ? 'Same as Live'
        : 'Released';
  return (
    <section aria-label="Release" className="wl-strip mb-6">
      <Cell
        tone="draft"
        icon={<Pencil aria-hidden />}
        label="Draft"
        value={draft ? name(draft.version) : null}
        sub={draft ? 'Saved' : 'Nothing new'}
      />
      <ChevronRight aria-hidden className="wl-strip-arrow wl-strip-arrow-1" />
      <Cell
        tone="test"
        icon={<FlaskConical aria-hidden />}
        label="Test"
        value={test ? name(test.version) : null}
        sub={testSub}
      />
      <ChevronRight aria-hidden className="wl-strip-arrow wl-strip-arrow-2" />
      <Cell
        tone="live"
        icon={<span aria-hidden className="wl-strip-dot" />}
        label="Live"
        value={liveName}
        sub={live ? `Since ${formatDay(live.at)}` : 'Not released'}
      />
      {alt ? (
        <div className="wl-strip-alt">
          <Button
            size="sm"
            variant={alt === 'release' ? 'outline' : 'ghost'}
            iconStart={alt === 'try' ? <Smartphone aria-hidden /> : <Rocket aria-hidden />}
            onClick={alt === 'try' ? onTry : onRelease}
          >
            {alt === 'try' ? 'Try' : 'Release'}
          </Button>
        </div>
      ) : null}
      {flight > 0 ? (
        <span key={flight} aria-hidden className="wl-strip-token">
          {liveName}
        </span>
      ) : null}
    </section>
  );
}
