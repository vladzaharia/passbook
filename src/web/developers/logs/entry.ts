import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { mountLogs } from './island.ts';
import { loadOps } from './ops.ts';
import { mountRail } from './rail.ts';

/** The log island: the list, with the operation index loaded only when a row opens. */
/** Signed out: the prerendered state, with its sign-in link, stays and nothing is asked of the API. */
const signedIn = async () => (await loadSession()).kind !== 'out';
export const logsIsland: Island = {
  mount: async (el) => {
    if (await signedIn()) await mountLogs(el, loadOps());
  },
};
export const railIsland: Island = {
  mount: async (el) => {
    if (await signedIn()) await mountRail(el);
  },
};
