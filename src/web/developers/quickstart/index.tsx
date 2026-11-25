import { createRoot } from 'react-dom/client';
import '../../pass-card/barcode-loader.ts';
import '../../../generated/playground-kit.css';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/wave.css';
import '../../ui/art/scenes/tear.css';
import '../playground/playground.css';
import './quickstart.css';
import './quickstart-stage.css';
import './quickstart-v2.css';
import './quickstart-first-run.css';
import { loadSession, signedOutGate } from '../console/session.ts';
import { disableZodCompiling } from '../playground/jitless.ts';
import type { Island } from '../shell/islands.ts';
import { applyGate } from './gate.ts';

/**
 * The `quickstart` island. Signed out, the prerendered page stays as it is (step 1 swaps its words for an email or no-access session) and nothing else loads. Signed in, the
 * placeholder holds the whole page: the steps on the left, "Your pass, live" on the right.
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  if (session.kind === 'out') return applyGate(el, signedOutGate());
  disableZodCompiling();
  const { Quickstart } = await import('./quickstart.tsx');
  createRoot(el).render(<Quickstart session={session} />);
};
