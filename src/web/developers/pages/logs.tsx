import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Gate } from '../ui/gate.tsx';

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
        <Gate title={GATE_COPY.lines.logs} next={PATHS.logs} />
      </div>
    </>
  );
}
