import { useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import type {
  DeveloperHome,
  DeveloperHomeSandbox,
} from '../../../shared/contracts/developer-home.ts';
import { BENCH_HOME_COPY as H } from '../../../shared/copy/developers-bench-home.ts';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import { PATHS } from '../../../shared/developers.ts';
import { envLine } from '../../../shared/developers-keys.ts';
import { RevealSheet } from '../../developers/ui/reveal-sheet.tsx';
import { Buddy } from '../../ui/art/buddy.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { Calls } from './calls.tsx';
import { GoLive, Keys, Passes, Webhooks } from './cards.tsx';
import type { Source } from './model.ts';
import { ReopenAction, ResetAction, type Reveal } from './sandbox-actions.tsx';
import { Stats } from './stats.tsx';
import { Track } from './track.tsx';

/** Where the workbench links. The shell may point them elsewhere (the Keys page lands with D7). */
export interface WorkbenchLinks {
  quickstart: string;
  sandbox: string;
  keys: string;
  logs: string;
  webhooks: string;
  /** Admin for the sandbox org (pinned to Test) or a Live org's API keys. */
  admin: (orgId: string, page?: 'api-keys') => string;
}

export const DEFAULT_LINKS: WorkbenchLinks = {
  quickstart: PATHS.quickstart,
  sandbox: `${PATHS.quickstart}#sandbox`,
  keys: PATHS.keys,
  logs: PATHS.logs,
  webhooks: PATHS.webhooks,
  admin: (orgId, page) => `/admin/o/${orgId}${page ? `/${page}` : ''}`,
};

export interface WorkbenchProps {
  home: DeveloperHome;
  loadCalls: (source: Source) => Promise<RequestLogEntry[]>;
  links?: WorkbenchLinks;
  /** The buddy waves on the first view of a visit, then sits still. */
  wave?: boolean;
  /** A reset or reopen changed the sandbox: read the home again. */
  onChanged?: () => void;
}

function Head({
  sandbox,
  now,
  links,
  wave,
  onChanged,
}: {
  sandbox: DeveloperHomeSandbox;
  now: number;
  links: WorkbenchLinks;
  wave: boolean;
  onChanged: () => void;
}) {
  const closed = sandbox.closedAt !== null;
  // Below the buttons: the reset confirm goes in `slot`. The new key is held here, so a refresh of the home keeps its
  // sheet; the sentence about what changed stays after the sheet is done.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const onKey = (next: Reveal) => {
    setReveal(next);
    setNote(next.line);
  };
  return (
    <header className="card wb-head">
      <Buddy
        size="sm"
        at="end"
        mood={closed ? 'sad' : 'happy'}
        scene={wave && !closed ? 'wave' : undefined}
        still={!wave || closed}
      />
      <div className="stack g1 wb-head-main">
        <span className="eyebrow">Sandbox</span>
        <h2 className="h1 wb-name">{sandbox.name}</h2>
        <span className="wrap-row g2">
          <StatusChip tone="info">{H.testOnly}</StatusChip>
          <StatusChip tone="neutral">{H.previewsOnly}</StatusChip>
          {closed ? <StatusChip tone="neutral">{H.closed}</StatusChip> : null}
        </span>
      </div>
      <div className="wrap-row g2 wb-head-actions">
        {closed ? (
          <ReopenAction sandbox={sandbox} onChanged={onChanged} onKey={onKey} />
        ) : (
          <>
            <a className="btn sm" href={`${links.keys}#new`}>
              New key
            </a>
            <ResetAction onChanged={onChanged} onKey={onKey} panel={slot} />
          </>
        )}
        <a className="btn sm outline" href={links.admin(sandbox.orgId)}>
          Open in Admin
        </a>
      </div>
      {closed ? (
        <p className="sm muted wb-closed" data-testid="wb-closed">
          {H.closedLine.ago} <BenchTime at={sandbox.closedAt ?? now} now={now} mode="ago" />.{' '}
          {sandbox.reopenUntil !== null ? (
            <>
              {H.closedLine.reopen} <BenchTime at={sandbox.reopenUntil} now={now} mode="until" />.
            </>
          ) : (
            H.closedLine.gone
          )}
        </p>
      ) : null}
      <div ref={setSlot} className="wb-act-slot" />
      {note ? (
        <p className="sm muted wb-closed" role="status">
          {note}
        </p>
      ) : null}
      {reveal && !reveal.shown ? (
        <RevealSheet
          revealed={{ name: H.newKeyTitle, secret: reveal.secret }}
          labels={KEYS_COPY.reveal}
          prefix="PASSBOOK_KEY="
          copyAs={envLine}
          onDone={() => setReveal(null)}
          onHide={() => setReveal((r) => (r ? { ...r, secret: null } : r))}
        />
      ) : null}
    </header>
  );
}

/** No sandbox yet: one way in, and where Live keys come from. */
function NoSandbox({ home, links }: { home: DeveloperHome; links: WorkbenchLinks }) {
  return (
    <div className="wb">
      <section className="card wb-head wb-empty">
        <Buddy size="sm" at="end" scene="wave" />
        <div className="stack g1 wb-head-main">
          <span className="eyebrow">Sandbox</span>
          <h2 className="h2">No sandbox yet</h2>
        </div>
        <a className="btn" href={links.sandbox}>
          Create sandbox
        </a>
      </section>
      <GoLive orgs={home.liveOrgs} admin={(id) => links.admin(id, 'api-keys')} />
    </div>
  );
}

/** The signed-in developer's home (`GET /developer/home`). Every number and row comes from the server. */
export function Workbench({
  home,
  loadCalls,
  links = DEFAULT_LINKS,
  wave = false,
  onChanged = () => undefined,
}: WorkbenchProps) {
  if (!home.sandbox || !home.progress || !home.usage)
    return <NoSandbox home={home} links={links} />;
  const { sandbox, progress, usage, now } = home;
  return (
    <div className="wb" data-state={home.state}>
      <Head sandbox={sandbox} now={now} links={links} wave={wave} onChanged={onChanged} />
      {home.state === 'open' ? <Track progress={progress} quickstart={links.quickstart} /> : null}
      <Stats
        usage={usage}
        passLimit={sandbox.limits.passes}
        logs={links.logs}
        webhooks={links.webhooks}
      />
      <div className="wb-grid">
        <Calls calls={home.calls} now={now} logs={links.logs} load={loadCalls} />
        <Keys keys={home.keys} now={now} href={links.keys} closed={home.state === 'closed'} />
        <Passes passes={home.passes} />
        <Webhooks endpoints={home.endpoints} now={now} href={links.webhooks} />
        <GoLive orgs={home.liveOrgs} admin={(id) => links.admin(id, 'api-keys')} />
      </div>
    </div>
  );
}
