import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { TEST_BAND_COPY } from '../../../shared/copy/developer.ts';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';

export const TOTAL_STEPS = 5;
export type StepState = 'done' | 'current' | 'todo';

/** One numbered step on the rail: a check when done, the number ringed when it is the one to do. */
export function Step({
  n,
  state,
  title,
  tag,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  tag?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="qs-step" data-state={state} data-step={n}>
      <span className="qs-dot" aria-hidden="true">
        {state === 'done' ? <Check className="lucide" /> : n}
      </span>
      <div className="qs-body">
        <h2 className="qs-h">
          <span>
            {state === 'done' ? <span className="sr">Done: </span> : null}
            {title}
          </span>
          {tag}
        </h2>
        {children}
      </div>
    </li>
  );
}

/** The foil bar and "3 of 5 · 1 min 12 s". Width is CSS on `data-done`: the page's CSP allows no inline style. */
export function Progress({ done, elapsed }: { done: number; elapsed: string }) {
  return (
    <div className="qs-progress">
      <div
        className="qs-bar"
        role="progressbar"
        aria-label="Quickstart progress"
        aria-valuemin={0}
        aria-valuemax={TOTAL_STEPS}
        aria-valuenow={done}
        data-done={done}
      >
        <span />
      </div>
      <span className="mono xs muted qs-count">
        {QS_COPY.progress(done, TOTAL_STEPS)} · {elapsed}
      </span>
    </div>
  );
}

export const Tag = ({ children }: { children: ReactNode }) => (
  <span className="pill info qs-tag">{children}</span>
);

/** The page: copy and steps on the left, the live pass on the right (below the third step when narrow). */
export function Layout({
  progress,
  steps,
  stage,
  wide,
}: {
  progress: ReactNode;
  steps: ReactNode;
  stage?: ReactNode;
  /** The finished page: `steps` is the whole body, with no step list and no stage. */
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'qs qs-wide' : 'qs'}>
      <div className="qs-main">
        {progress}
        {wide ? steps : <ol className="qs-steps">{steps}</ol>}
      </div>
      {wide ? null : (
        <aside className="qs-stage" aria-label={QS_COPY.stage.title}>
          {stage}
        </aside>
      )}
    </div>
  );
}

/** A card of the pass's shape with the Test band, the same before anything is made and in the signed-out page. */
export function GhostCard() {
  return (
    <div className="qs-ghost" aria-hidden="true">
      <div className="qs-ghost-band">{TEST_BAND_COPY}</div>
      <div className="qs-ghost-top">
        <span className="qs-ghost-logo" />
        <span className="qs-ghost-line w2" />
      </div>
      <div className="qs-ghost-art" />
      <div className="qs-ghost-row">
        <span className="qs-ghost-line w1" />
        <span className="qs-ghost-line w1" />
      </div>
      <div className="qs-ghost-code" />
    </div>
  );
}

/** The right column before there is a pass: a title, the ghost card and one sentence. */
export function EmptyStage({ line }: { line: string }) {
  return (
    <>
      <header className="qs-stage-h">
        <h2 className="h3">{QS_COPY.stage.title}</h2>
        <span className="pill neutral">{QS_COPY.stage.waiting}</span>
      </header>
      <div className="qs-stage-card stage">
        <GhostCard />
      </div>
      <p className="muted sm qs-empty">{line}</p>
    </>
  );
}
