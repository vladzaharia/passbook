import { createRoot } from 'react-dom/client';
import '../../pass-card/barcode-loader.ts';
import '../../../generated/playground-kit.css';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/wave.css';
import '../../ui/art/scenes/tear.css';
import '../playground/playground.css';
import './quickstart.css';
import './quickstart-stage.css';
import { loadSession } from '../console/session.ts';
import { disableZodCompiling } from '../playground/jitless.ts';
import type { Island } from '../shell/islands.ts';

/**
 * The `quickstart` island. Signed out, the prerendered page stays as it is and nothing loads. Signed in, the
 * placeholder holds the whole page: the steps on the left, "Your pass, live" on the right.
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  if (session.kind === 'out') return;
  disableZodCompiling();
  const { Quickstart } = await import('./quickstart.tsx');
  createRoot(el).render(<Quickstart session={session} />);
};
