/**
 * The playground's two copy buttons say "Copied" in place, and the portal has no toaster, so they
 * write the clipboard here instead of through lib/clipboard.ts (which toasts). Resolves to whether
 * it worked; a refusal (permission, insecure context) leaves the button as it was.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
