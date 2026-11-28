import { createFileRoute, redirect } from '@tanstack/react-router';
import { CliApprovePage } from '../../workbench/cli/cli-approve.tsx';

/**
 * CLI sign-in's approve page (design §3.7). The code is typed, never prefilled: a query or hash on the address is
 * dropped before anything renders, so a link cannot carry or fill a code.
 */
export const Route = createFileRoute('/workbench/cli')({
  beforeLoad: ({ location }) => {
    if (location.searchStr || location.hash)
      throw redirect({ to: '/workbench/cli', replace: true });
  },
  component: CliApprovePage,
});
