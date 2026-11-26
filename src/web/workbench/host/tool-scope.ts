/**
 * The one tool scope (DC1, `lib/tool-api.tsx`), as Workbench tools import it: the client, mode and
 * org this space's host pins (tool-host.tsx). Admin's shared tools read the same module.
 */
export { useToolApi, useToolMode, useToolScope } from '../../lib/tool-api.tsx';
