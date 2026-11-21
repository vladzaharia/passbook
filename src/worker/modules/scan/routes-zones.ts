import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, guard } from '../../platform/openapi.ts';
import { requireTenantSession } from '../passes/http.ts';
import { registerConsoleInsideRoutes } from './routes-occupancy-console.ts';
import { registerZoneRoutes } from './routes-zones-key.ts';

/** Console zones: /api/v1/scan-zones. Zones are org data, shared by both modes. */
export const scanZonesRoutes = createRouter();
/** List, create, edit, archive and restore take a console session or a key, so they register before the session guard. */
registerZoneRoutes(scanZonesRoutes);
guard(scanZonesRoutes, requireTenantSession);
scanZonesRoutes.use('*', limitBody(16 * 1024));

const TAG = 'scan-zones';
registerConsoleInsideRoutes(scanZonesRoutes, TAG, 'zone');
