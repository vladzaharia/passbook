/** Developer sandbox copy: the refusals and the page names a sandbox shows. */
export const SANDBOX_PREVIEW_ONLY_COPY =
  'Sandbox passes are previews and are never added to a wallet. Use a live organization for real passes.';

/** `{feature}` is an ENTITLEMENT_LABEL; `{used}` and `{limit}` the count and the cap. */
export const SANDBOX_QUOTA_COPY =
  '{feature}: sandbox limit reached ({used} of {limit}). Delete one to make room.';

export const sandboxQuota = (feature: string, used: number, limit: number): string =>
  SANDBOX_QUOTA_COPY.replace('{feature}', feature)
    .replace('{used}', String(used))
    .replace('{limit}', String(limit));

export const SANDBOX_EXISTS_COPY = 'You already have a sandbox.';
export const SANDBOX_KEY_SHOWN_COPY = 'Your key was shown once. Roll it to get a new one.';
export const SANDBOX_HUMAN_ONLY_COPY = 'Sign in to make a sandbox.';
export const SANDBOX_CHECK_COPY = 'Check failed. Reload and try again.';
export const SANDBOX_TEMPLATE_NAME = 'Quickstart ticket';
export const SANDBOX_KEY_NAME = 'Sandbox key';
/** The one terminal a sandbox has: its key scans as it with no pairing and no `scans:write` (Test only). */
export const SANDBOX_TERMINAL_NAME = 'Sandbox terminal';
/** What a sandbox key sends in `x-passbook-device` to name it: no id to look up. */
export const SANDBOX_TERMINAL_ALIAS = 'sandbox';
export const SANDBOX_KEY_MISSING_COPY =
  'Your sandbox has no usable key. Roll or make one, then try again.';
/** The path of a sandbox pass's TEST preview page; the segment after it is a MAC'd link (PX9). */
export const TEST_PREVIEW_PATH = '/preview/';

/** The band on every channel of a sandbox pass: text, not colour alone. */
export const TEST_BAND_COPY = 'TEST PREVIEW · NOT INSTALLABLE';

export const PREVIEW_PAGE_COPY = {
  title: 'Test preview',
  lede: 'A sandbox pass as each wallet shows it. It cannot be added to a wallet.',
  tag: 'Test only',
  tabs: 'Channel',
  noPaper: 'This template has no printed ticket.',
  open: 'Open PassBook',
  expiredTitle: 'Preview link expired',
  expired: 'This link is older than 30 days. Open the pass in PassBook to copy a new one.',
  missingTitle: 'Preview not found',
  missing: 'This link is not valid. Open the pass in PassBook to copy it again.',
} as const;

/** The identity a preview-only pass validates against. It names no certificate and signs nothing. */
export const PREVIEW_PASS_IDENTITY = {
  passTypeIdentifier: 'pass.test.preview',
  teamIdentifier: 'TESTPREVIE',
} as const;
