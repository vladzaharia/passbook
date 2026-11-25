import { type ConnectionFilesPort, ConnectorError } from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** Whose files a context reads: a saved connection's revisions, or the draft an unsaved test names. */
export type FilesBinding =
  | { orgId: string; connectionId: string }
  | { orgId: string; draftId: string | null };

/** Stub until the files store lands: every read fails as CONFIG, so no upload connector can sync yet. */
export function filesPort(_sctx: ServiceContext, _binding: FilesBinding): ConnectionFilesPort {
  const refuse = (): Promise<never> =>
    Promise.reject(new ConnectorError('CONFIG', { permanent: true }));
  return { current: refuse, previous: refuse, page: refuse, refs: refuse, find: refuse };
}
