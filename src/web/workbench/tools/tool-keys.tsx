import { useEffect, useState } from 'react';
import type { DeveloperHome } from '@/shared/contracts/developer-home.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchState } from '../bench/state.tsx';
import { fetchHome } from '../home/api.ts';
import { KeysPage } from '../keys/keys-page.tsx';
import { ToolFailed } from '../states/states.tsx';
import { LegacyTool } from './legacy.tsx';
import '../keys/keys.css';
import '../../developers/ui/sheet.css';

function Body({ csrf }: { csrf: string }) {
  const [home, setHome] = useState<DeveloperHome | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry button's re-read.
  useEffect(() => {
    fetchHome().then(setHome, () => setHome('failed'));
  }, [attempt]);
  if (home === null) return <BenchSkeleton rows={6} />;
  if (home === 'failed')
    return <ToolFailed error={new Error('keys')} onRetry={() => setAttempt((n) => n + 1)} />;
  if (home.state === 'none') return <BenchState scene="no-sandbox" />;
  return <KeysPage initial={home} csrf={csrf} />;
}

/** Keys (T4 replaces it with the shared keys components): the moved bench tool. */
export function KeysToolPage() {
  return (
    <LegacyTool tool="keys" className="wb-tool-keys">
      {({ csrf }) => <Body csrf={csrf} />}
    </LegacyTool>
  );
}
