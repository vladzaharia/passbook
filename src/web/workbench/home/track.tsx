import { Check } from 'lucide-react';
import type { DeveloperProgress } from '../../../shared/contracts/developer-home.ts';
import { duration, ticksOf } from './model.ts';

/** The quickstart's five ticks and its time. Unfinished, it offers Continue; on a phone it is one row of dots. */
export function Track({
  progress,
  quickstart,
}: {
  progress: DeveloperProgress;
  quickstart: string;
}) {
  const ticks = ticksOf(progress);
  const done = ticks.filter((t) => t.at !== null).length;
  const current = ticks.find((t) => t.current);
  return (
    <section className="card wb-track" aria-labelledby="wb-track-h">
      <div className="wb-track-top">
        <h2 id="wb-track-h" className="h3">
          Quickstart
        </h2>
        <span className="muted xs mono" data-testid="wb-track-count">
          {done} of {ticks.length}
        </span>
        {progress.doneMs !== null ? (
          <span className="wb-time" data-testid="wb-track-time">
            First pass in <b className="mono">{duration(progress.doneMs)}</b>
          </span>
        ) : (
          <a className="btn sm wb-continue" href={quickstart}>
            Continue
          </a>
        )}
      </div>
      <ol className="wb-ticks">
        {ticks.map((t) => (
          <li
            key={t.id}
            className="wb-tick"
            data-done={t.at !== null ? '' : undefined}
            data-current={t.current ? '' : undefined}
            aria-current={t.current ? 'step' : undefined}
          >
            <span className="wb-dot" aria-hidden>
              {t.at !== null ? <Check strokeWidth={3} /> : null}
            </span>
            <span className="wb-tick-label">{t.label}</span>
            <span className="sr">{t.at !== null ? 'Done' : t.current ? 'Next' : 'To do'}</span>
          </li>
        ))}
      </ol>
      {current ? (
        <p className="wb-track-next xs muted">
          Next: <span className="strong">{current.label}</span>
        </p>
      ) : null}
    </section>
  );
}
