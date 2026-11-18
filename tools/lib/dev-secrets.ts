/**
 * Wrangler, when wrangler.jsonc has `secrets`, hands a local run (vite dev, preview) only the `.dev.vars`
 * entries that `secrets.required` lists. `KEK_V1` is not required in production (it can be retired once
 * `MAC_ROOT_V1` and the rewrap are in place, docs/operations.md, KEK rotation), so local runs name it here.
 * Production builds do not use this: the deployed config is the file's.
 */
export const LOCAL_SECRETS = ['KEK_V1'] as const;

/**
 * `npm run dev:vars` writes the fixture WWDR as `SIGNER_PLATFORM_INTERMEDIATE`; without it here the worker
 * falls back to Apple's G4 and rejects the fixture leaf. The e2e build declares it as a var instead.
 */
export const DEV_ONLY_SECRETS = ['SIGNER_PLATFORM_INTERMEDIATE'] as const;

export function localSecrets(e2e = false): { secrets: { required: string[] } } {
  return { secrets: { required: [...LOCAL_SECRETS, ...(e2e ? [] : DEV_ONLY_SECRETS)] } };
}
