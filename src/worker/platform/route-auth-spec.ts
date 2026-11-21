import type { z } from 'zod';
import type { ApiScopeSchema } from '../../shared/contracts/common.ts';
import type { OrgCapability } from '../../shared/contracts/org-membership.ts';
import type { PlatformScope } from './api-scopes.ts';
import type { FeatureRule } from './feature-guard.ts';

type ApiScope = z.infer<typeof ApiScopeSchema>;

/** Scopes that let a key in: one, any of several, or one for reads (GET, HEAD) and one for the rest. */
export type ScopeRule = ApiScope | readonly ApiScope[] | { read: ApiScope; write: ApiScope };

/**
 * Who may call a route. Declared once per route (`RouteSpec.auth`); `requireCaller` enforces it and
 * `openapi-security.ts` writes it into the document, so the two cannot disagree.
 */
/** A session must have signed in within `maxAgeSec`, else 403 STEP_UP_REQUIRED. Keys are never asked. */
export interface StepUp {
  maxAgeSec: number;
}

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
    }
  /** A signed-in person: never a key. `requestMode` adopts the x-passbook-mode header; `feature` needs it. */
  | {
      human: true;
      requestMode?: boolean;
      feature?: FeatureRule;
      /**
       * Deny by default: a session needs a strong sign-in (Polaris ID), or an email link inside the console
       * grace. `any` admits an email link (holder features); `strict` takes no grace.
       */
      signIn?: 'any' | 'strict';
      stepUp?: StepUp;
    }
  /** A platform admin session. Keys never pass until a platform key kind exists. */
  | { platform: PlatformScope; stepUp?: StepUp };
