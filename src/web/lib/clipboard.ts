import { toast } from '../ui/toaster.tsx';

/**
 * Copies from a menu item, where nothing on screen can show "Copied": a toast confirms it
 * ("Link copied"). `what` names the value in lower case ("link", "prefix"). Resolves to whether
 * the copy worked; a refusal (permission, insecure context) becomes an error toast.
 */
export async function copyText(value: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toast.error('Allow clipboard access and try again.', `Could not copy the ${what}`);
    return false;
  }
  toast.success(`${what.charAt(0).toUpperCase()}${what.slice(1)} copied`);
  return true;
}
