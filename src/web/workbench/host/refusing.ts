import { WB_STATES } from '@/shared/copy/workbench-states.ts';
import { ApiError } from '../../lib/errors.ts';
import type { WorkbenchApi } from './api.ts';

const refuse = (): Promise<never> =>
  Promise.reject(
    new ApiError({ status: 403, code: 'no_context', detail: WB_STATES.failed.noContext }),
  );

/**
 * The client a tool gets where no context is pinned (the chooser, signed out, a context that is
 * not this person's): every call is refused before it leaves the page. The Workbench never falls
 * back to the session client.
 */
export const refusingApi: Omit<WorkbenchApi, 'orgId'> = {
  get: refuse,
  post: refuse,
  put: refuse,
  patch: refuse,
  deleteJson: refuse,
  delete: refuse,
  action: refuse,
};
