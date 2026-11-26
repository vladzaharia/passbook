import type { WbTool } from '../workbench.ts';

/**
 * The Workbench's one copy table for shared states (design §6): access, flags, context, the
 * sandbox lifecycle and each tool's empty line. `NoAccessState`, `EmptyState surface="stage"` and
 * `ErrorState` draw them.
 */
export const WB_STATES = {
  signedOut: {
    title: 'Sign in to use the Workbench',
    action: 'Sign in with Polaris ID',
  },
  noAccess: {
    title: 'No Workbench access',
    description: 'It needs the developer role, or admin access to an organization.',
    action: 'Request access',
  },
  notAllowed: {
    title: (org: string) => `Not available in ${org}'s Test mode`,
    nearest: (area: string) => `Go to ${area}`,
    admin: 'Open in admin',
  },
  notFound: {
    title: 'Not in your Workbench',
    description: 'The sandbox or organization is not one you can open.',
    action: 'Go to the Workbench',
  },
  chooser: { title: 'Choose a context' },
  stepUp: { title: "Confirm it's you", action: 'Continue' },
  sessionExpired: { title: 'Your session ended', action: 'Sign in again' },
  bodiesOff: { title: 'Bodies off for this org', admin: 'Turn on in admin' },
  live: { title: 'This is Live', action: 'Open in admin' },
  noSandbox: { title: 'No sandbox yet', action: 'Create sandbox' },
  sandboxClosed: { title: 'Sandbox closed', reopen: 'Reopen', create: 'Create new' },
  resetting: 'Resetting',
  failed: {
    network: 'Could not reach PassBook. Check your connection.',
    access: 'You do not have access to this.',
    server: 'PassBook could not answer. Try again.',
    noContext: 'Choose a sandbox or organization first.',
    stale: 'Could not refresh your contexts.',
  },
} as const;

/** Each tool's empty line and its action (design §6). Loading and no-match are shared. */
export const WB_EMPTY: Partial<Record<WbTool, { title: string; action?: string }>> = {
  logs: { title: 'Waiting for your first call', action: 'Run in Console' },
  events: { title: 'Listening for events', action: 'Add endpoint' },
  inbox: { title: 'No test emails', action: 'Send one to me' },
  passes: { title: 'No passes', action: 'Make one in Design' },
  activity: { title: 'Nothing running' },
  keys: { title: 'No keys', action: 'New key' },
  design: { title: 'No templates', action: 'Start from a blueprint' },
};
