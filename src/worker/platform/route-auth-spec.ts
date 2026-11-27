import type { Context } from 'hono';
import type { z } from 'zod';
import type { ApiScopeSchema } from '../../shared/contracts/common.ts';
import type { OrgCapability } from '../../shared/contracts/org-membership.ts';
import type { SignInLevel } from '../../shared/sign-in.ts';
import type { PlatformScope, TenantScope } from './api-scopes.ts';
import type { AppBindings } from './context.ts';
import type { FeatureRule } from './feature-guard.ts';

type ApiScope = z.infer<typeof ApiScopeSchema>;

/**
 * Scopes that let a key in: one, any of several, or one for reads (GET, HEAD) and one for the rest. Never a platform
 * scope: a Platform key cannot meet a tenant rule, and the type proves no `scope` route lists one.
 */
export type ScopeRule =
  | TenantScope
  | readonly TenantScope[]
  | { read: TenantScope; write: TenantScope };

/**
 * Who may call a route. Declared once per route (`RouteSpec.auth`); `requireCaller` enforces it and
 * `openapi-security.ts` writes it into the document, so the two cannot disagree.
 */
/** A session must have signed in within `maxAgeSec`, else 403 STEP_UP_REQUIRED. Keys are never asked. */
export interface StepUp {
  maxAgeSec: number;
  /** Ask only the requests it accepts (it may read the body); omitted, every session request is asked. */
  when?: (c: Context<AppBindings>) => boolean | Promise<boolean>;
}

/**
 * `key.unless`: true refuses the request (403 PERSON_REQUIRED). It gets the raw JSON body, null when there is none or
 * it is malformed, and runs before validation, so a schema default has not filled anything in: write it as "refuse
 * unless provably safe" (`body?.dryRun !== true`), never "refuse if unsafe" (`body.dryRun === false`).
 */
export type UnlessRule = (
  c: Context<AppBindings>,
  body: Record<string, unknown> | null,
) => boolean | Promise<boolean>;

export type RouteAuth =
  /**
   * A bearer API key holding the scope, or else a tenant cookie session. `capability` is what the
   * handler must prove with tenantAuthorityOf for the org it acts on (a session's membership, a
   * key's scope): `register` turns a success response without that proof into a 500
   * AUTHORITY_UNPROVEN. `session: 'admin'` takes an admin session instead of any tenant session.
   */
  | {
      scope: ScopeRule;
      capability?: OrgCapability;
      session?: 'admin';
      feature?: FeatureRule;
      /** A `scans:write` key acts as a terminal here (`scanning.devices` governs it): skips `api`. */
      tillKey?: true;
      /**
       * The handler enforces a key's template and style limits: through grants (the builder adds them) and reads
       * (`authorityPredicate` with `tenantFilter`). Without this a limited key is refused (403 API_KEY_RESTRICTED_ROUTE).
       * Set it per route, never on a router guard, and only where every read and write goes through those two.
       */
      templateScoped?: true;
      stepUp?: StepUp;
      signIn?: never;
      platformKeys?: never;
    }
  /**
   * A key with the scope, or any session: one with no console access (an email link, or Polaris ID without the
   * console group) is an "own only" caller (`isOwnOnly`), and the handler must show it only what it started.
   * Never with a capability, an admin session, a step-up or a till key: those need the console's strength.
   */
  | {
      scope: ScopeRule;
      signIn: 'any';
      feature?: FeatureRule;
      capability?: never;
      session?: never;
      stepUp?: never;
      tillKey?: never;
      templateScoped?: never;
      /**
       * A Platform key (any platform scope) may call it, on reads only, and the handler shows it only the rows that key
       * started. Only the operations routes take it; the route inventory lists them.
       */
      platformKeys?: 'own';
    }
  /** A signed-in person: never a key. `requestMode` adopts the x-passbook-mode header; `feature` needs it. */
  | {
      human: true;
      requestMode?: boolean;
      feature?: FeatureRule;
      /**
       * Deny by default: a session needs a strong sign-in (Polaris ID), or an email link inside the console
       * grace. `any` admits an email link (holder features); `strict` takes no grace; `oidc` admits Polaris ID
       * only (no break-glass), `x-sign-in: oidc` in the document.
       */
      signIn?: 'any' | 'strict' | 'oidc';
      stepUp?: StepUp;
      /** Needs developer access (the `developer` role, or a platform admin): else 403 DEVELOPER_ACCESS_REQUIRED. */
      developer?: true;
    }
  /**
   * A platform admin session. `key` opts a Platform key in (one holding the scope, or `platform:read` for GET and
   * HEAD); omitted, the route is person-only (403 PERSON_REQUIRED). `key: { unless }` refuses the requests it accepts,
   * which need a person (offboard without `dryRun`). Keys are never asked for a step-up: the mint was it.
   * `signIn: 'oidc'` admits only a Polaris ID session: break-glass and email links get 403 IDP_SIGN_IN_REQUIRED, and
   * a step-up is a Polaris ID re-auth.
   */
  | {
      platform: PlatformScope;
      key?: true | { unless: UnlessRule };
      stepUp?: StepUp;
      signIn?: 'oidc';
    };

/** Reads (GET, HEAD) need `read`, everything else `write`. */
export function methodScope(scopes: { read: TenantScope; write: TenantScope }): ScopeRule {
  return scopes;
}

export const isRead = (c: Context) => c.req.method === 'GET' || c.req.method === 'HEAD';

/** The scope the key must hold, or null when none of several matches. Named scopes give a named refusal. */
export function neededScope(
  rule: ScopeRule,
  c: Context,
  held: readonly ApiScope[],
): TenantScope | null {
  if (typeof rule === 'string') return rule;
  if (Array.isArray(rule)) return rule.find((candidate) => held.includes(candidate)) ?? null;
  const split = rule as { read: TenantScope; write: TenantScope };
  return isRead(c) ? split.read : split.write;
}

/** Which kind of cookie session a route takes once no key decided it. */
export function sessionKindOf(auth: RouteAuth): 'plain' | 'tenant' | 'admin' {
  if ('platform' in auth) return 'admin';
  if ('human' in auth) return auth.requestMode ? 'tenant' : 'plain';
  return auth.session === 'admin' ? 'admin' : 'tenant';
}

/** The sign-in level a route asks of a session: `oidc` is `strict` plus the Polaris-only check (`requireCaller`). */
export const signInOf = (auth: RouteAuth): SignInLevel =>
  'human' in auth || 'scope' in auth
    ? auth.signIn === 'oidc'
      ? 'strict'
      : (auth.signIn ?? 'idp')
    : 'idp';
