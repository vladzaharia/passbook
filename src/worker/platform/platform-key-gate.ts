import type { Context } from 'hono';
import { tagPlatformScope } from './auth-capability.ts';
import type { ApiKeyAuth } from './auth-types.ts';
import type { KeyCaller } from './browser-signals.ts';
import type { AppBindings } from './context.ts';
import { noteKeyRefused, reportDenied } from './denied.ts';
import {
  ForbiddenError,
  PersonRequiredError,
  PlatformKeyRequiredError,
  UnauthenticatedError,
} from './errors.ts';
import { chargePlatformWrite } from './rate-limit.ts';
import { isRead, type RouteAuth, type UnlessRule } from './route-auth-spec.ts';

/** A Platform key: kind `platform` and no org. Both, so a bad row fails either way. */
export const isPlatformKey = (key: ApiKeyAuth): boolean =>
  key.keyKind === 'platform' && key.orgId === null;

/**
 * `key.unless`, given the raw JSON body (null when absent, malformed or not an object). Phrase it as "refuse unless
 * provably safe": a throw, or a body it cannot read, counts as needing a person.
 */
async function needsPerson(c: Context<AppBindings>, unless: UnlessRule): Promise<boolean> {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await c.req.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  try {
    return await unless(c, body);
  } catch {
    return true;
  }
}

/** A key that holds a platform scope may reach `platform` routes only: never a tenant route, whatever else it holds. */
export const holdsPlatformScope = (key: ApiKeyAuth): boolean =>
  key.scopes.some((scope) => scope.startsWith('platform:'));

type PlatformDecl = Extract<RouteAuth, { platform: unknown }>;

/**
 * A Bearer key on a `platform` route. In order: it resolves (401); it is a Platform key (403
 * PLATFORM_KEY_REQUIRED); the route opted keys in (403 PERSON_REQUIRED); it holds the route's scope, or
 * `platform:read` for a read (403 MISSING_SCOPE); `key.unless` does not refuse the request (403 PERSON_REQUIRED); a
 * write is within the key's `RL_PLATFORM_WRITE` budget (429).
 * Each refusal after the first is audited as the key. No cookie is consulted and no step-up asked: the mint was it.
 */
export async function platformKeyGate(
  c: Context<AppBindings>,
  decl: PlatformDecl,
  token: string,
  caller: KeyCaller,
): Promise<ApiKeyAuth> {
  const key = await c.var.stores.apiKeys.resolve(token, caller);
  if (!key) {
    noteKeyRefused(c, { code: 'INVALID_API_KEY', token });
    throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
  }
  const refuse = (
    code: 'PLATFORM_KEY_REQUIRED' | 'PERSON_REQUIRED' | 'MISSING_SCOPE',
    scope: string | null,
  ) => {
    reportDenied(c, code, key);
    noteKeyRefused(c, { code, keyId: key.keyId, scope });
  };
  if (!isPlatformKey(key)) {
    refuse('PLATFORM_KEY_REQUIRED', null);
    throw new PlatformKeyRequiredError();
  }
  if (!decl.key) {
    refuse('PERSON_REQUIRED', decl.platform);
    throw new PersonRequiredError();
  }
  const needed =
    isRead(c) && key.scopes.includes('platform:read') ? 'platform:read' : decl.platform;
  if (!key.scopes.includes(needed)) {
    refuse('MISSING_SCOPE', needed);
    throw new ForbiddenError(`The API key lacks the ${needed} scope.`, 'MISSING_SCOPE');
  }
  if (decl.key !== true && (await needsPerson(c, decl.key.unless))) {
    refuse('PERSON_REQUIRED', decl.platform);
    throw new PersonRequiredError();
  }
  if (!isRead(c))
    await chargePlatformWrite(c.env, key.keyId).catch((error: unknown) => {
      // The 429 the caller sees is unchanged; the owner's audit names the key.
      reportDenied(c, 'RATE_LIMITED', key);
      throw error;
    });
  const scoped = { ...key };
  tagPlatformScope(scoped, needed);
  c.set('auth', scoped);
  return scoped;
}
