import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { disableZodCompiling } from '../../developers/model/jitless.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { signedOutGate } from '../console/session.ts';
import { applyGate } from '../quickstart/gate.ts';
import { QuickstartView } from '../quickstart/page.tsx';
import { Quickstart } from '../quickstart/quickstart.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
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
import '../quickstart/quickstart-wb.css';

/** Signed out: the five steps with the first to do; a session that does not open Developers gets its own words. */
function SignedOut() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (host.current) applyGate(host.current, signedOutGate());
  }, []);
  return (
    <div ref={host}>
      <QuickstartView />
    </div>
  );
}

/** Quickstart: the sandbox's guided run on the Workbench token, public at step 1 (design §1.11). */
export function QuickstartPage() {
  const session = useLegacySession();
  const queries = useQueryClient();
  const onContexts = useCallback(
    () => void queries.invalidateQueries({ queryKey: ['workbench', 'contexts'] }),
    [queries],
  );
  useBenchRouter();
  let body = <BenchSkeleton rows={5} />;
  if (session?.kind === 'out') body = <SignedOut />;
  else if (session) {
    disableZodCompiling();
    body = <Quickstart session={session} onContexts={onContexts} />;
  }
  return (
    <ToolPage tool="quickstart">
      <div className="wb-legacy wb-tool-quickstart">{body}</div>
    </ToolPage>
  );
}
