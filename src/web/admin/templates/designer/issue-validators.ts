import { serverDuplicate } from './access/issues.ts';
import { localIssues } from './local-issues.ts';
import { scanIssues } from './scan/document.ts';

/**
 * The local validators (access, scan actions, the scan screen) behind one lazy import, so the
 * designer's first load carries none of them. `use-designer-issues.ts` loads this once.
 */
export { localIssues, scanIssues, serverDuplicate };
