import type { ReactNode } from 'react';
import type { DeveloperUsage } from '../../../shared/contracts/developer-home.ts';
import { count } from '../logs/format.ts';
import { meter, sparkPoints } from './model.ts';

const W = 120;
const H = 28;

function Spark({ values, tone }: { values: readonly number[]; tone: 'accent' | 'danger' }) {
  return (
    <svg
      className="wb-spark"
      data-line={tone}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline points={sparkPoints(values, W, H)} />
    </svg>
  );
}

function Stat({
  label,
  value,
  href,
  children,
}: {
  label: string;
  value: ReactNode;
  href?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className="wb-stat-label xs muted">{label}</span>
      <span className="wb-stat-value mono">{value}</span>
      {children}
    </>
  );
  return href ? (
    <a className="card link wb-stat" href={href}>
      {body}
    </a>
  ) : (
    <div className="card wb-stat">{body}</div>
  );
}

/** Calls and Errors (24 h, with sparklines; each opens its tool), Passes against the cap, Events captured. */
export function Stats({
  usage,
  passLimit,
  logs,
  webhooks,
}: {
  usage: DeveloperUsage;
  passLimit: number | null;
  logs: string;
  webhooks: string;
}) {
  const used = meter(usage.passes, passLimit);
  return (
    <div className="wb-stats">
      <Stat label="Calls 24 h" value={count(usage.calls24h)}>
        <Spark values={usage.series.calls} tone="accent" />
      </Stat>
      <Stat label="Errors 24 h" value={count(usage.errors24h)} href={logs}>
        <Spark values={usage.series.errors} tone="danger" />
      </Stat>
      <Stat
        label="Passes"
        value={
          <>
            {count(usage.passes)}
            {passLimit !== null ? (
              <span className="muted wb-of"> of {count(passLimit)}</span>
            ) : null}
          </>
        }
      >
        {passLimit !== null ? (
          <span className="wb-meter" aria-hidden data-used={used}>
            <span style={{ inlineSize: `${used}%` }} />
          </span>
        ) : null}
      </Stat>
      <Stat label="Events captured 24 h" value={count(usage.captures24h)} href={webhooks} />
    </div>
  );
}
