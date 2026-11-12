import { stripSearchParams } from '@tanstack/react-router';
import { z } from 'zod';

// Route configs load with the entry chunk; keep this module free of UI and nav imports.

/** `?orgId=`, the org scope: validated on the admin route, so every admin route types it. */
const INVALID_ORG_SCOPE = '__invalid_org_scope__';
const scalarToString = (value: unknown) =>
  typeof value === 'number' || typeof value === 'boolean' || value === null ? String(value) : value;

export const orgScopeSearchSchema = z.object({
  /**
   * A platform display filter (overview, audit log). Unlike `orgId` it grants nothing, so the
   * admin route does not retain it and tenant pages ignore it. Declared here so the router keeps
   * it in the location; the pages read the raw value.
   */
  filterOrgId: z.preprocess(scalarToString, z.string().min(1).max(100)).optional().catch(undefined),
  // Keep invalid explicit values present so the scope guard cannot mistake them for no choice.
  orgId: z
    .preprocess(
      scalarToString,
      z
        .string()
        .min(1)
        .max(100)
        .refine((value) => value !== INVALID_ORG_SCOPE),
    )
    .optional()
    .catch(INVALID_ORG_SCOPE),
});

/** Routes the scope does not apply to (nav.ts orgScoped: false) drop `orgId` from their URL. */
export const UNSCOPED_SEARCH = {
  middlewares: [stripSearchParams<{ orgId?: string | undefined }>(['orgId'])],
};

/**
 * Both Account routes: ?add=email (from the empty My passes) focuses the add-email row;
 * ?verified=<email> (the add-email link) toasts "Email added" and leaves the URL.
 */
export const accountSearchSchema = z.object({
  add: z.enum(['email']).optional().catch(undefined),
  verified: z.string().max(254).optional().catch(undefined),
});
