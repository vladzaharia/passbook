import type { Actor } from '../../platform/actor.ts';
import type { SessionAuth } from '../../platform/auth.ts';

/** A platform route's caller: the gate's `Actor` (a platform admin or a Platform key), or an admin session. */
export type WalletPlatformCaller = Actor | SessionAuth;

export const isActor = (by: WalletPlatformCaller): by is Actor => 'principal' in by;
