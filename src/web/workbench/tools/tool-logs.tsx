import { useEffect } from 'react';
import { useOptionalToolHost } from '../host/tool-host.tsx';
import { LogsTool } from '../logs/logs-tool.tsx';
import { migrateHash } from '../logs/model.ts';
import { ToolPage } from '../shell/tool-page.tsx';
import { useBenchRouter } from './legacy.tsx';
import { ToolPlaceholder } from './placeholder.tsx';

/** Logs: the org's Test calls on the Workbench token, in the sandbox and in an org's Test mode alike. */
export function LogsPage() {
  const host = useOptionalToolHost();
  useBenchRouter();
  useEffect(migrateHash, []);
  if (!host) return <ToolPlaceholder tool="logs" />;
  return (
    <ToolPage tool="logs">
      <div className="wb-legacy wb-tool-logs">
        <LogsTool />
      </div>
    </ToolPage>
  );
}
