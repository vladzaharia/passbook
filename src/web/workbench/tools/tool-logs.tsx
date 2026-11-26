import { useEffect } from 'react';
import { LogsTool } from '../logs/logs-tool.tsx';
import { migrateHash } from '../logs/model.ts';
import { LegacyTool } from './legacy.tsx';

function Body() {
  useEffect(migrateHash, []);
  return <LogsTool />;
}

/** Logs (T2 rebuilds it on the token client): the moved bench tool on the sandbox's session. */
export function LogsPage() {
  return (
    <LegacyTool tool="logs" className="wb-tool-logs">
      {() => <Body />}
    </LegacyTool>
  );
}
