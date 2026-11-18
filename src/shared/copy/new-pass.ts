/** The first-pass dead end: nothing is approved, so nothing can be issued. Names who and where. */
export const NO_RELEASE_COPY = {
  org: 'No template is approved yet. A reviewer has to approve one before you can issue a pass. Open Templates and request a review.',
  template:
    'This template is not approved yet. A reviewer has to approve it before you can issue a pass.',
  action: 'Open Templates',
} as const;
