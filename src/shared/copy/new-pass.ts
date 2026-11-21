/** The first-pass dead end: nothing is approved, so nothing can be issued. Names who and where. */
export const NO_RELEASE_COPY = {
  org: 'No template is released yet. Approve and publish one in Templates before you issue a pass.',
  template:
    'This template has no released version. Approve and publish one before you issue a pass.',
  action: 'Open Templates',
} as const;
