export const MANAGED_PREFIX = 'pass.mobile.passbook.';
export const HANDLE_PATTERN = /^[a-z][a-z0-9]{1,29}$/;
/** Room for a numeric suffix inside the 30 character limit. */
const BASE_MAX = 27;

/** The default handle of an org slug: lowercase letters and digits only, starting with a letter. */
export function handleBase(slug: string): string {
  let base = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z]/.test(base)) base = `org${base}`;
  base = base.slice(0, BASE_MAX);
  return base.length < 2 ? `${base}org` : base;
}
