const KEY = 'passbook.console.cheered';
let seen = false;

/** True once per session, on the first 2xx. Storage that is blocked falls back to this page's own memory. */
export function cheersFor(status: number): boolean {
  if (status < 200 || status >= 300) return false;
  try {
    if (sessionStorage.getItem(KEY)) return false;
    sessionStorage.setItem(KEY, '1');
    return true;
  } catch {
    // Blocked storage (a private window): once per page load instead.
    if (seen) return false;
    seen = true;
    return true;
  }
}

export const resetCheer = (): void => {
  seen = false;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored to clear.
  }
};
