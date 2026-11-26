import { useEffect, useState } from 'react';
import { PATHS } from '@/shared/developers.ts';
import { disableZodCompiling } from '../../developers/model/jitless.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import type { BlueprintPreviews } from '../playground/model.ts';
import { Playground } from '../playground/playground.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { ToolFailed } from '../states/states.tsx';
import '../../pass-card/barcode-loader.ts';
import '../styles/legacy.css';
import '../styles/legacy-kit.css';
import '../playground/playground-inputs.css';
import '../playground/playground-notes.css';
import '../playground/playground.css';

/** The one request the anonymous page makes: a static file built at deploy. */
async function loadPreviews(): Promise<BlueprintPreviews> {
  const res = await fetch(PATHS.previews, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('The blueprint previews did not load.');
  return (await res.json()) as BlueprintPreviews;
}

/** Design for a signed-out visitor (DC3 replaces its editor): the Playground on the blueprint previews. */
export function PlaygroundPage() {
  const [data, setData] = useState<BlueprintPreviews | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry button's re-read.
  useEffect(() => {
    // Zod must not compile its parsers here (Trusted Types); the page's schemas are built after this.
    disableZodCompiling();
    loadPreviews().then(setData, () => setData('failed'));
  }, [attempt]);
  let body = <BenchSkeleton rows={6} />;
  if (data === 'failed')
    body = <ToolFailed error={new Error('previews')} onRetry={() => setAttempt((n) => n + 1)} />;
  else if (data) body = <Playground data={data} />;
  return (
    <ToolPage tool="design">
      <div className="wb-legacy pg wb-tool-playground">{body}</div>
    </ToolPage>
  );
}
