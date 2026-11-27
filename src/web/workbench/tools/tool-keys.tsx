import { useOptionalToolHost } from '../host/tool-host.tsx';
import { KeysTool } from '../keys/keys-tool.tsx';
import { ToolPlaceholder } from './placeholder.tsx';

/** Keys: admin's keys components on the Workbench token. */
export function KeysToolPage() {
  return useOptionalToolHost() ? <KeysTool /> : <ToolPlaceholder tool="keys" />;
}
