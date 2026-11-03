import { stripSearchParams } from '@tanstack/react-router';
import { z } from 'zod';

// Route configs load with the entry chunk; keep this module free of UI and nav imports.

/** `?orgId=`, the org scope: validated on the admin route, so every admin route types it. */
export const orgScopeSearchSchema = z.object({
  orgId: z.string().min(1).max(100).optional().catch(undefined),
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
