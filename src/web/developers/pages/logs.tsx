import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Gate } from '../ui/gate.tsx';

/**
 * The request log's prerendered page, in the bench frame: the signed-out state. The islands replace it once the
 * session reads the sandbox's log (`/api/v1/developer/logs`); a signed-out visitor loads neither. The listener's
 * mark goes in the frame's strip, and the "Your API" strip's slot stays empty until it has something to show.
 */
export function LogsView() {
  return (
    <>
      <div className="logs-api" data-island="api-rail" />
      <div className="logs-main" data-island="logs">
        <Gate title={GATE_COPY.lines.logs} next={PATHS.logs} />
      </div>
    </>
  );
}
