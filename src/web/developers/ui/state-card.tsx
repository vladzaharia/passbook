import type { ReactNode } from 'react';
import { Buddy } from '../../ui/art/buddy.tsx';
import { LogArt } from '../../ui/art/log.tsx';
import { UnpluggedArt } from '../../ui/art/unplugged.tsx';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/inspect.css';
import '../../ui/art/scenes/peek.css';
import '../../ui/art/scenes/plug.css';
import '../../ui/art/scenes/wave.css';
import './state-card.css';

/**
 * An empty or failed portal page, in one shape: the buddy on the card's edge, a title, one action. Empty waves;
 * an error plugs the cable and carries Retry; a missing page is lost behind its lens; an empty log is
 * inspected (ui-consistency, Empty, loading, error).
 */
export function StateCard({
  kind,
  title,
  heading: Heading = 'h2',
  children,
}: {
  kind: 'empty' | 'error' | 'lost' | 'inspect';
  title: string;
  heading?: 'h1' | 'h2';
  /** The action: a button or link, or the create control. */
  children?: ReactNode;
}) {
  return (
    <section className="card pstate" data-kind={kind} aria-label={title}>
      {kind === 'error' ? (
        <Buddy mood="sad" size="sm" at="end" scene="plug" prop={<UnpluggedArt size="sm" />} />
      ) : kind === 'lost' ? (
        <Buddy mood="sad" state="lost" size="lg" at="end" scene="peek" />
      ) : kind === 'inspect' ? (
        <Buddy mood="curious" size="sm" at="end" scene="inspect" prop={<LogArt size="sm" />} />
      ) : (
        <Buddy size="sm" at="end" scene="wave" />
      )}
      <Heading className={kind === 'lost' ? 'h1 pstate-t' : 'h2 pstate-t'}>{title}</Heading>
      {children ? <div className="pstate-a">{children}</div> : null}
    </section>
  );
}

/** Retry for an error: a fresh read of the page. */
export function Retry({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn outline" onClick={onClick}>
      Retry
    </button>
  );
}
