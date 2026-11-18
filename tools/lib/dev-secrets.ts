/**
 * Wrangler, when wrangler.jsonc has `secrets`, hands a local run (vite dev, preview) only the `.dev.vars`
 * entries that `secrets.required` lists. `KEK_V1` is not required in production (it can be retired once
 * `MAC_ROOT_V1` and the rewrap are in place, docs/operations.md, KEK rotation), so local runs name it here.
 * Production builds do not use this: the deployed config is the file's.
 */
export const LOCAL_SECRETS = ['KEK_V1'] as const;

export function localSecrets(): { secrets: { required: string[] } } {
  return { secrets: { required: [...LOCAL_SECRETS] } };
}
