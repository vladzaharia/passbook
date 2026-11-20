import type { Island } from '../shell/islands.ts';
import { mountLogs } from './island.ts';
import { loadOps } from './ops.ts';
import { mountRail } from './rail.ts';

/** The log island: the list, with the operation index loaded only when a row opens. */
export const logsIsland: Island = { mount: (el) => mountLogs(el, loadOps()) };
export const railIsland: Island = { mount: (el) => mountRail(el) };
