import type { TenantPassWrite } from '../passes/http.ts';
import type { ScanActor } from './actor.ts';

/** The console session's tenant authority and the actor its read fence is built from. */
export type EventAuthority = TenantPassWrite & { actor: ScanActor };
