import { useLocation } from '@tanstack/react-router';
import { disableZodCompiling } from '../../developers/model/jitless.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { Quickstart } from '../quickstart/quickstart.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { SignInState } from '../states/states.tsx';
import { useBenchRouter, useLegacySession } from './legacy.tsx';
import '../../pass-card/barcode-loader.ts';
import '../styles/legacy.css';
import '../styles/legacy-kit.css';
import '../../developers/styles/dev-quickstart.css';
import '../../developers/styles/dev-quickstart-card.css';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/wave.css';
import '../../ui/art/scenes/tear.css';
import '../playground/playground.css';
import '../quickstart/quickstart.css';
import '../quickstart/quickstart-stage.css';
import '../quickstart/quickstart-v2.css';
import '../quickstart/quickstart-first-run.css';
import '../quickstart/quickstart-fit.css';

/** Quickstart (T8 rebuilds it): the moved five steps, signed in. Signed out, the one sign-in state. */
export function QuickstartPage() {
  const session = useLegacySession();
  const href = useLocation({ select: (l) => l.href });
  useBenchRouter();
  let body = <BenchSkeleton rows={5} />;
  if (session?.kind === 'out') body = <SignInState next={href} />;
  else if (session) {
    disableZodCompiling();
    body = <Quickstart session={session} />;
  }
  return (
    <ToolPage tool="quickstart">
      <div className="wb-legacy wb-tool-quickstart">{body}</div>
    </ToolPage>
  );
}
