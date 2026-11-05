import type { Mode } from '@/shared/contracts/common.ts';
import { useMode } from '../../lib/mode.ts';

/** True for a pass of the other mode: the server does not check, so every control must. */
export function usePassForeign(pass: { mode?: Mode }): boolean {
  const mode = useMode();
  return pass.mode !== undefined && pass.mode !== mode;
}
