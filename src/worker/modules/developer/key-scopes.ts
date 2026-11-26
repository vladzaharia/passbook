import { SANDBOX_KEY_SCOPES } from '../../../shared/contracts/developer-home.ts';
import { isPlatformScope } from '../../platform/api-scopes.ts';

/** A key a sandbox holds can reach everything a test org can, except minting keys, the terminal scope and the live-only scanning setup scope. */
export const KEY_SCOPES = SANDBOX_KEY_SCOPES.filter((s) => !isPlatformScope(s));

/**
 * What a key must hold for a try token to be made from it: the sandbox key's own scopes (the New key sheet's "Full
 * sandbox" preset leaves out `audit:read`, so that is not asked). A narrower key never lends its scopes to the Workbench,
 * and the token never has more than a key the person already holds.
 */
export const TRY_REQUIRED_SCOPES = KEY_SCOPES.filter((s) => s !== 'audit:read');
