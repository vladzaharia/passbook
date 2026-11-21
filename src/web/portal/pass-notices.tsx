import type { MyPassListSchema } from '../../shared/contracts/me.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';

type Reissue = (typeof MyPassListSchema._output)['reissueRequired'];

/** My passes' notices, above the stack: removals still running, passes that need a new copy. */
export function PassNotices({ pending, reissue }: { pending: number; reissue: Reissue }) {
  return (
    <>
      {pending > 0 ? (
        <p
          role="status"
          className="mb-6 rounded-xl border border-border bg-surface-raised p-4 text-sm text-fg-muted"
        >
          {HOLDER_COPY.removalPending(pending)} {HOLDER_COPY.removalPendingLine}
        </p>
      ) : null}
      {reissue.length > 0 ? (
        <section
          className="mb-6 rounded-xl border border-border bg-surface-raised p-4"
          aria-labelledby="reissue-title"
        >
          <h2 id="reissue-title" className="text-sm font-semibold text-fg-strong">
            {HOLDER_COPY.reissueTitle}
          </h2>
          <ul className="mt-2 space-y-2 text-sm text-fg-muted">
            {reissue.map((item) => {
              const href = item.support?.email ? `mailto:${item.support.email}` : item.support?.url;
              return (
                <li key={item.passId}>
                  {HOLDER_COPY.reissueLine(item.title ?? 'A pass', item.orgName)}{' '}
                  {href ? (
                    <a
                      href={href}
                      className="font-medium text-accent-fg underline-offset-4 hover:underline"
                    >
                      {HOLDER_COPY.contact(item.orgName)}
                    </a>
                  ) : (
                    HOLDER_COPY.reissueAsk(item.orgName)
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
