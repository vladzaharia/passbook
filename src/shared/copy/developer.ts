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
export const SANDBOX_HUMAN_ONLY_COPY = 'Sign in to make a sandbox.';
export const SANDBOX_CHECK_COPY = 'Check failed. Reload and try again.';
export const SANDBOX_TEMPLATE_NAME = 'Quickstart ticket';
export const SANDBOX_KEY_NAME = 'Sandbox key';
/** The path a sandbox pass links to; the token is the pass's capability. PX9 renders it. */
export const TEST_PREVIEW_PATH = '/developers/preview/';
