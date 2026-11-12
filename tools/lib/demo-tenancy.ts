// The demo owner: signs in once, then tools/bootstrap-tenancy.ts gives them org_admin in every
// org and pins uploaded templates to a legacy release, which the tenancy model requires before
// passes can be issued. Local D1 only; bootstrap-tenancy refuses --remote.
import { emailOf } from './demo-data.ts';

export const DEMO_OWNER = emailOf('Demo Owner');

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
