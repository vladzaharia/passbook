// The demo owner signs in through the e2e server's mock OIDC (test/mock-oidc/server.ts), then
// tools/bootstrap-tenancy.ts gives them org_admin in every org and pins uploaded templates to a
// legacy release, which the tenancy model requires before passes can be issued. Local D1 only;
// bootstrap-tenancy refuses --remote.
export const DEMO_OWNER = 'admin@example.test';
export const DEMO_OWNER_SUB = 'e2e-admin';
/** A second reviewer: another person's approval is the normal path to a release. */
export const DEMO_REVIEWER = 'reviewer@example.test';
export const DEMO_REVIEWER_SUB = 'e2e-reviewer';
/** The e2e server's database (tools/e2e-server.ts); the demo data lives there. */
export const E2E_STATE = '.wrangler/e2e-state';

/** The command that applies memberships and legacy releases to the local D1. */
export function tenancyCommand(
  owner: string,
  persistTo?: string,
): { file: string; args: string[] } {
  return {
    file: 'node',
    args: [
      'tools/bootstrap-tenancy.ts',
      '--owner',
      owner,
      ...(persistTo ? ['--persist-to', persistTo] : []),
      '--apply',
    ],
  };
}
