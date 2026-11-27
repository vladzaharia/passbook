import type { ReactNode } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { PATHS } from '../../../shared/developers.ts';
import { TOOL_PATH } from '../../developers/pages/toc.tsx';
import { Gate } from '../../developers/ui/gate.tsx';
import { Buddy, type BuddyScene } from '../../ui/art/buddy.tsx';
import { EnvelopeArt } from '../../ui/art/envelope.tsx';
import { KeyArt } from '../../ui/art/key.tsx';
import { LensArt } from '../../ui/art/lens.tsx';
import { LogArt } from '../../ui/art/log.tsx';
import { StubArt } from '../../ui/art/stub.tsx';
import { UnpluggedArt } from '../../ui/art/unplugged.tsx';
import type { WalletMood } from '../../ui/art/wallet.tsx';
import type { BenchTool } from './switcher.tsx';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/inspect.css';
import '../../ui/art/scenes/listen.css';
import '../../ui/art/scenes/nudge.css';
import '../../ui/art/scenes/plug.css';
import '../../ui/art/scenes/rest.css';
import '../../ui/art/scenes/search.css';
import '../../ui/art/scenes/tuck.css';
import '../../ui/art/scenes/wave.css';
import '../../developers/ui/state-card.css';
import './state.css';

/** Every empty, idle and failed moment of the bench (design §3.8). One buddy per view, on the card's edge. */
export type BenchScene =
  | 'no-sandbox'
  | 'closed'
  | 'console-idle'
  | 'webhooks-idle'
  | 'logs-idle'
  | 'logs-listen'
  | 'keys-none'
  | 'no-match'
  | 'failed';

const S = BENCH_COPY.state;
const SCENES: Record<
  BenchScene,
  { mood?: WalletMood; scene: BuddyScene; prop?: () => ReactNode; title: string }
> = {
  'no-sandbox': { mood: 'happy', scene: 'wave', title: S.noSandbox },
  closed: { mood: 'flat', scene: 'beat', title: S.closed },
  'console-idle': {
    mood: 'curious',
    scene: 'nudge',
    prop: () => <StubArt size="sm" />,
    title: S.consoleIdle,
  },
  'webhooks-idle': {
    mood: 'curious',
    scene: 'listen',
    prop: () => <EnvelopeArt size="sm" />,
    title: S.webhooksIdle,
  },
  'logs-idle': {
    mood: 'curious',
    scene: 'inspect',
    prop: () => <LogArt size="sm" />,
    title: S.logsIdle,
  },
  'logs-listen': {
    mood: 'curious',
    scene: 'listen',
    prop: () => <LogArt size="sm" />,
    title: S.logsIdle,
  },
  'keys-none': {
    mood: 'flat',
    scene: 'tuck',
    prop: () => <KeyArt size="sm" />,
    title: S.keysNone,
  },
  'no-match': {
    mood: 'curious',
    scene: 'search',
    prop: () => <LensArt size="sm" />,
    title: S.noMatch,
  },
  failed: { mood: 'sad', scene: 'plug', prop: () => <UnpluggedArt size="sm" />, title: S.failed },
};

/**
 * An empty, idle or failed bench: the buddy acting the moment out on the card's edge, a title and
 * the one action. `failed` with `onRetry` carries Retry and replays its scene on each try.
 * SSR-safe: a tool's prerendered placeholder can draw it.
 */
export function BenchState({
  scene,
  title,
  heading: Heading = 'h2',
  onRetry,
  replay,
  children,
}: {
  scene: BenchScene;
  /** Overrides the scene's own words. */
  title?: string;
  heading?: 'h2' | 'h3' | 'p';
  onRetry?: () => void;
  /** A change replays the scene. */
  replay?: number;
  /** The action: a button or link. */
  children?: ReactNode;
}) {
  const s = SCENES[scene];
  const words = title ?? s.title;
  return (
    <section
      className="card pstate bench-state"
      data-scene={scene}
      data-prop={s.prop ? '' : undefined}
      aria-label={words}
    >
      <Buddy mood={s.mood} size="sm" at="end" scene={s.scene} prop={s.prop?.()} replay={replay} />
      <Heading className="h2 pstate-t">{words}</Heading>
      {children || onRetry ? (
        <div className="pstate-a">
          {children}
          {onRetry ? (
            <button type="button" className="btn outline" onClick={onRetry}>
              {S.retry}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Each tool's docs from its signed-out card (as the pages link them today). */
const GATE_DOCS: Record<BenchTool, string | undefined> = {
  console: PATHS.reference,
  webhooks: `${PATHS.reference}/webhook-endpoints`,
  logs: PATHS.reference,
  keys: PATHS.guides,
};

/** Signed out, on any tool: BX2's gate with the tool's one line and its way back after sign-in. */
export function BenchGate({ tool }: { tool: BenchTool }) {
  return <Gate title={GATE_COPY.lines[tool]} next={TOOL_PATH[tool]} docs={GATE_DOCS[tool]} />;
}
