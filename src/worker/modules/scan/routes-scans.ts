import { createRouter } from '../../platform/openapi.ts';

/** Scans log and feed: /api/v1/scans. Empty until its stream fills it in; keep the export name. */
export const scansRoutes = createRouter();
