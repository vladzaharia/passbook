import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Buddy } from '../../ui/art/buddy.tsx';
import { LensArt } from '../../ui/art/lens.tsx';
import { LogArt } from '../../ui/art/log.tsx';
import '../../ui/art/scenes/inspect.css';
import { CopyButton } from '../ui/code.tsx';
import { CodeView } from '../ui/code-view.tsx';
import { draw } from './state.tsx';

const E = LOGS_COPY.empty;

/** The one call to make first: a read any sandbox key may make, with the key from the environment. */
const firstCall = (origin: string) =>
  `curl ${origin}/api/v1/passes?limit=1 \\\n  -H "Authorization: Bearer $PASSBOOK_KEY"`;

interface FirstCallProps {
  origin: string;
  /** The sandbox has a key to call with; without one the card says so, once, and links to make one. */
  hasKey: boolean;
  /** Calls exist from the portal (Run here, its own reads): offer them. */
  onPortal?: () => void;
}

/**
 * Nothing logged yet: the buddy looks over the empty log, and the card holds the one thing to do next, the call
 * itself ready to copy, or the way to a key when there is none.
 */
function FirstCall({ origin, hasKey, onPortal }: FirstCallProps) {
  return (
    <section className="card logs-first" aria-labelledby="logs-first-t">
      <Buddy mood="curious" size="sm" scene="inspect" prop={<LogArt size="sm" />} />
      <h2 id="logs-first-t" className="h2">
        {hasKey ? E.title : E.noKeyTitle}
      </h2>
      {hasKey ? (
        <div className="code logs-curl">
          <div className="code-h">
            <span className="tab" aria-current="true">
              curl
            </span>
            <CopyButton label={E.copy} />
          </div>
          <CodeView code={firstCall(origin)} lang="curl" label="curl" />
        </div>
      ) : (
        <p className="sm muted">{E.noKey}</p>
      )}
      <div className="logs-first-a">
        {hasKey ? null : (
          <a className="btn" href={PATHS.keys}>
            {E.makeKey}
          </a>
        )}
        <a className="btn outline" href={PATHS.console}>
          {E.console}
        </a>
        {onPortal ? (
          <button type="button" className="btn ghost" onClick={onPortal}>
            {E.portal}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export const showFirstCall = (el: HTMLElement, props: FirstCallProps) =>
  draw(el, <FirstCall {...props} />);

/** Filters that match nothing: the log under the lens, and the way back. */
export const showNoMatch = (el: HTMLElement, onClear: () => void) =>
  draw(
    el,
    <div className="logs-nomatch">
      <span className="logs-lens" aria-hidden="true">
        <LogArt size="sm" still />
        <LensArt size="sm" still />
      </span>
      <p className="sm">{E.noMatch}</p>
      <button type="button" className="btn outline sm" onClick={onClear}>
        {E.clear}
      </button>
    </div>,
  );
