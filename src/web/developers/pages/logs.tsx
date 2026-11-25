import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { BuddyArt } from '../../ui/art/buddy-art.tsx';

/**
 * The request log's prerendered page: the signed-out state. The islands replace it once the session reads the
 * sandbox's log (`/api/v1/developer/logs`); a signed-out visitor loads neither. The header keeps a slot for the
 * listener's mark, and the "Your API" strip's slot stays empty until it has something to show.
 */
export function LogsView() {
  return (
    <>
      <div className="logs-h">
        <h1 className="h1 page-h">{LOGS_COPY.title}</h1>
        <div className="logs-live-slot" data-logs-live="" />
      </div>
      <div className="logs-api" data-island="api-rail" />
      <div className="logs-main" data-island="logs">
        <section className="card pstate" data-kind="empty" aria-labelledby="logs-gate-t">
          <BuddyArt size="sm" at="end" still />
          <h2 id="logs-gate-t" className="h2 pstate-t">
            {LOGS_COPY.signedOut}
          </h2>
          <div className="pstate-a">
            <a className="btn" href="/login?next=%2Fdevelopers%2Flogs">
              {LOGS_COPY.signIn}
            </a>
          </div>
        </section>
      </div>
    </>
  );
}
