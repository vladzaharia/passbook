import { LOGS_COPY, RAIL_COPY } from '../../../shared/copy/developers-ops.ts';
import { SIGN_IN } from './layout.tsx';

/**
 * The request log's prerendered page: the signed-out state. The islands replace it once the session reads the
 * sandbox's log (`/api/v1/developer/logs`); a signed-out visitor loads neither.
 */
export function LogsView() {
  return (
    <>
      <h1 className="h1 page-h">{LOGS_COPY.title}</h1>
      <p className="lede muted mt2 prose">{LOGS_COPY.lede}</p>
      <div className="logs-grid mt6">
        <aside
          className="card card-b logs-rail"
          data-island="api-rail"
          aria-label={RAIL_COPY.title}
        >
          <h3 className="h3">{RAIL_COPY.title}</h3>
          <p className="sm muted mt2">{RAIL_COPY.signedOut}</p>
        </aside>
        <div className="logs-main" data-island="logs">
          <div className="card card-b">
            <p className="muted">{LOGS_COPY.signedOut}</p>
            <a className="btn outline sm mt4" href={SIGN_IN}>
              Sign in
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
